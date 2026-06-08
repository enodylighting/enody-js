/**
 * ESP32 ROM Bootloader Flasher — Vanilla JS implementation.
 *
 * Minimal, readable implementation of the ESP ROM bootloader serial protocol
 * for flashing firmware to ESP32-C6 devices in Secure Download Mode (SDM).
 *
 * This replaces the minified esptool-bundle.js with a focused, self-contained
 * module that supports only the operations needed for EP01 firmware updates:
 *
 *   - SLIP framing (Serial Line Internet Protocol)
 *   - ROM bootloader sync & chip detection
 *   - Secure Download Mode detection via GET_SECURITY_INFO
 *   - SPI flash attach & parameter configuration
 *   - Uncompressed flash writes (compressed writes are blocked in SDM)
 *   - USB JTAG reset sequence (for ESP32-C6 USB serial)
 *
 * Protocol reference: Espressif ESP32 Technical Reference Manual, Chapter 2
 * (ROM Bootloader Protocol). See also: esptool.py and esptool-js.
 */

// ─── SLIP Protocol ──────────────────────────────────────────────────────────
//
// SLIP (RFC 1055) is used to frame packets over the serial link.
// Each packet is delimited by 0xC0 bytes. Within a packet:
//   - 0xC0 is escaped as [0xDB, 0xDC]
//   - 0xDB is escaped as [0xDB, 0xDD]

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

function slipEncode(data) {
  const out = [SLIP_END];
  for (const byte of data) {
    if (byte === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END);
    else if (byte === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC);
    else out.push(byte);
  }
  out.push(SLIP_END);
  return new Uint8Array(out);
}

function slipDecode(frame) {
  const out = [];
  let esc = false;
  for (const byte of frame) {
    if (esc) {
      if (byte === SLIP_ESC_END) out.push(SLIP_END);
      else if (byte === SLIP_ESC_ESC) out.push(SLIP_ESC);
      else out.push(byte); // malformed, pass through
      esc = false;
    } else if (byte === SLIP_ESC) {
      esc = true;
    } else if (byte !== SLIP_END) {
      out.push(byte);
    }
  }
  return new Uint8Array(out);
}

// ─── ROM Bootloader Command Opcodes ─────────────────────────────────────────

const CMD = {
  FLASH_BEGIN:       0x02,
  FLASH_DATA:        0x03,
  FLASH_END:         0x04,
  SYNC:              0x08,
  SPI_SET_PARAMS:    0x0b,
  SPI_ATTACH:        0x0d,
  CHANGE_BAUDRATE:   0x0f,
  GET_SECURITY_INFO: 0x14,
};

const CMD_NAMES = Object.fromEntries(
  Object.entries(CMD).map(([name, value]) => [value, name]),
);

// ─── Constants ──────────────────────────────────────────────────────────────

const CHECKSUM_MAGIC = 0xef;
const DEFAULT_TIMEOUT = 3000;        // 3 seconds
const SYNC_TIMEOUT = 100;            // 100ms per sync attempt
const FLASH_WRITE_SIZE = 0x400;      // 1KB blocks (ROM bootloader, no stub)
const ERASE_WRITE_TIMEOUT_PER_MB = 40000;

// ESP32-C6 chip ID as returned by GET_SECURITY_INFO
const CHIP_ID_ESP32_C6 = 13;

// Chip ID → name mapping (subset relevant for EP01)
const CHIP_NAMES = {
  0: 'ESP32', 2: 'ESP32-S2', 5: 'ESP32-C3', 9: 'ESP32-S3',
  12: 'ESP32-C2', 13: 'ESP32-C6', 16: 'ESP32-H2', 17: 'ESP32-C5',
  18: 'ESP32-P4', 20: 'ESP32-C61',
};

// ─── Utility: Little-endian byte packing ────────────────────────────────────

function packU16(value) {
  return [value & 0xff, (value >> 8) & 0xff];
}

function packU32(value) {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function unpackU32(data, offset = 0) {
  return (data[offset] | (data[offset + 1] << 8) |
          (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function checksum(data) {
  let cs = CHECKSUM_MAGIC;
  for (const byte of data) cs ^= byte;
  return cs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Serial Transport ───────────────────────────────────────────────────────
//
// Wraps WebSerial with a buffered reader that extracts SLIP frames.

class SerialTransport {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.buffer = new Uint8Array(0);
    this._readLoopRunning = false;
  }

  async open(baudrate = 115200) {
    await this.port.open({ baudRate: baudrate, dataBits: 8, parity: 'none', stopBits: 1 });
    this.writer = this.port.writable.getWriter();
    // Start a continuous background read loop (like esptool-js Transport.readLoop)
    this._startReadLoop();
  }

  async close() {
    this._readLoopRunning = false;
    try {
      if (this._bgReader) {
        await this._bgReader.cancel();
        this._bgReader.releaseLock();
      }
    } catch (e) {}
    try { if (this.writer) { this.writer.releaseLock(); } } catch (e) {}
    try { await this.port.close(); } catch (e) {}
    this._bgReader = null;
    this.writer = null;
    this.buffer = new Uint8Array(0);
  }

  /** Start background read loop that continuously buffers incoming serial data. */
  _startReadLoop() {
    this._readLoopRunning = true;
    this._bgReader = this.port.readable.getReader();
    const loop = async () => {
      try {
        while (this._readLoopRunning) {
          const { value, done } = await this._bgReader.read();
          if (done || !this._readLoopRunning) break;
          if (value && value.length > 0) {
            const merged = new Uint8Array(this.buffer.length + value.length);
            merged.set(this.buffer);
            merged.set(value, this.buffer.length);
            this.buffer = merged;
          }
        }
      } catch (e) {
        // Port closed or error — expected during disconnect
      }
    };
    loop(); // Fire and forget
  }

  async setSignals(signals) {
    await this.port.setSignals(signals);
  }

  /** Write raw bytes to serial. */
  async write(data) {
    await this.writer.write(data);
  }

  /** Send a SLIP-encoded packet. */
  async writeSlip(data) {
    await this.write(slipEncode(data));
  }

  /**
   * Read the next complete SLIP frame from the serial port.
   * The background read loop continuously fills this.buffer;
   * we just poll it until a complete frame appears or timeout.
   */
  async readSlip(timeout = DEFAULT_TIMEOUT) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const frame = this._extractFrame();
      if (frame) return slipDecode(frame);
      // Yield to let the background read loop fill the buffer
      await sleep(1);
    }

    throw new Error('Read timeout');
  }

  /** Extract one complete SLIP frame from the internal buffer. */
  _extractFrame() {
    // Find the first SLIP_END that starts a frame
    let start = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i] === SLIP_END) { start = i; break; }
    }
    if (start === -1) return null;

    // Find the next SLIP_END that ends the frame (skip consecutive 0xC0s)
    let end = -1;
    let inData = false;
    for (let i = start + 1; i < this.buffer.length; i++) {
      if (this.buffer[i] !== SLIP_END) inData = true;
      if (this.buffer[i] === SLIP_END && inData) { end = i; break; }
    }
    if (end === -1) return null;

    const frame = this.buffer.slice(start, end + 1);
    this.buffer = this.buffer.slice(end + 1);
    return frame;
  }

  /** Flush any buffered input data. */
  flush() {
    this.buffer = new Uint8Array(0);
  }
}

// ─── ESP ROM Bootloader Flasher ─────────────────────────────────────────────

export class ESPFlasher {
  /**
   * @param {SerialPort} port - WebSerial port (closed; will be opened)
   * @param {object} opts
   * @param {function} opts.log - Log callback: (message: string) => void
   */
  constructor(port, opts = {}) {
    this.transport = new SerialTransport(port);
    this.log = opts.log || (() => {});
    this.chipName = null;
    this.chipId = null;
    this.secureDownloadMode = false;
  }

  // ── High-level API ──────────────────────────────────────────────────────

  /**
   * Connect to the ROM bootloader, sync, and detect the chip.
   * Retries the full reset+sync sequence up to 7 times (matching esptool).
   * Returns the chip name string.
   */
  async connect(baudrate = 115200) {
    await this.transport.open(baudrate);

    // Try reset + sync up to 7 times
    const MAX_ATTEMPTS = 7;
    let synced = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.log(`Connection attempt ${attempt}/${MAX_ATTEMPTS}...`);

      // Reset into bootloader via USB JTAG sequence
      await this._usbJtagReset();

      // Try syncing (5 retries per attempt)
      if (await this._trySync()) {
        synced = true;
        break;
      }
    }

    if (!synced) {
      throw new Error(`Failed to sync with ROM bootloader (${MAX_ATTEMPTS} attempts)`);
    }

    // Detect chip via GET_SECURITY_INFO
    this.log('Reading security info...');
    const secInfo = await this._getSecurityInfo();

    if (secInfo) {
      this.secureDownloadMode = !!(secInfo.flags & 0x04);
      this.chipId = secInfo.chipId;
      this.chipName = CHIP_NAMES[this.chipId] || `Unknown (ID ${this.chipId})`;
    } else {
      this.chipName = 'Unknown';
    }

    this.log(`Chip: ${this.chipName}${this.secureDownloadMode ? ' (Secure Download Mode)' : ''}`);

    if (this.chipId === CHIP_ID_ESP32_C6 || this.secureDownloadMode) {
      this.log('Configuring SPI flash...');
      await this._spiAttach();
      await this._spiSetParams(4 * 1024 * 1024); // 4MB default
    }

    return this.chipName;
  }

  /**
   * Write firmware payloads to flash.
   * @param {Array<{data: Uint8Array, address: number}>} payloads
   * @param {function} onProgress - (payloadIndex, bytesWritten, totalBytes) => void
   */
  async flash(payloads, onProgress = null) {
    for (let i = 0; i < payloads.length; i++) {
      const { data, address } = payloads[i];
      this.log(`Writing ${data.length} bytes to 0x${address.toString(16)}...`);
      await this._flashPayload(data, address, (written, total) => {
        if (onProgress) onProgress(i, written, total);
      });
    }
  }

  /** Send FLASH_END to reboot the device. */
  async reboot() {
    this.log('Rebooting...');
    try {
      await this._command(CMD.FLASH_END, new Uint8Array(packU32(0)), 0, DEFAULT_TIMEOUT);
    } catch (e) {
      // FlashEnd may throw in SDM (digest verification) — safe to ignore
      this.log('(FlashEnd response ignored — normal in SDM)');
    }
  }

  /** Disconnect and close the serial port. */
  async disconnect() {
    await this.transport.close();
  }

  // ── Reset sequence ────────────────────────────────────────────────────

  /**
   * USB JTAG reset sequence to enter bootloader.
   * Toggles DTR (IO0) and RTS (EN) to reset the ESP32 into download mode.
   *
   * This must match the esptool-js UsbJtagSerialReset exactly.
   * Signals are set individually (not combined) because the WebSerial
   * setSignals API on some platforms requires separate calls, and the
   * esptool workaround re-sends DTR after each RTS change.
   */
  async _usbJtagReset() {
    // esptool-js setRTS(state) internally also calls setDTR(last_dtr_state)
    // as a Windows workaround. We replicate this by setting signals individually.
    let dtrState = false;

    const setRTS = async (state) => {
      await this.transport.setSignals({ requestToSend: state });
      // Workaround: re-send DTR to force a set-control-line-state request
      await this.transport.setSignals({ dataTerminalReady: dtrState });
    };
    const setDTR = async (state) => {
      dtrState = state;
      await this.transport.setSignals({ dataTerminalReady: state });
    };

    await setRTS(false);
    await setDTR(false);
    await sleep(100);

    await setDTR(true);
    await setRTS(false);
    await sleep(100);

    await setRTS(true);
    await setDTR(false);
    await setRTS(true);

    await sleep(100);
    await setRTS(false);
    await setDTR(false);

    // Wait for bootloader to start and print its banner
    await sleep(500);
    this.transport.flush();
  }

  // ── Sync ──────────────────────────────────────────────────────────────

  /**
   * Try to sync with the bootloader. Returns true if sync succeeded, false otherwise.
   * Makes 5 attempts with increasing timeouts.
   */
  async _trySync() {
    // SYNC payload: [0x07, 0x07, 0x12, 0x20] + 32 × 0x55
    const syncData = new Uint8Array(36);
    syncData[0] = 0x07; syncData[1] = 0x07;
    syncData[2] = 0x12; syncData[3] = 0x20;
    for (let i = 4; i < 36; i++) syncData[i] = 0x55;

    for (let attempt = 0; attempt < 5; attempt++) {
      this.transport.flush();
      try {
        await this._command(CMD.SYNC, syncData, 0, SYNC_TIMEOUT);
        // Read 7 additional sync responses (ROM sends 8 total)
        for (let i = 0; i < 7; i++) {
          try { await this._readResponse(CMD.SYNC, SYNC_TIMEOUT); } catch (e) { break; }
        }
        this.log('Sync established');
        return true;
      } catch (e) {
        // Retry
      }
    }
    return false;
  }

  // ── GET_SECURITY_INFO ─────────────────────────────────────────────────

  async _getSecurityInfo() {
    try {
      const resp = await this._command(CMD.GET_SECURITY_INFO, new Uint8Array(0), 0, DEFAULT_TIMEOUT);
      if (!resp.data || resp.data.length < 12) return null;

      const flags = unpackU32(resp.data, 0);
      let chipId = null;
      if (resp.data.length >= 16) {
        chipId = unpackU32(resp.data, 12);
      }

      return { flags, chipId };
    } catch (e) {
      this.log(`GET_SECURITY_INFO failed: ${e.message}`);
      return null;
    }
  }

  // ── SPI flash commands ────────────────────────────────────────────────

  async _spiAttach() {
    // ROM mode: 8 bytes (hspi_arg=0, is_legacy=0)
    const data = new Uint8Array([...packU32(0), ...packU32(0)]);
    await this._command(CMD.SPI_ATTACH, data, 0, DEFAULT_TIMEOUT);
  }

  async _spiSetParams(totalSize) {
    // 24 bytes: fl_id, total_size, block_size, sector_size, page_size, status_mask
    const data = new Uint8Array([
      ...packU32(0),          // fl_id
      ...packU32(totalSize),  // total_size
      ...packU32(0x10000),    // block_size (64KB)
      ...packU32(0x1000),     // sector_size (4KB)
      ...packU32(0x100),      // page_size (256B)
      ...packU32(0xffff),     // status_mask
    ]);
    await this._command(CMD.SPI_SET_PARAMS, data, 0, DEFAULT_TIMEOUT);
  }

  // ── Flash write ───────────────────────────────────────────────────────

  async _flashPayload(firmware, address, onProgress) {
    const numBlocks = Math.ceil(firmware.length / FLASH_WRITE_SIZE);
    const eraseSize = firmware.length; // ESP32-C6 getEraseSize returns size directly

    // FLASH_BEGIN: prepare flash region
    // ROM format: 20 bytes (erase_size, num_blocks, block_size, offset, encrypted=0)
    const beginData = new Uint8Array([
      ...packU32(eraseSize),
      ...packU32(numBlocks),
      ...packU32(FLASH_WRITE_SIZE),
      ...packU32(address),
      ...packU32(0), // encrypted=0 (MUST be 0 for SDM)
    ]);

    const eraseTimeout = Math.max(DEFAULT_TIMEOUT,
      Math.ceil(ERASE_WRITE_TIMEOUT_PER_MB * eraseSize / 1000000));
    this.log(`Preparing flash region at 0x${address.toString(16)} (${eraseSize} bytes)...`);
    await this._command(CMD.FLASH_BEGIN, beginData, 0, eraseTimeout);
    this.log(`Writing ${numBlocks} block${numBlocks === 1 ? '' : 's'}...`);

    // FLASH_DATA: write blocks
    for (let seq = 0; seq < numBlocks; seq++) {
      const start = seq * FLASH_WRITE_SIZE;
      const end = Math.min(start + FLASH_WRITE_SIZE, firmware.length);
      const chunk = firmware.slice(start, end);

      // Pad to FLASH_WRITE_SIZE with 0xFF
      const padded = new Uint8Array(FLASH_WRITE_SIZE);
      padded.fill(0xff);
      padded.set(chunk);

      // FLASH_DATA header: 16 bytes + data
      const header = new Uint8Array([
        ...packU32(padded.length),
        ...packU32(seq),
        ...packU32(0), // reserved
        ...packU32(0), // reserved
      ]);

      const packet = new Uint8Array(header.length + padded.length);
      packet.set(header);
      packet.set(padded, header.length);

      const blockTimeout = Math.max(DEFAULT_TIMEOUT,
        Math.ceil(ERASE_WRITE_TIMEOUT_PER_MB * FLASH_WRITE_SIZE / 1000000));
      await this._command(CMD.FLASH_DATA, packet, checksum(padded), blockTimeout);

      if (onProgress) onProgress(end, firmware.length);
    }
  }

  // ── Low-level command protocol ────────────────────────────────────────
  //
  // Command packet format (before SLIP encoding):
  //   Byte 0:     0x00 (direction: request)
  //   Byte 1:     opcode
  //   Byte 2-3:   data length (uint16 LE)
  //   Byte 4-7:   checksum (uint32 LE)
  //   Byte 8+:    data
  //
  // Response packet format (after SLIP decoding):
  //   Byte 0:     0x01 (direction: response)
  //   Byte 1:     opcode (echoed)
  //   Byte 2-3:   unused
  //   Byte 4-7:   value (uint32 LE)
  //   Byte 8+:    response data
  //   Last 2:     status (0 = success) + error code

  async _command(opcode, data, cs = 0, timeout = DEFAULT_TIMEOUT) {
    // Build command packet
    const packet = new Uint8Array(8 + data.length);
    packet[0] = 0x00; // direction: request
    packet[1] = opcode;
    packet[2] = data.length & 0xff;
    packet[3] = (data.length >> 8) & 0xff;
    packet[4] = cs & 0xff;
    packet[5] = (cs >> 8) & 0xff;
    packet[6] = (cs >> 16) & 0xff;
    packet[7] = (cs >> 24) & 0xff;
    packet.set(data, 8);

    // Send SLIP-encoded packet
    await this.transport.writeSlip(packet);

    // Read response
    try {
      return await this._readResponse(opcode, timeout);
    } catch (error) {
      const commandName = CMD_NAMES[opcode] ?? `0x${opcode.toString(16)}`;
      throw new Error(`${commandName} failed: ${error.message}`);
    }
  }

  async _readResponse(expectedOp, timeout = DEFAULT_TIMEOUT) {
    const deadline = Date.now() + timeout;
    let resp = null;

    while (Date.now() < deadline) {
      resp = await this.transport.readSlip(Math.max(1, deadline - Date.now()));
      if (resp.length >= 2 && resp[1] !== expectedOp) {
        continue;
      }
      break;
    }

    if (!resp) {
      throw new Error('Read timeout');
    }

    if (resp.length < 8) {
      throw new Error(`Response too short (${resp.length} bytes)`);
    }

    const direction = resp[0]; // Should be 0x01
    const opcode = resp[1];
    const value = unpackU32(resp, 4);

    // Response data is everything after the 8-byte header,
    // except the last 2 bytes which are status/error
    const dataEnd = resp.length >= 10 ? resp.length - 2 : 8;
    const data = resp.slice(8, dataEnd);

    // Status is in the last 2 bytes (if present)
    const status = resp.length >= 10 ? resp[resp.length - 2] : 0;
    const error = resp.length >= 10 ? resp[resp.length - 1] : 0;

    if (direction !== 0x01) {
      throw new Error(`Unexpected response direction: 0x${direction.toString(16)}`);
    }

    if (status !== 0) {
      throw new Error(`Command 0x${expectedOp.toString(16)} failed with status ${status}, error ${error}`);
    }

    return { opcode, value, data };
  }
}
