/**
 * Firmware update helpers for EP01 devices.
 *
 * The browser SDK cannot enumerate USB serial numbers the way the native
 * SDKs do, so `macAddress()` returns `null`. Everything else is aligned with
 * the native flow: discover a target, inspect available versions, then flash.
 */

import { Runtime, UsbEnvironment } from './device.js';
import { compareVersions } from './message.js';
import {
  DEFAULT_FLASH_SIZE,
  DEFAULT_FLASH_BAUDRATE,
  DEFAULT_INITIAL_BAUDRATE,
  ESPFlasher,
  FlashProgressTracker,
  isSerialDisconnectError,
} from './esp-flasher.js';

export const DEFAULT_FIRMWARE_BASE_URL = 'https://firmware.enody.lighting';

function joinUrl(baseUrl, ...parts) {
  const trimmed = String(baseUrl).replace(/\/+$/, '');
  return `${trimmed}/${parts.map((part) => String(part).replace(/^\/+|\/+$/g, '')).join('/')}`;
}

function sortVersionStrings(versions) {
  return [...versions].sort((left, right) => {
    try {
      return compareVersions(right, left);
    } catch (error) {
      return String(right).localeCompare(String(left));
    }
  });
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error(reason === undefined ? 'Operation aborted' : String(reason));
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function wait(milliseconds, signal = null) {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }

  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      signal?.removeEventListener?.('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };

    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
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

function diagnosticLog(onLog, message, detail = undefined) {
  onLog?.(`sdk:update:${message}${diagnosticDetail(detail)}`);
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

function summarizePayloads(payloads) {
  return payloads.map((payload, index) => ({
    index,
    address: `0x${payload.address.toString(16)}`,
    byteLength: payload.data.length,
  }));
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

function serialEventSupported(serial, type) {
  return Boolean(serialEventTarget(serial) && type);
}

function waitForSerialEvent(serial, type, options = {}) {
  const target = serialEventTarget(serial);
  if (!target || !type) {
    return Promise.resolve(null);
  }

  if (options.signal?.aborted) {
    return Promise.reject(abortError(options.signal));
  }

  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      target.removeEventListener(type, onEvent);
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      options.signal?.removeEventListener?.('abort', onAbort);
    };

    const onEvent = (event) => {
      cleanup();
      resolve(event);
    };

    const onAbort = () => {
      cleanup();
      reject(abortError(options.signal));
    };

    target.addEventListener(type, onEvent);
    options.signal?.addEventListener?.('abort', onAbort, { once: true });

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for WebSerial ${type} event`));
      }, options.timeoutMs);
    }
  });
}

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function downloadPayload(hostId, payload, baseUrl, fetchImpl, onLog = null, signal = null) {
  throwIfAborted(signal);
  onLog?.(`Downloading ${payload.data} (${payload.length} bytes)...`);
  const response = await fetchImpl(joinUrl(baseUrl, hostId, payload.data), signal ? { signal } : undefined);
  throwIfAborted(signal);
  if (!response.ok) {
    throw new Error(`Failed to download payload ${payload.data}`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  throwIfAborted(signal);
  if (typeof payload.length === 'number' && data.length !== payload.length) {
    throw new Error(
      `Payload ${payload.data} size mismatch: expected ${payload.length} bytes, got ${data.length}`,
    );
  }

  if (payload.sha256) {
    const digest = await sha256Hex(data);
    if (digest !== payload.sha256) {
      throw new Error(`Payload ${payload.data} failed SHA-256 verification`);
    }
    onLog?.(`Verified ${payload.data}`);
  }

  return data;
}

function assertManifestPayload(payload, version, index) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Firmware version ${version} payload ${index + 1} is invalid`);
  }

  if (!Number.isInteger(payload.offset) || payload.offset < 0) {
    throw new Error(`Firmware version ${version} payload ${index + 1} is missing a valid flash offset`);
  }

  if (typeof payload.data !== 'string' || payload.data.length === 0) {
    throw new Error(`Firmware version ${version} payload ${index + 1} is missing a data path`);
  }

  return payload;
}

function manifestPayloads(entry) {
  const payloads = entry?.payload;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new Error(`Firmware version ${entry?.version ?? '(unknown)'} has no payload components`);
  }

  return payloads.map((payload, index) => assertManifestPayload(payload, entry.version, index));
}

function toUint8Array(image) {
  if (image instanceof Uint8Array) {
    return image;
  }

  if (image instanceof ArrayBuffer) {
    return new Uint8Array(image);
  }

  throw new Error('Firmware image must be a Uint8Array or ArrayBuffer');
}

export class UpdateTarget {
  static async discover(options = {}) {
    if (options.requestPort) {
      const environment = new UsbEnvironment(options);
      const requestOptions = {
        filters: environment.options.filters,
        path: options.path,
      };

      const selectedPort = await environment.serial.requestPort(requestOptions);
      return [await UpdateTarget.fromPort(selectedPort, options)];
    }

    const environment = new UsbEnvironment(options);
    const runtimes = await environment.runtimes(options);
    const targets = [];

    for (const runtime of runtimes) {
      targets.push(await UpdateTarget.fromRuntime(runtime, options));
    }

    return targets;
  }

  static async fromRuntime(runtime, options = {}) {
    const host = await runtime.host();
    return new UpdateTarget({
      runtime,
      host,
      port: runtime.transport.port,
      baseUrl: options.baseUrl ?? DEFAULT_FIRMWARE_BASE_URL,
      fetchImpl: options.fetch ?? fetch.bind(globalThis),
      filters: runtime.transport.filters,
      path: runtime.transport.port?.path,
      serial: runtime.transport.serial,
      flasherFactory: options.flasherFactory,
    });
  }

  static async fromPort(port, options = {}) {
    const runtime = await Runtime.connect(port, options);
    return UpdateTarget.fromRuntime(runtime, options);
  }

  static fromRecoveryPort(port, options = {}) {
    if (!options.hostIdentifier) {
      throw new Error('fromRecoveryPort requires options.hostIdentifier');
    }

    const environment = new UsbEnvironment(options);
    return new UpdateTarget({
      port,
      baseUrl: options.baseUrl ?? DEFAULT_FIRMWARE_BASE_URL,
      fetchImpl: options.fetch ?? fetch.bind(globalThis),
      filters: environment.options.filters,
      path: options.path ?? port?.path,
      serial: environment.serial,
      flasherFactory: options.flasherFactory,
      hostIdentifier: options.hostIdentifier,
      hostVersion: options.hostVersion ?? null,
    });
  }

  constructor(options) {
    this.runtime = options.runtime ?? null;
    this.host = options.host ?? null;
    this.hostIdentifier = options.hostIdentifier ?? null;
    this.hostVersion = options.hostVersion ?? null;
    this.port = options.port ?? null;
    this.baseUrl = options.baseUrl ?? DEFAULT_FIRMWARE_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.filters = options.filters ?? [];
    this.path = options.path ?? this.port?.path ?? null;
    this.serial = options.serial ?? null;
    this.flasherFactory = options.flasherFactory
      ?? ((port, flasherOptions) => new ESPFlasher(port, flasherOptions));
    this._manifest = null;
  }

  identifier() {
    return this.host?.identifier() ?? this.hostIdentifier ?? null;
  }

  version() {
    return this.host?.version() ?? this.hostVersion ?? null;
  }

  macAddress() {
    return null;
  }

  async firmwareVersions() {
    if (this._manifest) {
      return this._manifest;
    }

    if (!this.identifier()) {
      throw new Error('No host identifier is available for firmware manifest lookup');
    }

    const response = await this.fetchImpl(joinUrl(this.baseUrl, this.identifier(), 'firmware.json'));
    if (!response.ok) {
      throw new Error(`Failed to fetch firmware manifest for ${this.identifier()}`);
    }

    const manifest = await response.json();
    manifest.sort((left, right) => {
      try {
        return compareVersions(right.version, left.version);
      } catch (error) {
        return String(right.version).localeCompare(String(left.version));
      }
    });
    this._manifest = manifest;
    return manifest;
  }

  async availableFirmware() {
    return sortVersionStrings((await this.firmwareVersions()).map((entry) => entry.version));
  }

  async updateAvailable() {
    const current = this.version();
    const versions = await this.availableFirmware();
    if (!current) {
      return versions.length > 0;
    }
    return versions.some((version) => compareVersions(version, current) > 0);
  }

  async downloadFirmwarePayloads(version, options = {}) {
    throwIfAborted(options.signal);
    const selected = (await this.firmwareVersions()).find((entry) => entry.version === version);
    if (!selected) {
      throw new Error(`Version ${version} not found`);
    }

    const payloads = [];
    for (const payload of manifestPayloads(selected)) {
      payloads.push({
        address: payload.offset,
        data: await downloadPayload(
          this.identifier(),
          payload,
          this.baseUrl,
          this.fetchImpl,
          options.onLog,
          options.signal,
        ),
      });
      throwIfAborted(options.signal);
    }

    return payloads;
  }

  async flashFirmwareImage(image, options = {}) {
    if (!Number.isInteger(options.offset) || options.offset < 0) {
      throw new Error('flashFirmwareImage requires options.offset; manifest updates should use updateDevice()');
    }

    const payload = {
      address: options.offset,
      data: toUint8Array(image),
    };
    await this.flashPayloads([payload], options);
  }

  async refreshPort(options = {}) {
    throwIfAborted(options.signal);

    if (!this.port) {
      throw new Error('No serial port is associated with this update target');
    }

    if (!this.serial?.getPorts) {
      diagnosticLog(options.onLog, 'refresh-port:skipped', {
        hasSerialGetPorts: Boolean(this.serial?.getPorts),
        port: summarizePort(this.port),
      });
      return this.port;
    }

    const attempts = options.attempts ?? 8;
    const intervalMs = options.intervalMs ?? 500;
    let lastPorts = [];

    diagnosticLog(options.onLog, 'refresh-port:start', {
      attempts,
      intervalMs,
      currentPort: summarizePort(this.port),
      filters: options.filters ?? this.filters,
      path: options.path ?? this.path,
    });

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfAborted(options.signal);
      const ports = await this.serial.getPorts({
        filters: options.filters ?? this.filters,
        path: options.path ?? this.path,
      });
      throwIfAborted(options.signal);
      lastPorts = ports;

      const matchingPorts = ports.filter((port) => serialPortsMatch(port, this.port));
      const refreshed = matchingPorts.find((port) => port !== this.port)
        ?? (ports.length === 1 ? ports[0] : null)
        ?? matchingPorts[0]
        ?? null;

      diagnosticLog(options.onLog, 'refresh-port:attempt', {
        attempt,
        portCount: ports.length,
        matchingCount: matchingPorts.length,
        selected: refreshed ? summarizePort(refreshed) : null,
        ports: ports.map(summarizePort),
      });

      if (refreshed) {
        if (refreshed !== this.port) {
          options.onLog?.('Serial port refreshed after device reset.');
        }
        this.port = refreshed;
        diagnosticLog(options.onLog, 'refresh-port:complete', {
          attempt,
          refreshed: true,
          port: summarizePort(this.port),
        });
        return this.port;
      }

      if (attempt < attempts) {
        await wait(intervalMs, options.signal);
      }
    }

    if (lastPorts.length === 0) {
      diagnosticLog(options.onLog, 'refresh-port:failed-no-ports');
      throw new Error('The EP01 serial port is not available after reset');
    }

    diagnosticLog(options.onLog, 'refresh-port:complete', {
      refreshed: false,
      port: summarizePort(this.port),
      lastPorts: lastPorts.map(summarizePort),
    });
    return this.port;
  }

  async _disconnectRuntimeForBootloader(options, reason) {
    throwIfAborted(options.signal);

    if (this.runtime?.isConnected()) {
      options.onLog?.(`Closing runtime connection before ${reason}...`);
      await this.runtime.disconnect();
      throwIfAborted(options.signal);
      options.onLog?.('Runtime connection closed.');
      diagnosticLog(options.onLog, 'runtime-disconnected', {
        reason,
        port: summarizePort(this.port),
      });
    }
  }

  async _newFlasherSession(options = {}) {
    throwIfAborted(options.signal);

    if (!this.port) {
      throw new Error('No serial port is associated with this update target');
    }

    await this.refreshPort({
      onLog: options.onLog,
      attempts: options.refreshAttempts,
      intervalMs: options.refreshIntervalMs,
      filters: options.filters,
      path: options.path,
      signal: options.signal,
    });
    throwIfAborted(options.signal);

    return this.flasherFactory(this.port, {
      log: options.onLog,
      ESPLoader: options.ESPLoader,
      Transport: options.Transport,
      serial: serialEventTarget(this.serial) ?? this.serial,
    });
  }

  async _connectFlasher(flasher, options = {}, phase = 'rom') {
    throwIfAborted(options.signal);

    diagnosticLog(options.onLog, `${phase}-connect:start`, {
      port: summarizePort(this.port),
      baudrate: options.baudrate ?? DEFAULT_INITIAL_BAUDRATE,
      flashBaudrate: options.flashBaudrate ?? DEFAULT_FLASH_BAUDRATE,
      flashSize: options.flashSize ?? DEFAULT_FLASH_SIZE,
    });

    await flasher.connect(options.baudrate ?? DEFAULT_INITIAL_BAUDRATE, {
      flashBaudrate: options.flashBaudrate ?? DEFAULT_FLASH_BAUDRATE,
      connectAttempts: options.connectAttempts,
      resetMode: options.resetMode,
      debugLogging: options.debugLogging,
      tracing: options.tracing,
      serialOptions: options.serialOptions,
      resetConstructors: options.resetConstructors,
      signal: options.signal,
    });
    throwIfAborted(options.signal);

    diagnosticLog(options.onLog, `${phase}-connect:complete`, {
      port: summarizePort(this.port),
    });
  }

  async flashPayloads(payloads, options = {}) {
    throwIfAborted(options.signal);

    if (!this.port) {
      throw new Error('No serial port is associated with this update target');
    }

    const progressTracker = options.progressTracker ?? new FlashProgressTracker(payloads);
    const maxBootSessions = options.maxBootSessions ?? 12;

    diagnosticLog(options.onLog, 'flash-payloads:start', {
      payloads: summarizePayloads(payloads),
      port: summarizePort(this.port),
      runtimeConnected: Boolean(this.runtime?.isConnected?.()),
      baudrate: options.baudrate ?? DEFAULT_INITIAL_BAUDRATE,
      flashBaudrate: options.flashBaudrate ?? DEFAULT_FLASH_BAUDRATE,
      flashSize: options.flashSize ?? DEFAULT_FLASH_SIZE,
      maxBootSessions,
    });

    await this._disconnectRuntimeForBootloader(options, 'entering ROM bootloader');

    for (let bootSession = 1; bootSession <= maxBootSessions; bootSession += 1) {
      throwIfAborted(options.signal);
      const flasher = await this._newFlasherSession(options);
      let reconnectPromise = null;

      try {
        options.onLog?.(`Connecting to ROM bootloader (session ${bootSession}/${maxBootSessions})...`);
        await this._connectFlasher(flasher, options, 'rom');
        diagnosticLog(options.onLog, 'rom-flash:start', {
          bootSession,
          maxBootSessions,
          payloads: summarizePayloads(payloads),
          progress: progressTracker.summary(),
        });
        await flasher.flash(payloads, options.onProgress, {
          flashMode: options.flashMode,
          flashFreq: options.flashFreq,
          flashSize: typeof options.flashSize === 'string' ? options.flashSize : options.flashSizeName,
          progressTracker,
          signal: options.signal,
        });
        throwIfAborted(options.signal);
        diagnosticLog(options.onLog, 'rom-flash:complete', {
          bootSession,
          progress: progressTracker.summary(),
        });
        diagnosticLog(options.onLog, 'rom-reboot:start');
        throwIfAborted(options.signal);
        await flasher.reboot(options.signal);
        throwIfAborted(options.signal);
        diagnosticLog(options.onLog, 'rom-reboot:complete');
        return;
      } catch (error) {
        if (options.signal?.aborted) {
          throw abortError(options.signal);
        }

        if (!isSerialDisconnectError(error)) {
          throw error;
        }

        diagnosticLog(options.onLog, 'flash-payloads:disconnect-detected', {
          bootSession,
          maxBootSessions,
          error: error.message,
          port: summarizePort(this.port),
          progress: progressTracker.summary(),
        });

        if (bootSession >= maxBootSessions) {
          throw error;
        }

        reconnectPromise = this._waitForFlashingReconnect({
          ...options,
          bootSession,
          maxBootSessions,
          progressTracker,
        });
      } finally {
        diagnosticLog(options.onLog, 'flasher-disconnect:start', {
          bootSession,
          port: summarizePort(this.port),
        });
        await flasher.disconnect();
        diagnosticLog(options.onLog, 'flasher-disconnect:complete', {
          bootSession,
          port: summarizePort(this.port),
        });
      }

      if (reconnectPromise) {
        await reconnectPromise;
        throwIfAborted(options.signal);
      }
    }
  }

  async _waitForFlashingReconnect(options = {}) {
    const timeoutMs = options.reconnectTimeoutMs ?? 30000;

    if (serialEventSupported(this.serial, 'connect')) {
      diagnosticLog(options.onLog, 'serial-reconnect:wait-connect-event', {
        bootSession: options.bootSession,
        maxBootSessions: options.maxBootSessions,
        timeoutMs,
        progress: options.progressTracker?.summary?.() ?? null,
      });
      const event = await waitForSerialEvent(this.serial, 'connect', {
        timeoutMs,
        signal: options.signal,
      });
      throwIfAborted(options.signal);
      if (event?.target) {
        this.port = event.target;
        diagnosticLog(options.onLog, 'serial-reconnect:connect-event', {
          bootSession: options.bootSession,
          port: summarizePort(this.port),
        });
        return this.port;
      }
    }

    diagnosticLog(options.onLog, 'serial-reconnect:refresh-fallback', {
      bootSession: options.bootSession,
      hasSerialEvents: serialEventSupported(this.serial, 'connect'),
    });
    return this.refreshPort({
      onLog: options.onLog,
      attempts: options.refreshAttempts,
      intervalMs: options.refreshIntervalMs,
      filters: options.filters,
      path: options.path,
      signal: options.signal,
    });
  }

  async rebootDevice(options = {}) {
    throwIfAborted(options.signal);

    if (!this.port) {
      throw new Error('No serial port is associated with this update target');
    }

    diagnosticLog(options.onLog, 'reboot-device:start', {
      port: summarizePort(this.port),
      runtimeConnected: Boolean(this.runtime?.isConnected?.()),
    });

    await this._disconnectRuntimeForBootloader(options, 'recovery reboot');

    const flasher = await this._newFlasherSession(options);

    try {
      options.onLog?.('Connecting to ROM bootloader for recovery reboot...');
      await this._connectFlasher(flasher, options, 'recovery-rom');
      diagnosticLog(options.onLog, 'recovery-rom-reboot:start');
      throwIfAborted(options.signal);
      await flasher.reboot(options.signal);
      throwIfAborted(options.signal);
      diagnosticLog(options.onLog, 'recovery-rom-reboot:complete');
    } finally {
      diagnosticLog(options.onLog, 'recovery-flasher-disconnect:start', {
        port: summarizePort(this.port),
      });
      await flasher.disconnect();
      diagnosticLog(options.onLog, 'recovery-flasher-disconnect:complete', {
        port: summarizePort(this.port),
      });
    }
  }

  async recoverBootloader(options = {}) {
    throwIfAborted(options.signal);

    if (!this.port) {
      throw new Error('No serial port is associated with this update target');
    }

    diagnosticLog(options.onLog, 'recover-bootloader:start', {
      port: summarizePort(this.port),
      runtimeConnected: Boolean(this.runtime?.isConnected?.()),
    });

    await this._disconnectRuntimeForBootloader(options, 'recovery reset');

    const flasher = await this._newFlasherSession(options);

    try {
      options.onLog?.('Resetting into ROM bootloader for recovery...');
      await this._connectFlasher(flasher, options, 'recovery-bootloader');
    } finally {
      diagnosticLog(options.onLog, 'recovery-bootloader-disconnect:start', {
        port: summarizePort(this.port),
      });
      await flasher.disconnect();
      diagnosticLog(options.onLog, 'recovery-bootloader-disconnect:complete', {
        port: summarizePort(this.port),
      });
    }
  }

  async rebootDevice(options = {}) {
    if (!this.port) {
      throw new Error('No serial port is associated with this update target');
    }

    if (this.runtime?.isConnected()) {
      options.onLog?.('Closing runtime connection before recovery reboot...');
      await this.runtime.disconnect();
      options.onLog?.('Runtime connection closed.');
    }

    const flasher = new ESPFlasher(this.port, {
      log: options.onLog,
    });

    try {
      options.onLog?.('Connecting to ROM bootloader for recovery reboot...');
      await flasher.connect(options.baudrate);
      await flasher.reboot();
    } finally {
      await flasher.disconnect();
    }
  }

  async updateDevice(version, options = {}) {
    throwIfAborted(options.signal);

    diagnosticLog(options.onLog, 'update-device:start', {
      version,
      currentVersion: this.version()?.toString?.() ?? null,
      hostIdentifier: this.identifier(),
      port: summarizePort(this.port),
    });
    const payloads = await this.downloadFirmwarePayloads(version, options);
    throwIfAborted(options.signal);
    diagnosticLog(options.onLog, 'update-device:payloads-downloaded', {
      version,
      payloads: summarizePayloads(payloads),
    });
    await this.flashPayloads(payloads, options);
    throwIfAborted(options.signal);

    if (options.verify) {
      await this.verifyUpdatedHost({
        expectedVersion: version,
        timeoutMs: options.timeoutMs,
        intervalMs: options.intervalMs,
        onLog: options.onLog,
        signal: options.signal,
      });
    }
    throwIfAborted(options.signal);
    diagnosticLog(options.onLog, 'update-device:complete', { version });
  }

  async verifyUpdatedHost(options = {}) {
    throwIfAborted(options.signal);

    if (!this.port) {
      throw new Error('No serial port is associated with this update target');
    }

    const deadline = Date.now() + (options.timeoutMs ?? 30000);
    const intervalMs = options.intervalMs ?? 3000;
    let attempt = 0;

    diagnosticLog(options.onLog, 'verify:start', {
      expectedVersion: options.expectedVersion,
      timeoutMs: options.timeoutMs ?? 30000,
      intervalMs,
      port: summarizePort(this.port),
    });

    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      attempt += 1;
      try {
        await this.refreshPort({
          onLog: options.onLog,
          attempts: options.refreshAttempts ?? 2,
          intervalMs: options.refreshIntervalMs ?? 500,
          signal: options.signal,
        });
        throwIfAborted(options.signal);
        diagnosticLog(options.onLog, 'verify:attempt:start', {
          attempt,
          port: summarizePort(this.port),
        });

        const runtime = await Runtime.connect(this.port);
        throwIfAborted(options.signal);
        const host = await runtime.host();
        throwIfAborted(options.signal);
        const sameIdentifier = host.identifier() === this.identifier();
        const versionMatches = !options.expectedVersion
          || host.version().toString() === String(options.expectedVersion);

        diagnosticLog(options.onLog, 'verify:attempt:host', {
          attempt,
          hostIdentifier: host.identifier(),
          expectedIdentifier: this.identifier(),
          hostVersion: host.version().toString(),
          expectedVersion: options.expectedVersion ?? null,
          sameIdentifier,
          versionMatches,
        });

        if (sameIdentifier && versionMatches) {
          this.runtime = runtime;
          this.host = host;
          diagnosticLog(options.onLog, 'verify:complete', {
            attempt,
            hostIdentifier: host.identifier(),
            hostVersion: host.version().toString(),
          });
          return host;
        }

        await runtime.disconnect();
      } catch (error) {
        // The device may still be rebooting or re-enumerating.
        diagnosticLog(options.onLog, 'verify:attempt:failed', {
          attempt,
          error: error.message,
          port: summarizePort(this.port),
        });
      }

      await wait(intervalMs, options.signal);
    }

    diagnosticLog(options.onLog, 'verify:failed-timeout', {
      attempts: attempt,
      timeoutMs: options.timeoutMs ?? 30000,
    });
    throw new Error('Timed out waiting for update verification');
  }
}
