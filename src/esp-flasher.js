/**
 * Compatibility adapter around esptool-js for EP01 firmware flashing.
 *
 * esptool-js is pinned as an SDK dependency. The package bundle avoids the
 * extensionless internal imports in esptool-js/lib when loaded by Node ESM.
 */

import { ESPLoader, Transport } from 'esptool-js/bundle.js';

export const DEFAULT_INITIAL_BAUDRATE = 115200;
export const DEFAULT_FLASH_BAUDRATE = null;
export const EP01_FLASH_SIZE_BYTES = 8 * 1024 * 1024;
export const EP01_FLASH_SIZE = '8MB';
export const DEFAULT_FLASH_SIZE = EP01_FLASH_SIZE_BYTES;
export const FLASH_SECTOR_SIZE = 0x1000;
export const WATCHDOG_FEED_BLOCK_INTERVAL = 128;
export const FLASH_ALIGNMENT_BYTES = 4;
export const FLASH_PADDING_BYTE = 0xff;

const CHIP_NAME_ESP32_C6 = 'ESP32-C6';
const WDT_WKEY = 0x50d83aa1;
const ESP32_C6_LP_WDT_BASE = 0x600b1c00;
const ESP32_C6_LP_WDT_CONFIG0_REG = ESP32_C6_LP_WDT_BASE + 0x00;
const ESP32_C6_LP_WDT_FEED_REG = ESP32_C6_LP_WDT_BASE + 0x14;
const ESP32_C6_LP_WDT_WPROTECT_REG = ESP32_C6_LP_WDT_BASE + 0x18;
const ESP32_C6_LP_WDT_SWD_CONFIG_REG = ESP32_C6_LP_WDT_BASE + 0x1c;
const ESP32_C6_LP_WDT_SWD_WPROTECT_REG = ESP32_C6_LP_WDT_BASE + 0x20;
const ESP32_C6_WDT_FEED = 0x80000000;
const ESP32_C6_SWD_AUTO_FEED_EN = 1 << 18;

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function abortError(signal, operation = 'operation') {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error(reason === undefined ? `Operation aborted during ${operation}` : String(reason));
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function diagnosticDetail(detail) {
  if (detail === undefined) {
    return '';
  }

  try {
    return ` ${JSON.stringify(detail)}`;
  } catch (error) {
    return ` ${String(detail)}`;
  }
}

function formatUsbId(value) {
  return value === undefined ? undefined : `0x${value.toString(16).padStart(4, '0')}`;
}

function summarizePort(port) {
  let info = null;
  try {
    info = typeof port?.getInfo === 'function' ? port.getInfo() : null;
  } catch (error) {
    info = { error: error.message };
  }

  return {
    usbVendorId: formatUsbId(info?.usbVendorId),
    usbProductId: formatUsbId(info?.usbProductId),
    readable: Boolean(port?.readable),
    writable: Boolean(port?.writable),
  };
}

function serialPortInfo(port) {
  try {
    return typeof port?.getInfo === 'function' ? port.getInfo() : null;
  } catch (error) {
    return null;
  }
}

function serialPortsMatch(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftInfo = serialPortInfo(left);
  const rightInfo = serialPortInfo(right);
  if (!leftInfo || !rightInfo) {
    return false;
  }

  return leftInfo.usbVendorId === rightInfo.usbVendorId
    && leftInfo.usbProductId === rightInfo.usbProductId;
}

function serialEventTarget(serial) {
  if (serial?.addEventListener && serial?.removeEventListener) {
    return serial;
  }

  const browserSerial = globalThis.navigator?.serial;
  if (browserSerial?.addEventListener && browserSerial?.removeEventListener) {
    return browserSerial;
  }

  return null;
}

function emitLog(log, message) {
  if (!log) {
    return;
  }

  for (const line of String(message).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      log(trimmed);
    }
  }
}

function terminalFromLog(log) {
  return {
    clean() {},
    write: (message) => emitLog(log, message),
    writeLine: (message) => emitLog(log, message),
  };
}

function normalizePayload(payload, index) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Flash payload ${index + 1} is invalid`);
  }

  if (!(payload.data instanceof Uint8Array)) {
    throw new Error(`Flash payload ${index + 1} data must be a Uint8Array`);
  }

  if (!Number.isInteger(payload.address) || payload.address < 0) {
    throw new Error(`Flash payload ${index + 1} is missing a valid address`);
  }

  return {
    data: payload.data,
    address: payload.address,
  };
}

function summarizePayloads(payloads) {
  return payloads.map((payload, index) => ({
    index,
    address: `0x${payload.address.toString(16)}`,
    byteLength: payload.data.length,
  }));
}

export function roundEraseSizeToSectors(size, sectorSize = FLASH_SECTOR_SIZE) {
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`Invalid erase size: ${size}`);
  }

  if (!Number.isInteger(sectorSize) || sectorSize <= 0) {
    throw new Error(`Invalid sector size: ${sectorSize}`);
  }

  return Math.ceil(size / sectorSize) * sectorSize;
}

export function createEp01FlashOptions(fileArray, reportProgress, overrides = {}) {
  return {
    fileArray,
    flashMode: overrides.flashMode ?? 'keep',
    flashFreq: overrides.flashFreq ?? 'keep',
    flashSize: overrides.flashSize ?? EP01_FLASH_SIZE,
    eraseAll: false,
    compress: false,
    reportProgress,
  };
}

function padTo(data, alignment, padCharacter = FLASH_PADDING_BYTE) {
  if (!Number.isInteger(alignment) || alignment <= 0) {
    throw new Error(`Invalid flash alignment: ${alignment}`);
  }

  const padding = data.length % alignment;
  if (padding === 0) {
    return data;
  }

  const padded = new Uint8Array(data.length + alignment - padding);
  padded.fill(padCharacter);
  padded.set(data);
  return padded;
}

function timeoutPerMb(loader, secondsPerMb, sizeBytes) {
  if (typeof loader.timeoutPerMb === 'function') {
    return loader.timeoutPerMb(secondsPerMb, sizeBytes);
  }

  return Math.max(3000, secondsPerMb * (sizeBytes / 1000000));
}

function flashBlockTimeout(loader) {
  return timeoutPerMb(
    loader,
    loader.ERASE_WRITE_TIMEOUT_PER_MB ?? 40000,
    loader.FLASH_WRITE_SIZE,
  );
}

function payloadSignature(payloads) {
  return payloads
    .map((payload) => `${payload.address}:${payload.data.length}`)
    .join('|');
}

function sectorAlignedResumeOffset(address, resumeOffset, blockSize) {
  const alignedAddress = Math.max(
    address,
    Math.floor((address + resumeOffset) / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE,
  );
  const alignedOffset = alignedAddress - address;
  return Math.floor(alignedOffset / blockSize) * blockSize;
}

export function isSerialDisconnectError(error) {
  const text = `${error?.name ?? ''} ${error?.message ?? error ?? ''}`.toLowerCase();
  return text.includes('device has been lost')
    || text.includes('serial data stream stopped')
    || text.includes('no serial data received')
    || text.includes('networkerror')
    || text.includes('port is closed')
    || text.includes('port lost')
    || text.includes('disconnected')
    || text.includes('disconnect');
}

export class SerialPortLostError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'SerialPortLostError';
    this.cause = options.cause;
    this.serialPortLost = true;
  }
}

export class FlashProgressTracker {
  constructor(payloads = []) {
    this.payloads = [];
    this.blockSize = null;
    this.signature = null;
    this.finished = false;

    if (payloads.length > 0) {
      this.payloads = payloads.map((payload, index) => ({
        index,
        address: payload.address,
        byteLength: payload.data.length,
        paddedLength: payload.data.length,
        totalBlocks: 0,
        ackedBlocks: 0,
      }));
      this.signature = payloadSignature(payloads);
    }
  }

  prepare(payloads, blockSize) {
    if (!Number.isInteger(blockSize) || blockSize <= 0) {
      throw new Error(`Invalid flash block size: ${blockSize}`);
    }

    const signature = payloadSignature(payloads);
    if (this.blockSize !== null) {
      if (this.blockSize !== blockSize || this.signature !== signature) {
        throw new Error('Flash progress tracker cannot resume a different payload stream');
      }
      return;
    }

    this.blockSize = blockSize;
    this.signature = signature;
    this.payloads = payloads.map((payload, index) => {
      const paddedLength = padTo(payload.data, FLASH_ALIGNMENT_BYTES).length;
      return {
        index,
        address: payload.address,
        byteLength: payload.data.length,
        paddedLength,
        totalBlocks: Math.ceil(paddedLength / blockSize),
        ackedBlocks: 0,
      };
    });
  }

  payloadState(index) {
    const state = this.payloads[index];
    if (!state) {
      throw new Error(`Unknown flash payload index ${index}`);
    }
    return state;
  }

  payloadWritten(index) {
    const state = this.payloadState(index);
    if (state.byteLength === 0) {
      return 0;
    }
    return Math.min(state.ackedBlocks * this.blockSize, state.byteLength);
  }

  acknowledgeBlock(payloadIndex, blockIndex) {
    const state = this.payloadState(payloadIndex);
    if (blockIndex < state.ackedBlocks) {
      return;
    }
    if (blockIndex !== state.ackedBlocks) {
      throw new Error(
        `Cannot ACK flash block ${blockIndex} before block ${state.ackedBlocks} for payload ${payloadIndex}`,
      );
    }
    state.ackedBlocks += 1;
  }

  rollbackPayload(payloadIndex, ackedBlocks) {
    const state = this.payloadState(payloadIndex);
    state.ackedBlocks = Math.max(0, Math.min(state.ackedBlocks, ackedBlocks, state.totalBlocks));
    return state.ackedBlocks;
  }

  markPayloadComplete(index) {
    const state = this.payloadState(index);
    state.ackedBlocks = state.totalBlocks;
  }

  isPayloadComplete(index) {
    const state = this.payloadState(index);
    return state.ackedBlocks >= state.totalBlocks;
  }

  isComplete() {
    if (this.blockSize === null) {
      return false;
    }
    return this.payloads.every((payload) => payload.ackedBlocks >= payload.totalBlocks);
  }

  summary() {
    const totalBytes = this.payloads.reduce((sum, payload) => sum + payload.byteLength, 0);
    const completedBytes = this.payloads.reduce((sum, payload) => (
      sum + Math.min(payload.ackedBlocks * (this.blockSize ?? 0), payload.byteLength)
    ), 0);
    const totalBlocks = this.payloads.reduce((sum, payload) => sum + payload.totalBlocks, 0);
    const ackedBlocks = this.payloads.reduce((sum, payload) => sum + payload.ackedBlocks, 0);

    return {
      blockSize: this.blockSize,
      prepared: this.blockSize !== null,
      completedBytes,
      totalBytes,
      ackedBlocks,
      totalBlocks,
      complete: this.isComplete(),
      payloads: this.payloads.map((payload) => ({
        index: payload.index,
        address: `0x${payload.address.toString(16)}`,
        byteLength: payload.byteLength,
        paddedLength: payload.paddedLength,
        ackedBlocks: payload.ackedBlocks,
        totalBlocks: payload.totalBlocks,
        written: Math.min(payload.ackedBlocks * (this.blockSize ?? 0), payload.byteLength),
      })),
    };
  }
}

export class ESPFlasher {
  /**
   * @param {SerialPort} port WebSerial port, closed before connect().
   * @param {object} opts
   * @param {function} opts.log Log callback.
   * @param {typeof ESPLoader} opts.ESPLoader Test seam for offline adapter tests.
   * @param {typeof Transport} opts.Transport Test seam for offline adapter tests.
   */
  constructor(port, opts = {}) {
    this.port = port;
    this.log = opts.log || (() => {});
    this.LoaderClass = opts.ESPLoader ?? ESPLoader;
    this.TransportClass = opts.Transport ?? Transport;
    this.serial = serialEventTarget(opts.serial);
    this.loader = null;
    this.transport = null;
    this.chipName = null;
    this.secureDownloadMode = false;
    this.watchdogFeedSupported = false;
    this._deviceLost = false;
    this._activePayload = null;
    this._flashFinishRequested = false;
    this._disconnectWaiters = new Set();
    this._removeSerialDisconnectListener = this._installSerialDisconnectListener();
  }

  async connect(baudrate = DEFAULT_INITIAL_BAUDRATE, options = {}) {
    throwIfAborted(options.signal);

    const initialBaudrate = baudrate ?? DEFAULT_INITIAL_BAUDRATE;
    const flashBaudrate = options.flashBaudrate ?? DEFAULT_FLASH_BAUDRATE;
    const finalBaudrate = flashBaudrate ?? initialBaudrate;
    const connectAttempts = options.connectAttempts ?? 7;
    const resetMode = options.resetMode ?? 'default_reset';

    this.log(`rom:connect:start${diagnosticDetail({
      initialBaudrate,
      flashBaudrate,
      finalBaudrate,
      resetMode,
      connectAttempts,
      flashSize: EP01_FLASH_SIZE,
      flashSizeBytes: EP01_FLASH_SIZE_BYTES,
      port: summarizePort(this.port),
    })}`);

    this.transport = new this.TransportClass(this.port, Boolean(options.tracing));
    if (typeof this.transport.setDeviceLostCallback === 'function') {
      this.transport.setDeviceLostCallback(() => {
        this._deviceLost = true;
        this.log(`rom:transport:port-lost${diagnosticDetail({
          port: summarizePort(this.port),
        })}`);
      });
    }

    this.loader = new this.LoaderClass({
      transport: this.transport,
      baudrate: finalBaudrate,
      terminal: terminalFromLog(this.log),
      debugLogging: Boolean(options.debugLogging),
      enableTracing: Boolean(options.tracing),
      serialOptions: options.serialOptions,
      resetConstructors: options.resetConstructors,
    });

    if ('romBaudrate' in this.loader) {
      this.loader.romBaudrate = initialBaudrate;
    }

    await this._withAbortRace(
      this.loader.connect(resetMode, connectAttempts, true),
      options.signal,
      'rom-connect',
    );
    throwIfAborted(options.signal);
    this.chipName = this.loader.chip?.CHIP_NAME ?? 'unknown';
    this.secureDownloadMode = Boolean(this.loader.secureDownloadMode);

    this._forceRomFlashWriteSize();
    this._installSectorEraseRounding();
    this._installFlashBlockInstrumentation();

    if (this._shouldConfigureSpiFlash()) {
      throwIfAborted(options.signal);
      this.log(`rom:spi-config:start${diagnosticDetail({
        chipName: this.chipName,
        secureDownloadMode: this.secureDownloadMode,
        flashSize: EP01_FLASH_SIZE,
        flashSizeBytes: EP01_FLASH_SIZE_BYTES,
      })}`);
      await this._withAbortRace(this.loader.flashSpiAttach(0), options.signal, 'rom-spi-attach');
      await this._withAbortRace(
        this.loader.flashSetParameters(EP01_FLASH_SIZE_BYTES),
        options.signal,
        'rom-spi-set-parameters',
      );
      this.log('rom:spi-config:complete');
    }

    await this._configureWatchdogsForFlash(options.signal);

    if (flashBaudrate && flashBaudrate !== initialBaudrate) {
      throwIfAborted(options.signal);
      await this._withAbortRace(this.loader.changeBaud(), options.signal, 'rom-change-baud');
    }
    throwIfAborted(options.signal);

    this.log(`rom:connect:complete${diagnosticDetail({
      chipName: this.chipName,
      secureDownloadMode: this.secureDownloadMode,
      isStub: Boolean(this.loader.IS_STUB),
      flashWriteSize: this.loader.FLASH_WRITE_SIZE,
      port: summarizePort(this.port),
    })}`);
    return this.chipName;
  }

  async flash(payloads, onProgress = null, options = {}) {
    throwIfAborted(options.signal);

    if (!this.loader) {
      throw new Error('ESPFlasher.connect() must be called before flash()');
    }

    const normalizedPayloads = payloads.map(normalizePayload);
    const progressTracker = options.progressTracker ?? new FlashProgressTracker(normalizedPayloads);
    progressTracker.prepare(normalizedPayloads, this.loader.FLASH_WRITE_SIZE);
    this.log(`rom:flash:start${diagnosticDetail({
      payloadCount: normalizedPayloads.length,
      payloads: summarizePayloads(normalizedPayloads),
      secureDownloadMode: this.secureDownloadMode,
      compress: false,
      flashSize: EP01_FLASH_SIZE,
      isStub: Boolean(this.loader.IS_STUB),
      progress: progressTracker.summary(),
    })}`);

    this._flashFinishRequested = false;

    if (this._shouldConfigureSpiFlash() && typeof this.loader.flashSetParameters === 'function') {
      throwIfAborted(options.signal);
      this.log(`rom:flash:spi-config:start${diagnosticDetail({
        flashSize: EP01_FLASH_SIZE,
        flashSizeBytes: EP01_FLASH_SIZE_BYTES,
        secureDownloadMode: this.secureDownloadMode,
      })}`);
      await this._withAbortRace(
        this.loader.flashSetParameters(EP01_FLASH_SIZE_BYTES),
        options.signal,
        'flash-spi-set-parameters',
      );
      this.log('rom:flash:spi-config:complete');
    }

    let lastBlockTimeout = this.loader.DEFAULT_TIMEOUT ?? 3000;

    for (let index = 0; index < normalizedPayloads.length; index += 1) {
      throwIfAborted(options.signal);
      const payload = normalizedPayloads[index];
      const paddedImage = padTo(payload.data, FLASH_ALIGNMENT_BYTES);
      const payloadProgress = progressTracker.payloadState(index);
      let resumeOffset = payloadProgress.ackedBlocks * this.loader.FLASH_WRITE_SIZE;

      if (resumeOffset > 0 && !progressTracker.isPayloadComplete(index)) {
        const alignedResumeOffset = sectorAlignedResumeOffset(
          payload.address,
          resumeOffset,
          this.loader.FLASH_WRITE_SIZE,
        );

        if (alignedResumeOffset < resumeOffset) {
          const previousAckedBlocks = payloadProgress.ackedBlocks;
          const previousResumeOffset = resumeOffset;
          const alignedAckedBlocks = Math.floor(alignedResumeOffset / this.loader.FLASH_WRITE_SIZE);
          progressTracker.rollbackPayload(index, alignedAckedBlocks);
          resumeOffset = payloadProgress.ackedBlocks * this.loader.FLASH_WRITE_SIZE;
          this.log(`rom:flash-payload:resume-rollback${diagnosticDetail({
            index,
            address: `0x${payload.address.toString(16)}`,
            previousAckedBlocks,
            ackedBlocks: payloadProgress.ackedBlocks,
            previousResumeOffset,
            resumeOffset,
            sectorSize: FLASH_SECTOR_SIZE,
          })}`);
        }
      }

      this._activePayload = {
        index,
        address: payload.address,
        byteLength: payload.data.length,
        paddedLength: paddedImage.length,
        totalBlocks: payloadProgress.totalBlocks,
        baseBlock: payloadProgress.ackedBlocks,
        progressTracker,
        signal: options.signal,
        startedAt: nowMs(),
      };

      this.log(`rom:flash-payload:start${diagnosticDetail({
        index,
        address: `0x${payload.address.toString(16)}`,
        byteLength: payload.data.length,
        resumeOffset,
        ackedBlocks: payloadProgress.ackedBlocks,
        totalBlocks: payloadProgress.totalBlocks,
      })}`);

      const reportProgress = (written, total) => {
        onProgress?.(index, written, total);
        options.onPayloadProgress?.(index, written, total, index);
      };

      try {
        if (payload.data.length === 0) {
          this.log(`rom:flash-payload:skipped-empty${diagnosticDetail({
            index,
            address: `0x${payload.address.toString(16)}`,
          })}`);
          reportProgress(0, 0);
          continue;
        }

        if (progressTracker.isPayloadComplete(index)) {
          this.log(`rom:flash-payload:skipped-complete${diagnosticDetail({
            index,
            address: `0x${payload.address.toString(16)}`,
            byteLength: payload.data.length,
            ackedBlocks: payloadProgress.ackedBlocks,
            totalBlocks: payloadProgress.totalBlocks,
          })}`);
          reportProgress(payload.data.length, payload.data.length);
          continue;
        }

        reportProgress(progressTracker.payloadWritten(index), payload.data.length);
        const remainingLength = paddedImage.length - resumeOffset;
        const beginAddress = payload.address + resumeOffset;
        throwIfAborted(options.signal);
        const blocks = await this._withAbortRace(
          this.loader.flashBegin(remainingLength, beginAddress),
          options.signal,
          `flash-payload-${index}-begin`,
        );
        this.log(`rom:flash-payload:begin-complete${diagnosticDetail({
          index,
          address: `0x${beginAddress.toString(16)}`,
          byteLength: payload.data.length,
          paddedLength: paddedImage.length,
          remainingLength,
          resumeOffset,
          blocks,
          ackedBlocks: payloadProgress.ackedBlocks,
          totalBlocks: payloadProgress.totalBlocks,
          flashWriteSize: this.loader.FLASH_WRITE_SIZE,
        })}`);

        let sequence = 0;
        let imageOffset = resumeOffset;
        while (sequence < blocks) {
          throwIfAborted(options.signal);
          const blockSize = Math.min(this.loader.FLASH_WRITE_SIZE, paddedImage.length - imageOffset);
          const paddedBlockSize = blockSize < this.loader.FLASH_WRITE_SIZE
            ? this.loader.FLASH_WRITE_SIZE
            : blockSize;
          let block = paddedImage.slice(imageOffset, imageOffset + blockSize);
          if (block.length < paddedBlockSize) {
            block = padTo(block, paddedBlockSize);
          }

          lastBlockTimeout = flashBlockTimeout(this.loader);
          await this.loader.flashBlock(block, sequence, lastBlockTimeout);
          throwIfAborted(options.signal);

          imageOffset += blockSize;
          sequence += 1;
          reportProgress(progressTracker.payloadWritten(index), payload.data.length);
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw abortError(options.signal);
        }

        if (this._deviceLost || isSerialDisconnectError(error)) {
          this.log(`rom:flash:disconnect-detected${diagnosticDetail({
            index,
            address: `0x${payload.address.toString(16)}`,
            byteLength: payload.data.length,
            progress: progressTracker.summary(),
            error: error.message,
            port: summarizePort(this.port),
          })}`);
          throw new SerialPortLostError(`Serial port lost during firmware flash: ${error.message}`, { cause: error });
        }
        throw error;
      } finally {
        this._activePayload = null;
      }

      this.log(`rom:flash-payload:complete${diagnosticDetail({
        index,
        address: `0x${payload.address.toString(16)}`,
        byteLength: payload.data.length,
      })}`);
    }

    await this._finishFlashSession(lastBlockTimeout, options.signal);
    this.log('rom:flash:complete');
  }

  async reboot(signal = null) {
    throwIfAborted(signal);

    if (!this.loader) {
      return;
    }

    this.log(`rom:reboot:start${diagnosticDetail({
      secureDownloadMode: this.secureDownloadMode,
      isStub: Boolean(this.loader.IS_STUB),
      port: summarizePort(this.port),
    })}`);

    if (this.secureDownloadMode) {
      if (this._flashFinishRequested) {
        this.log('rom:reboot:skipped-sdm-flash-finish-already-requested');
        return;
      }

      await this._finishFlashSession(this.loader.DEFAULT_TIMEOUT ?? 3000, signal);
      return;
    }

    try {
      await this._withAbortRace(this.loader.softReset(false), signal, 'rom-reboot');
      this.log('rom:reboot:complete');
    } catch (error) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      if (isSerialDisconnectError(error)) {
        throw new SerialPortLostError(`Serial port lost during firmware reboot: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  async disconnect() {
    this.log(`rom:disconnect:start${diagnosticDetail({
      port: summarizePort(this.port),
    })}`);

    this._removeSerialDisconnectListener?.();
    this._removeSerialDisconnectListener = null;

    if (this.transport && typeof this.transport.disconnect === 'function') {
      try {
        await this.transport.disconnect();
      } catch (error) {
        this.log(`rom:disconnect:ignored-error${diagnosticDetail({
          error: error.message,
          port: summarizePort(this.port),
        })}`);
      }
    }

    this.log(`rom:disconnect:complete${diagnosticDetail({
      port: summarizePort(this.port),
    })}`);
  }

  _shouldConfigureSpiFlash() {
    return this.secureDownloadMode || this.chipName === CHIP_NAME_ESP32_C6;
  }

  async _finishFlashSession(timeout, signal = null) {
    throwIfAborted(signal);

    if (this.secureDownloadMode) {
      this.log(`rom:flash-finish:start${diagnosticDetail({
        reboot: true,
        secureDownloadMode: true,
        timeout,
      })}`);

      try {
        await this._withAbortRace(this.loader.flashFinish(true, timeout), signal, 'flash-finish');
        this.log('rom:flash-finish:complete');
      } catch (error) {
        if (signal?.aborted) {
          throw abortError(signal);
        }

        if (this._deviceLost || isSerialDisconnectError(error)) {
          this.log(`rom:flash-finish:disconnect-detected${diagnosticDetail({
            error: error.message,
            port: summarizePort(this.port),
          })}`);
          throw new SerialPortLostError(`Serial port lost during firmware flash finish: ${error.message}`, { cause: error });
        }

        this.log(`rom:flash-finish:ignored-sdm-error${diagnosticDetail({
          error: error.message,
        })}`);
      }

      this._flashFinishRequested = true;
      return;
    }

    if (this.loader.IS_STUB && typeof this.loader.flashFinish === 'function') {
      this.log(`rom:flash-finish:start${diagnosticDetail({
        reboot: false,
        secureDownloadMode: false,
        timeout,
      })}`);
      await this._withAbortRace(this.loader.flashFinish(false, timeout), signal, 'flash-finish');
      this._flashFinishRequested = true;
      this.log('rom:flash-finish:complete');
    }
  }

  _forceRomFlashWriteSize() {
    const chipFlashWriteSize = this.loader?.chip?.FLASH_WRITE_SIZE;
    if (Number.isInteger(chipFlashWriteSize) && chipFlashWriteSize > 0) {
      this.loader.FLASH_WRITE_SIZE = chipFlashWriteSize;
    }
  }

  _installSectorEraseRounding() {
    if (!this.loader?.chip || this.loader.chip._enodyEraseRoundingInstalled) {
      return;
    }

    const chip = this.loader.chip;
    const originalGetEraseSize = chip.getEraseSize?.bind(chip) ?? ((_offset, size) => size);
    chip.getEraseSize = (offset, size) => {
      const rawEraseSize = originalGetEraseSize(offset, size);
      const roundedEraseSize = roundEraseSizeToSectors(rawEraseSize);
      this.log(`rom:flash-begin:erase-size${diagnosticDetail({
        offset: `0x${offset.toString(16)}`,
        size,
        rawEraseSize,
        roundedEraseSize,
        sectorSize: FLASH_SECTOR_SIZE,
      })}`);
      return roundedEraseSize;
    };
    chip._enodyEraseRoundingInstalled = true;
  }

  _installFlashBlockInstrumentation() {
    if (!this.loader || this.loader._enodyFlashBlockInstrumentationInstalled) {
      return;
    }

    const originalFlashBlock = this.loader.flashBlock.bind(this.loader);
    this.loader.flashBlock = async (data, seq, timeout) => {
      const activePayload = this._activePayload;
      const flashWriteSize = this.loader.FLASH_WRITE_SIZE;
      const absoluteSeq = (activePayload?.baseBlock ?? 0) + seq;
      const blockNumber = absoluteSeq + 1;
      const numBlocks = activePayload
        ? activePayload.totalBlocks
        : null;
      const startByte = absoluteSeq * flashWriteSize;
      const endByte = activePayload
        ? Math.min(startByte + flashWriteSize, activePayload.byteLength)
        : startByte + data.length;
      const blockAddress = activePayload ? activePayload.address + startByte : null;
      const blockStartedAt = nowMs();

      if (seq > 0 && seq % WATCHDOG_FEED_BLOCK_INTERVAL === 0) {
        await this._feedWatchdog(`flash-data-block-${blockNumber}`);
      }

      this.log(`rom:flash-data:block:start${diagnosticDetail({
        payloadIndex: activePayload?.index ?? null,
        blockNumber,
        numBlocks,
        seq,
        absoluteSeq,
        address: blockAddress === null ? null : `0x${blockAddress.toString(16)}`,
        bytes: `${startByte}-${endByte}`,
        paddedLength: data.length,
        timeout,
      })}`);

      try {
        await this._withSerialDisconnectRace(
          originalFlashBlock(data, seq, timeout),
          `flash-data-block-${blockNumber}`,
          activePayload?.signal,
        );
        activePayload?.progressTracker?.acknowledgeBlock(activePayload.index, absoluteSeq);
        this.log(`rom:flash-data:block:ack${diagnosticDetail({
          payloadIndex: activePayload?.index ?? null,
          blockNumber,
          numBlocks,
          seq,
          absoluteSeq,
          address: blockAddress === null ? null : `0x${blockAddress.toString(16)}`,
          bytes: `${startByte}-${endByte}`,
          elapsedMs: Math.round(nowMs() - blockStartedAt),
          totalElapsedMs: activePayload ? Math.round(nowMs() - activePayload.startedAt) : null,
        })}`);
      } catch (error) {
        this.log(`rom:flash-data:block:failed${diagnosticDetail({
          payloadIndex: activePayload?.index ?? null,
          blockNumber,
          numBlocks,
          seq,
          absoluteSeq,
          address: blockAddress === null ? null : `0x${blockAddress.toString(16)}`,
          bytes: `${startByte}-${endByte}`,
          elapsedMs: Math.round(nowMs() - blockStartedAt),
          totalElapsedMs: activePayload ? Math.round(nowMs() - activePayload.startedAt) : null,
          error: error.message,
          port: summarizePort(this.port),
        })}`);
        throw error;
      }
    };
    this.loader._enodyFlashBlockInstrumentationInstalled = true;
  }

  _installSerialDisconnectListener() {
    if (!this.serial?.addEventListener || !this.serial?.removeEventListener) {
      return null;
    }

    const onDisconnect = (event) => {
      const eventPort = event?.target ?? null;
      if (eventPort && !serialPortsMatch(eventPort, this.port)) {
        return;
      }

      this._deviceLost = true;
      const error = new SerialPortLostError('Serial port disconnected during firmware flash');
      this.log(`rom:serial:disconnect-event${diagnosticDetail({
        port: summarizePort(eventPort ?? this.port),
      })}`);

      for (const reject of this._disconnectWaiters) {
        reject(error);
      }
      this._disconnectWaiters.clear();
    };

    this.serial.addEventListener('disconnect', onDisconnect);
    this.log('rom:serial:disconnect-listener-installed');
    return () => {
      this.serial.removeEventListener('disconnect', onDisconnect);
      this.log('rom:serial:disconnect-listener-removed');
    };
  }

  _withAbortRace(operationPromise, signal = null, operation = 'operation') {
    if (!signal?.addEventListener) {
      return operationPromise;
    }

    if (signal.aborted) {
      return Promise.reject(abortError(signal, operation));
    }

    let onAbort = null;
    const abortPromise = new Promise((_, reject) => {
      onAbort = () => {
        reject(abortError(signal, operation));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });

    return Promise.race([operationPromise, abortPromise]).finally(() => {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    });
  }

  _withSerialDisconnectRace(operationPromise, operation, signal = null) {
    if (!this.serial?.addEventListener) {
      return this._withAbortRace(operationPromise, signal, operation);
    }

    if (signal?.aborted) {
      return Promise.reject(abortError(signal, operation));
    }

    let rejectDisconnect = null;
    const disconnectPromise = new Promise((_, reject) => {
      rejectDisconnect = reject;
      if (this._deviceLost) {
        reject(new SerialPortLostError(`Serial port disconnected during ${operation}`));
        return;
      }
      this._disconnectWaiters.add(reject);
    });

    return this._withAbortRace(
      Promise.race([operationPromise, disconnectPromise]),
      signal,
      operation,
    ).finally(() => {
      if (rejectDisconnect) {
        this._disconnectWaiters.delete(rejectDisconnect);
      }
    });
  }

  async _configureWatchdogsForFlash(signal = null) {
    throwIfAborted(signal);

    if (this.chipName !== CHIP_NAME_ESP32_C6 || typeof this.loader?.writeReg !== 'function') {
      this.log(`rom:watchdog:skipped${diagnosticDetail({
        chipName: this.chipName,
        hasWriteReg: Boolean(this.loader?.writeReg),
      })}`);
      return;
    }

    this.log(`rom:watchdog:disable:start${diagnosticDetail({
      chipName: this.chipName,
      secureDownloadMode: this.secureDownloadMode,
    })}`);

    try {
      await this._withAbortRace(this.loader.writeReg(ESP32_C6_LP_WDT_WPROTECT_REG, WDT_WKEY), signal, 'watchdog-disable');
      await this._withAbortRace(this.loader.writeReg(ESP32_C6_LP_WDT_FEED_REG, ESP32_C6_WDT_FEED), signal, 'watchdog-disable');
      await this._withAbortRace(this.loader.writeReg(ESP32_C6_LP_WDT_CONFIG0_REG, 0), signal, 'watchdog-disable');
      await this._withAbortRace(this.loader.writeReg(ESP32_C6_LP_WDT_WPROTECT_REG, 0), signal, 'watchdog-disable');

      await this._withAbortRace(this.loader.writeReg(ESP32_C6_LP_WDT_SWD_WPROTECT_REG, WDT_WKEY), signal, 'watchdog-disable');
      await this._withAbortRace(this.loader.writeReg(ESP32_C6_LP_WDT_SWD_CONFIG_REG, ESP32_C6_SWD_AUTO_FEED_EN), signal, 'watchdog-disable');
      await this._withAbortRace(this.loader.writeReg(ESP32_C6_LP_WDT_SWD_WPROTECT_REG, 0), signal, 'watchdog-disable');

      this.watchdogFeedSupported = true;
      this.log('rom:watchdog:disable:complete');
    } catch (error) {
      if (signal?.aborted) {
        throw abortError(signal);
      }

      this.watchdogFeedSupported = false;
      this.log(`rom:watchdog:disable:failed${diagnosticDetail({
        error: error.message,
        secureDownloadMode: this.secureDownloadMode,
      })}`);

      try {
        await this.loader.writeReg(ESP32_C6_LP_WDT_WPROTECT_REG, 0);
        await this.loader.writeReg(ESP32_C6_LP_WDT_SWD_WPROTECT_REG, 0);
      } catch (protectError) {
        this.log(`rom:watchdog:reprotect:failed${diagnosticDetail({
          error: protectError.message,
        })}`);
      }
    }
  }

  async _feedWatchdog(reason) {
    if (!this.watchdogFeedSupported) {
      return;
    }

    try {
      await this.loader.writeReg(ESP32_C6_LP_WDT_WPROTECT_REG, WDT_WKEY);
      await this.loader.writeReg(ESP32_C6_LP_WDT_FEED_REG, ESP32_C6_WDT_FEED);
      await this.loader.writeReg(ESP32_C6_LP_WDT_WPROTECT_REG, 0);
      this.log(`rom:watchdog:feed${diagnosticDetail({ reason })}`);
    } catch (error) {
      this.watchdogFeedSupported = false;
      this.log(`rom:watchdog:feed:failed${diagnosticDetail({
        reason,
        error: error.message,
      })}`);
    }
  }
}
