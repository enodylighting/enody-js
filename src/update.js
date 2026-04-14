/**
 * Firmware update helpers for EP01 devices.
 *
 * The browser SDK cannot enumerate USB serial numbers the way the native
 * SDKs do, so `macAddress()` returns `null`. Everything else is aligned with
 * the native flow: discover a target, inspect available versions, then flash.
 */

import { Runtime, UsbEnvironment } from './device.js';
import { compareVersions } from './message.js';
import { ESPFlasher } from './esp-flasher.js';

export const DEFAULT_FIRMWARE_BASE_URL = 'https://firmware.enody.lighting';
export const FIRMWARE_FLASH_OFFSET = 0x00020000;

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

async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function downloadPayload(hostId, payload, baseUrl, fetchImpl, onLog = null) {
  onLog?.(`Downloading ${payload.data} (${payload.length} bytes)...`);
  const response = await fetchImpl(joinUrl(baseUrl, hostId, payload.data));
  if (!response.ok) {
    throw new Error(`Failed to download payload ${payload.data}`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
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
    });
  }

  static async fromPort(port, options = {}) {
    const runtime = await Runtime.connect(port, options);
    return UpdateTarget.fromRuntime(runtime, options);
  }

  constructor(options) {
    this.runtime = options.runtime ?? null;
    this.host = options.host ?? null;
    this.port = options.port ?? null;
    this.baseUrl = options.baseUrl ?? DEFAULT_FIRMWARE_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this._manifest = null;
  }

  identifier() {
    return this.host?.identifier() ?? null;
  }

  version() {
    return this.host?.version() ?? null;
  }

  macAddress() {
    return null;
  }

  async firmwareVersions() {
    if (this._manifest) {
      return this._manifest;
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
    const selected = (await this.firmwareVersions()).find((entry) => entry.version === version);
    if (!selected) {
      throw new Error(`Version ${version} not found`);
    }

    const payloads = [];
    for (const payload of selected.payload) {
      payloads.push({
        address: payload.offset,
        data: await downloadPayload(
          this.identifier(),
          payload,
          this.baseUrl,
          this.fetchImpl,
          options.onLog,
        ),
      });
    }

    return payloads;
  }

  async flashFirmwareImage(image, options = {}) {
    const payload = {
      address: options.offset ?? FIRMWARE_FLASH_OFFSET,
      data: toUint8Array(image),
    };
    await this.flashPayloads([payload], options);
  }

  async flashPayloads(payloads, options = {}) {
    if (!this.port) {
      throw new Error('No serial port is associated with this update target');
    }

    if (this.runtime?.isConnected()) {
      await this.runtime.disconnect();
    }

    const flasher = new ESPFlasher(this.port, {
      log: options.onLog,
    });

    options.onLog?.('Connecting to ROM bootloader...');
    await flasher.connect(options.baudrate);
    await flasher.flash(payloads, options.onProgress);
    await flasher.reboot();
    await flasher.disconnect();
  }

  async updateDevice(version, options = {}) {
    const payloads = await this.downloadFirmwarePayloads(version, options);
    await this.flashPayloads(payloads, options);

    if (options.verify) {
      await this.verifyUpdatedHost({
        expectedVersion: version,
        timeoutMs: options.timeoutMs,
        intervalMs: options.intervalMs,
      });
    }
  }

  async verifyUpdatedHost(options = {}) {
    if (!this.port) {
      throw new Error('No serial port is associated with this update target');
    }

    const deadline = Date.now() + (options.timeoutMs ?? 30000);
    const intervalMs = options.intervalMs ?? 3000;

    while (Date.now() < deadline) {
      try {
        const runtime = await Runtime.connect(this.port);
        const host = await runtime.host();
        const sameIdentifier = host.identifier() === this.identifier();
        const versionMatches = !options.expectedVersion
          || host.version().toString() === String(options.expectedVersion);

        if (sameIdentifier && versionMatches) {
          this.runtime = runtime;
          this.host = host;
          return host;
        }

        await runtime.disconnect();
      } catch (error) {
        // The device may still be rebooting or re-enumerating.
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error('Timed out waiting for update verification');
  }
}
