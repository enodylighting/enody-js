/**
 * WebSerial transport layer for Enody devices.
 *
 * Handles serial port connection, frame-level read/write, and
 * request/response correlation via UUID identifiers.
 */

import { FrameAccumulator } from './framing.js';
import { buildCommandMessage, decodeMessage, describeCommand } from './message.js';
import { uuidToString } from './postcard.js';
import { getDefaultSerialProvider } from './serial-provider-registry.js';

export const EP01_USB_FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 };
const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_RESPONSE_TIMEOUT_MS = 2000;
const LOG_PREFIX = '[enody-sdk]';

function normalizeLogger(logger) {
  if (logger === true) {
    return console;
  }
  if (!logger) {
    return null;
  }
  if (typeof logger === 'function') {
    return { log: logger, warn: logger, error: logger };
  }
  return logger;
}

function emitLog(logger, level, message, detail = undefined) {
  if (!logger) {
    return;
  }

  const target = logger[level] ?? logger.log;
  if (typeof target !== 'function') {
    return;
  }

  if (detail === undefined) {
    target.call(logger, `${LOG_PREFIX} ${message}`);
    return;
  }
  target.call(logger, `${LOG_PREFIX} ${message}`, detail);
}

function logDeviceError(logger, level, detail) {
  if (level === 'silent') {
    return;
  }
  if (level === 'warn') {
    emitLog(logger, 'warn', 'command:device-error', detail);
    return;
  }
  if (level === 'log') {
    emitLog(logger, 'log', 'command:device-error', detail);
    return;
  }
  emitLog(logger, 'error', 'command:device-error', detail);
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

function bytesToHex(bytes, maxLength = 24) {
  const preview = Array.from(bytes.slice(0, maxLength))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join(' ');
  return bytes.length > maxLength ? `${preview} ...` : preview;
}

function summarizeForLog(value, depth = 0) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Uint8Array) {
    return {
      byteLength: value.length,
      previewHex: bytesToHex(value),
    };
  }

  if (Array.isArray(value)) {
    return {
      length: value.length,
      sample: value.slice(0, 4).map(item => summarizeForLog(item, depth + 1)),
    };
  }

  if (typeof value.toString === 'function' && value.constructor?.name === 'Version') {
    return value.toString();
  }

  if (depth >= 4) {
    return '[Object]';
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, summarizeForLog(entry, depth + 1)]),
  );
}

function summarizeMessage(message, frameData = null) {
  return {
    frameByteLength: frameData?.length ?? null,
    type: message.type,
    identifier: message.identifier ? uuidToString(message.identifier) : null,
    context: message.context ? uuidToString(message.context) : null,
    resource: message.resource ? uuidToString(message.resource) : null,
    event: summarizeForLog(message.event),
  };
}

function resolveSerialProvider(serialOverride) {
  if (serialOverride) {
    return serialOverride;
  }

  const defaultProvider = getDefaultSerialProvider();
  if (defaultProvider) {
    return defaultProvider;
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
    this.logger = normalizeLogger(options.logger ?? (options.debug ? console : null));
  }

  /** Request a WebSerial port and open connection to an EP01 device. */
  async connect(existingPort = null, options = {}) {
    if (this.port) throw new Error('Already connected');

    const baudRate = options.baudRate ?? this.baudRate;
    emitLog(this.logger, 'log', 'transport:connect:start', {
      hasExistingPort: Boolean(existingPort),
      filters: this.filters,
      baudRate,
    });

    if (existingPort) {
      this.port = existingPort;
      emitLog(this.logger, 'log', 'transport:connect:using-existing-port', summarizePort(this.port));
    } else {
      if (!this.serial) {
        throw new Error('WebSerial is not available in this environment');
      }

      const requestOptions = {};
      if (this.filters.length > 0) {
        requestOptions.filters = this.filters;
      }

      emitLog(this.logger, 'log', 'transport:connect:request-port', requestOptions);
      this.port = await this.serial.requestPort(requestOptions);
      emitLog(this.logger, 'log', 'transport:connect:port-selected', summarizePort(this.port));
    }

    emitLog(this.logger, 'log', 'transport:connect:open', { baudRate });
    await this.port.open({
      baudRate,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: 'none',
    });
    emitLog(this.logger, 'log', 'transport:connect:opened', summarizePort(this.port));

    // Clear DTR/RTS to prevent ESP32-C6 from entering download mode.
    // The Rust driver does the same initialization sequence.
    const signals = {
      dataTerminalReady: false,
      requestToSend: false,
    };
    emitLog(this.logger, 'log', 'transport:connect:set-signals', signals);
    await this.port.setSignals(signals);

    // Small delay matching the Rust driver's 100ms settle time.
    await new Promise(r => setTimeout(r, 100));
    emitLog(this.logger, 'log', 'transport:connect:settled');

    this.writer = this.port.writable.getWriter();
    this._startReadLoop();
    emitLog(this.logger, 'log', 'transport:connect:ready');
  }

  /** Close the serial port connection. */
  async disconnect() {
    emitLog(this.logger, 'log', 'transport:disconnect:start', {
      connected: this.connected,
      pendingRequests: this.pendingRequests.size,
    });
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
    emitLog(this.logger, 'log', 'transport:disconnect:complete');
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
   * @param {object} options - Per-command transport options.
   * @returns {Promise<object>} Decoded event message
   */
  async sendCommand(commandBytes, resource = null, context = null, options = {}) {
    if (!this.connected) throw new Error('Not connected');

    const { identifier, data } = buildCommandMessage(commandBytes, resource, context);
    const idStr = uuidToString(identifier);
    const command = describeCommand(commandBytes);
    const commandLog = {
      id: idStr,
      resource: resource ? uuidToString(resource) : null,
      context: context ? uuidToString(context) : null,
      command,
      frameByteLength: data.length,
    };

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(idStr);
        emitLog(this.logger, 'warn', 'command:timeout', {
          ...commandLog,
          timeoutMs: this.responseTimeoutMs,
        });
        const error = new Error(`Command timeout (${this.responseTimeoutMs}ms)`);
        error.code = 'ENODY_COMMAND_TIMEOUT';
        error.timeoutMs = this.responseTimeoutMs;
        error.command = command;
        error.commandLog = commandLog;
        reject(error);
      }, this.responseTimeoutMs);
      this.pendingRequests.set(idStr, {
        resolve,
        reject,
        timer,
        commandLog,
        deviceErrorLogLevel: options.deviceErrorLogLevel ?? 'error',
      });
    });

    emitLog(this.logger, 'log', 'command:send', commandLog);
    try {
      await this.writer.write(data);
      emitLog(this.logger, 'log', 'command:written', {
        id: idStr,
        command,
        pendingRequests: this.pendingRequests.size,
      });
    } catch (error) {
      const pending = this.pendingRequests.get(idStr);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(idStr);
      }
      emitLog(this.logger, 'error', 'command:write-failed', {
        ...commandLog,
        error,
      });
      throw error;
    }

    return promise;
  }

  /** Start the background read loop that processes incoming serial data. */
  _startReadLoop() {
    this._readLoopRunning = true;
    this.reader = this.port.readable.getReader();
    emitLog(this.logger, 'log', 'transport:read-loop:start');

    const loop = async () => {
      try {
        while (this._readLoopRunning) {
          const { value, done } = await this.reader.read();
          if (done || !this._readLoopRunning) break;

          const frames = this.accumulator.feed(value);
          if (frames.length > 0) {
            emitLog(this.logger, 'log', 'transport:read', {
              byteLength: value?.length ?? 0,
              frameCount: frames.length,
            });
          }
          for (const frame of frames) {
            this._handleFrame(frame);
          }
        }
      } catch (err) {
        if (!this._closing) {
          emitLog(this.logger, 'error', 'transport:read-loop:error', err);
          for (const listener of this.eventListeners) {
            try { listener({ type: 'transportError', error: err }); } catch (e) { /* ignore */ }
          }
        }
      } finally {
        emitLog(this.logger, 'log', 'transport:read-loop:stop');
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
      emitLog(this.logger, 'warn', 'message:decode-failed', {
        error: err,
        frameByteLength: frameData.length,
        framePreviewHex: bytesToHex(frameData),
      });
      return;
    }

    if (msg.type !== 'event') {
      emitLog(this.logger, 'log', 'message:ignored', summarizeMessage(msg, frameData));
      return;
    }

    const messageLog = summarizeMessage(msg, frameData);
    emitLog(this.logger, 'log', 'message:received', messageLog);

    // Check if this is a response to a pending command
    if (msg.context) {
      const ctxStr = uuidToString(msg.context);
      const pending = this.pendingRequests.get(ctxStr);
      if (pending) {
        this.pendingRequests.delete(ctxStr);
        clearTimeout(pending.timer);

        if (msg.event.type === 'error') {
          const detail = {
            ...pending.commandLog,
            response: messageLog,
          };
          logDeviceError(this.logger, pending.deviceErrorLogLevel, detail);

          const error = new Error(`Device error: ${JSON.stringify(msg.event.error)}`);
          error.deviceError = msg.event.error;
          error.command = pending.commandLog.command;
          pending.reject(error);
        } else {
          emitLog(this.logger, 'log', 'command:response', {
            ...pending.commandLog,
            response: messageLog,
          });
          pending.resolve(msg);
        }
        return;
      }

      emitLog(this.logger, 'warn', 'message:unmatched-context', messageLog);
    }

    // Unsolicited event (e.g., log messages) - notify listeners
    emitLog(this.logger, 'log', 'message:unsolicited', messageLog);
    for (const listener of this.eventListeners) {
      try { listener(msg); } catch (e) { /* ignore listener errors */ }
    }
  }
}
