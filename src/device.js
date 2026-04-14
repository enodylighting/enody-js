/**
 * High-level Enody device API.
 *
 * The public hierarchy mirrors the native SDKs:
 *   UsbEnvironment -> Runtime -> Host -> Fixture -> Source -> Emitter
 *
 * A small `EnodyDevice` compatibility wrapper is still exported for the
 * existing demo applications, but new integrations should prefer
 * `UsbEnvironment` and `Runtime`.
 */

import {
  Commands,
  Configuration,
  Flux,
} from './message.js';
import { uuidToString } from './postcard.js';
import { EnodyTransport, EP01_USB_FILTER } from './transport.js';
import { SpectralData } from './colorimetry.js';
import { getDefaultSerialProvider } from './serial-provider-registry.js';

const SPECTRAL_BATCH_SIZE = 32;

function defaultLogListener(logEvent) {
  const level = (logEvent.levelName || 'info').toLowerCase();
  const logger = console[level] ?? console.log;
  logger.call(console, logEvent.output);
}

function normalizeFlux(flux) {
  if (typeof flux === 'number') {
    return Flux.relative(flux);
  }
  return flux;
}

function normalizeIdentifier(identifier) {
  if (!identifier) {
    return null;
  }

  return typeof identifier === 'string' ? identifier : uuidToString(identifier);
}

function unreachableResource(methodName) {
  throw new Error(`${methodName} requires a device-backed resource`);
}

function resolveSerialProvider(serialOverride) {
  if (serialOverride) {
    return serialOverride;
  }

  const defaultProvider = getDefaultSerialProvider();
  if (defaultProvider) {
    return defaultProvider;
  }

  throw new Error('WebSerial is not available in this environment');
}

export class UsbEnvironment {
  constructor(options = {}) {
    this.options = {
      ...options,
      filters: options.filters ?? [EP01_USB_FILTER],
    };
    this.serial = resolveSerialProvider(options.serial);
    this._runtimes = [];
  }

  /**
   * Discover runtimes that the browser is allowed to talk to.
   *
   * If the page has not been granted access to any ports yet, this will prompt
   * the user to pick one when `requestPort` is true.
   */
  async runtimes(options = {}) {
    const portQuery = {
      filters: options.filters ?? this.options.filters,
      path: options.path,
    };
    const ports = options.ports ? [...options.ports] : await this.serial.getPorts(portQuery);
    const requestPort = options.requestPort ?? ports.length === 0;

    if (requestPort) {
      const requestOptions = {
        filters: options.filters ?? this.options.filters,
        path: options.path,
      };
      ports.push(await this.serial.requestPort(requestOptions));
    }

    const uniquePorts = Array.from(new Set(ports));
    this._runtimes = [];

    for (const port of uniquePorts) {
      this._runtimes.push(await Runtime.connect(port, this.options));
    }

    return this._runtimes;
  }

  async disconnect() {
    await Promise.allSettled(this._runtimes.map((runtime) => runtime.disconnect()));
    this._runtimes = [];
  }
}

export class Runtime {
  static async connect(existingPort = null, options = {}) {
    const transport = new EnodyTransport(options);
    await transport.connect(existingPort);

    let info = null;
    try {
      const infoMessage = await transport.sendCommand(Commands.runtimeInfo());
      info = infoMessage.event.event.data;
    } catch (error) {
      // Some older firmware builds may not answer Runtime::Info. Host access
      // still works, so we only treat this as missing metadata.
      info = null;
    }

    return new Runtime(transport, info);
  }

  constructor(transport, info = null) {
    this.transport = transport;
    this._info = info;
    this._host = null;
  }

  identifier() {
    return normalizeIdentifier(this._info?.identifier);
  }

  version() {
    return this._info?.version ?? null;
  }

  get versionString() {
    return this.version()?.toString?.() ?? '';
  }

  async host() {
    if (this._host) {
      return this._host;
    }

    let hostInfo = null;

    try {
      const message = await this.transport.sendCommand(Commands.runtimeHost());
      hostInfo = message.event.event.data;
    } catch (error) {
      // The existing EP01 firmware path used by the original JS SDK answers a
      // root Host::Info command even when Runtime::Host is unavailable.
      const fallbackMessage = await this.transport.sendCommand(Commands.hostInfo());
      hostInfo = fallbackMessage.event.event.data;
    }

    if (!this._info && hostInfo) {
      this._info = {
        identifier: hostInfo.identifier,
        version: hostInfo.version,
      };
    }

    this._host = new Host(this.transport, hostInfo);
    return this._host;
  }

  isConnected() {
    return this.transport.connected;
  }

  enableLogging(listener = defaultLogListener) {
    return this.transport.onEvent((message) => {
      if (message.event?.type === 'runtime' && message.event.event?.type === 'log') {
        listener(message.event.event.data);
      }
    });
  }

  onEvent(listener) {
    return this.transport.onEvent(listener);
  }

  async disconnect() {
    await this.transport.disconnect();
    this._host = null;
  }
}

export class Host {
  constructor(transport, info) {
    this.transport = transport;
    this.info = info;
    this._fixtures = null;
    this._resourceIdentifier = info.identifier;
  }

  identifier() {
    return normalizeIdentifier(this._resourceIdentifier);
  }

  version() {
    return this.info.version;
  }

  get versionString() {
    return this.version().toString();
  }

  get identifierString() {
    return this.identifier();
  }

  async fixtures() {
    if (this._fixtures) {
      return this._fixtures;
    }

    const countMessage = await this.transport.sendCommand(
      Commands.hostFixtureCount(),
      this._resourceIdentifier,
    );
    const count = countMessage.event.event.count;

    const fixtures = [];
    for (let index = 0; index < count; index += 1) {
      const infoMessage = await this.transport.sendCommand(
        Commands.hostFixtureInfo(index),
        this._resourceIdentifier,
      );
      fixtures.push(new Fixture({
        transport: this.transport,
        info: infoMessage.event.event.data,
      }));
    }

    this._fixtures = fixtures;
    return fixtures;
  }

  async getFixtures() {
    return this.fixtures();
  }
}

export class Fixture {
  static fromJson(jsonData) {
    const sources = jsonData.sources.map((source) => Source.fromJson(source));
    return new Fixture({
      identifier: jsonData.identifier,
      sources,
    });
  }

  constructor(options) {
    this.transport = options.transport ?? null;
    this.info = options.info ?? null;
    this._resourceIdentifier = options.info?.identifier ?? null;
    this._identifier = options.identifier ?? normalizeIdentifier(this._resourceIdentifier);
    this._sources = options.sources ?? null;
  }

  identifier() {
    return this._identifier ?? normalizeIdentifier(this._resourceIdentifier);
  }

  get identifierString() {
    return this.identifier();
  }

  async sources() {
    if (this._sources) {
      return this._sources;
    }

    if (!this.transport || !this._resourceIdentifier) {
      return unreachableResource('sources');
    }

    const countMessage = await this.transport.sendCommand(
      Commands.fixtureSourceCount(),
      this._resourceIdentifier,
    );
    const count = countMessage.event.event.count;

    const sources = [];
    for (let index = 0; index < count; index += 1) {
      const infoMessage = await this.transport.sendCommand(
        Commands.fixtureSourceInfo(index),
        this._resourceIdentifier,
      );
      sources.push(new Source({
        transport: this.transport,
        info: infoMessage.event.event.data,
        fixture: this,
      }));
    }

    this._sources = sources;
    return sources;
  }

  async getSources() {
    return this.sources();
  }

  async tensor() {
    const sources = await this.sources();
    return Promise.all(sources.map((source) => source.tensor()));
  }

  async display(config, flux) {
    if (!this.transport || !this._resourceIdentifier) {
      return unreachableResource('display');
    }

    await this.transport.sendCommand(
      Commands.fixtureDisplay(config, normalizeFlux(flux)),
      this._resourceIdentifier,
    );
  }

  async setCCT(kelvin, brightness = 1.0) {
    await this.display(Configuration.blackbody(kelvin), Flux.relative(brightness));
  }

  async setChromaticity(x, y, brightness = 1.0) {
    await this.display(Configuration.chromatic(x, y), Flux.relative(brightness));
  }

  async setManual(brightness = 1.0) {
    await this.display(Configuration.manual(), Flux.relative(brightness));
  }
}

export class Source {
  static fromJson(jsonData) {
    const emitters = jsonData.emitters.map((emitter) => Emitter.fromJson(emitter));
    return new Source({
      identifier: jsonData.identifier,
      emitters,
    });
  }

  constructor(options) {
    this.transport = options.transport ?? null;
    this.info = options.info ?? null;
    this.fixture = options.fixture ?? null;
    this._resourceIdentifier = options.info?.identifier ?? null;
    this._identifier = options.identifier ?? normalizeIdentifier(this._resourceIdentifier);
    this._emitters = options.emitters ?? null;
  }

  identifier() {
    return this._identifier ?? normalizeIdentifier(this._resourceIdentifier);
  }

  get identifierString() {
    return this.identifier();
  }

  async emitters() {
    if (this._emitters) {
      return this._emitters;
    }

    if (!this.transport || !this._resourceIdentifier) {
      return unreachableResource('emitters');
    }

    const countMessage = await this.transport.sendCommand(
      Commands.sourceEmitterCount(),
      this._resourceIdentifier,
    );
    const count = countMessage.event.event.count;

    const emitters = [];
    for (let index = 0; index < count; index += 1) {
      const infoMessage = await this.transport.sendCommand(
        Commands.sourceEmitterInfo(index),
        this._resourceIdentifier,
      );
      emitters.push(new Emitter({
        transport: this.transport,
        info: infoMessage.event.event.data,
        source: this,
      }));
    }

    this._emitters = emitters;
    return emitters;
  }

  async getEmitters() {
    return this.emitters();
  }

  async tensor() {
    const emitters = await this.emitters();
    return Promise.all(emitters.map((emitter) => emitter.tensor()));
  }

  async display(config, flux) {
    if (!this.transport || !this._resourceIdentifier) {
      return unreachableResource('display');
    }

    await this.transport.sendCommand(
      Commands.sourceDisplay(config, normalizeFlux(flux)),
      this._resourceIdentifier,
    );
  }
}

export class Emitter {
  static fromJson(jsonData) {
    return new Emitter({
      identifier: jsonData.identifier,
      spectralData: SpectralData.fromJson(jsonData.spectral_data, `Emitter ${jsonData.identifier}`),
    });
  }

  constructor(options) {
    this.transport = options.transport ?? null;
    this.info = options.info ?? null;
    this.source = options.source ?? null;
    this._resourceIdentifier = options.info?.identifier ?? null;
    this._identifier = options.identifier ?? normalizeIdentifier(this._resourceIdentifier);
    this._fluxRange = null;
    this._spectralData = options.spectralData ?? null;
  }

  identifier() {
    return this._identifier ?? normalizeIdentifier(this._resourceIdentifier);
  }

  get identifierString() {
    return this.identifier();
  }

  async fluxRange() {
    if (this._fluxRange) {
      return this._fluxRange;
    }

    if (!this.transport || !this._resourceIdentifier) {
      return unreachableResource('fluxRange');
    }

    const message = await this.transport.sendCommand(
      Commands.emitterFluxRange(),
      this._resourceIdentifier,
    );

    this._fluxRange = {
      min: message.event.event.min.value,
      max: message.event.event.max.value,
    };
    return this._fluxRange;
  }

  async getFluxRange() {
    return this.fluxRange();
  }

  async setFlux(value) {
    if (!this.transport || !this._resourceIdentifier) {
      return unreachableResource('setFlux');
    }

    const message = await this.transport.sendCommand(
      Commands.emitterFluxSet(normalizeFlux(value)),
      this._resourceIdentifier,
    );
    return message.event.event.flux.value;
  }

  async spectralSampleCount() {
    if (!this.transport || !this._resourceIdentifier) {
      if (this._spectralData) {
        return this._spectralData.sampleCount();
      }
      return unreachableResource('spectralSampleCount');
    }

    const message = await this.transport.sendCommand(
      Commands.emitterSpectralSampleCount(),
      this._resourceIdentifier,
    );
    return message.event.event.event.count;
  }

  async getSpectralSampleCount() {
    return this.spectralSampleCount();
  }

  async spectralDomain() {
    if (!this.transport || !this._resourceIdentifier) {
      const wavelengths = this._spectralData?.wavelengths() ?? [];
      return {
        min: wavelengths[0] ?? null,
        max: wavelengths[wavelengths.length - 1] ?? null,
      };
    }

    const message = await this.transport.sendCommand(
      Commands.emitterSpectralDomain(),
      this._resourceIdentifier,
    );
    return {
      min: message.event.event.event.min,
      max: message.event.event.event.max,
    };
  }

  async getSpectralDomain() {
    return this.spectralDomain();
  }

  async spectralData(onProgress = null) {
    if (this._spectralData) {
      return this._spectralData;
    }

    if (!this.transport || !this._resourceIdentifier) {
      return unreachableResource('spectralData');
    }

    const sampleCount = await this.spectralSampleCount();
    const samples = [];

    let offset = 0;
    while (offset < sampleCount) {
      const batchEnd = Math.min(offset + SPECTRAL_BATCH_SIZE, sampleCount);
      const message = await this.transport.sendCommand(
        Commands.emitterSpectralSampleBatch(offset, batchEnd),
        this._resourceIdentifier,
      );

      samples.push(...message.event.event.event.samples);
      offset = batchEnd;

      if (onProgress) {
        onProgress(offset, sampleCount);
      }
    }

    this._spectralData = new SpectralData(samples, `Emitter ${this.identifier()}`);
    return this._spectralData;
  }

  async getSpectralData(onProgress = null) {
    return (await this.spectralData(onProgress)).samples();
  }

  async tensor() {
    return (await this.spectralData()).tensor();
  }
}

/**
 * Backwards-compatible facade used by the existing demo application.
 *
 * New code should prefer `UsbEnvironment` + `Runtime`.
 */
export class EnodyDevice {
  constructor(options = {}) {
    this.options = options;
    this.runtime = null;
    this.host = null;
    this._pendingListeners = [];
  }

  async connect(existingPort = null) {
    this.runtime = await Runtime.connect(existingPort, this.options);
    for (const listener of this._pendingListeners) {
      this.runtime.onEvent(listener);
    }
    this.host = await this.runtime.host();
    return this.host;
  }

  async disconnect() {
    if (this.runtime) {
      await this.runtime.disconnect();
    }
    this.runtime = null;
    this.host = null;
  }

  get connected() {
    return this.runtime?.isConnected() ?? false;
  }

  get transport() {
    return this.runtime?.transport ?? null;
  }

  onEvent(listener) {
    if (!this.runtime) {
      this._pendingListeners.push(listener);
      return () => {
        this._pendingListeners = this._pendingListeners.filter((candidate) => candidate !== listener);
      };
    }
    return this.runtime.onEvent(listener);
  }
}
