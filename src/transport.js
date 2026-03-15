/**
 * WebSerial transport layer for Enody devices.
 *
 * Handles serial port connection, frame-level read/write, and
 * request/response correlation via UUID identifiers.
 */

import { FrameAccumulator } from './framing.js';
import { buildCommandMessage, decodeMessage } from './message.js';
import { uuidToString } from './postcard.js';

export const EP01_USB_FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 };
const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_RESPONSE_TIMEOUT_MS = 500;

function resolveSerialProvider(serialOverride) {
  if (serialOverride) {
    return serialOverride;
  }

  if (typeof navigator !== 'undefined' && navigator.serial) {
    return navigator.serial;
  }

  return null;
}

export class EnodyTransport {
  constructor(options = {}) {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.accumulator = new FrameAccumulator();
    this.pendingRequests = new Map(); // uuid string -> { resolve, reject, timer }
    this.eventListeners = [];
    this._readLoopRunning = false;
    this._closing = false;
    this.serial = resolveSerialProvider(options.serial);
    this.filters = options.filters ?? [EP01_USB_FILTER];
    this.baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  }

  /** Request a WebSerial port and open connection to an EP01 device. */
  async connect(existingPort = null, options = {}) {
    if (this.port) throw new Error('Already connected');

    if (existingPort) {
      this.port = existingPort;
    } else {
      if (!this.serial) {
        throw new Error('WebSerial is not available in this environment');
      }

      const requestOptions = {};
      if (this.filters.length > 0) {
        requestOptions.filters = this.filters;
      }

      this.port = await this.serial.requestPort(requestOptions);
    }

    await this.port.open({
      baudRate: options.baudRate ?? this.baudRate,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: 'none',
    });

    // Clear DTR/RTS to prevent ESP32-C6 from entering download mode.
    // The Rust driver does the same initialization sequence.
    await this.port.setSignals({
      dataTerminalReady: false,
      requestToSend: false,
    });

    // Small delay matching the Rust driver's 100ms settle time.
    await new Promise(r => setTimeout(r, 100));

    this.writer = this.port.writable.getWriter();
    this._startReadLoop();
  }

  /** Close the serial port connection. */
  async disconnect() {
    this._closing = true;
    this._readLoopRunning = false;

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();

    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
        this.reader = null;
      }
    } catch (e) { /* ignore */ }

    try {
      if (this.writer) {
        this.writer.releaseLock();
        this.writer = null;
      }
    } catch (e) { /* ignore */ }

    try {
      if (this.port) {
        await this.port.close();
      }
    } catch (e) { /* ignore */ }

    this.port = null;
    this._closing = false;
  }

  get connected() {
    return this.port !== null && !this._closing;
  }

  /** Register a listener for unsolicited events (e.g., runtime logs). */
  onEvent(listener) {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter(l => l !== listener);
    };
  }

  /**
   * Send a command and wait for a correlated response.
   * @param {Uint8Array} commandBytes - Encoded command (from Commands.*)
   * @param {Uint8Array|null} resource - 16-byte UUID of target resource, or null
   * @param {Uint8Array|null} context - 16-byte UUID of parent command, or null
   * @returns {Promise<object>} Decoded event message
   */
  async sendCommand(commandBytes, resource = null, context = null) {
    if (!this.connected) throw new Error('Not connected');

    const { identifier, data } = buildCommandMessage(commandBytes, resource, context);
    const idStr = uuidToString(identifier);

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(idStr);
        reject(new Error(`Command timeout (${this.responseTimeoutMs}ms)`));
      }, this.responseTimeoutMs);
      this.pendingRequests.set(idStr, { resolve, reject, timer });
    });

    await this.writer.write(data);
    return promise;
  }

  /** Start the background read loop that processes incoming serial data. */
  _startReadLoop() {
    this._readLoopRunning = true;
    this.reader = this.port.readable.getReader();

    const loop = async () => {
      try {
        while (this._readLoopRunning) {
          const { value, done } = await this.reader.read();
          if (done || !this._readLoopRunning) break;

          const frames = this.accumulator.feed(value);
          for (const frame of frames) {
            this._handleFrame(frame);
          }
        }
      } catch (err) {
        if (!this._closing) {
          console.error('Read loop error:', err);
          for (const listener of this.eventListeners) {
            try { listener({ type: 'transportError', error: err }); } catch (e) { /* ignore */ }
          }
        }
      }
    };

    loop();
  }

  /** Handle a complete received frame. */
  _handleFrame(frameData) {
    let msg;
    try {
      msg = decodeMessage(frameData);
    } catch (err) {
      console.warn('Failed to decode message:', err, frameData);
      return;
    }

    if (msg.type !== 'event') return;

    // Check if this is a response to a pending command
    if (msg.context) {
      const ctxStr = uuidToString(msg.context);
      const pending = this.pendingRequests.get(ctxStr);
      if (pending) {
        this.pendingRequests.delete(ctxStr);
        clearTimeout(pending.timer);

        if (msg.event.type === 'error') {
          pending.reject(new Error(`Device error: ${JSON.stringify(msg.event.error)}`));
        } else {
          pending.resolve(msg);
        }
        return;
      }
    }

    // Unsolicited event (e.g., log messages) - notify listeners
    for (const listener of this.eventListeners) {
      try { listener(msg); } catch (e) { /* ignore listener errors */ }
    }
  }
}
