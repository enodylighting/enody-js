/**
 * Enody protocol message types and serialization.
 *
 * Mirrors the Rust enums/structs in enody-rs/src/message.rs exactly,
 * using postcard binary encoding with matching variant indices.
 */

import { PostcardEncoder, PostcardDecoder, uuidV4 } from './postcard.js';
import { frameBytes, unframeBytes } from './framing.js';

// --- Configuration types ---

export const ConfigurationType = {
  Flux: 0,
  Blackbody: 1,
  Chromatic: 2,
  Spectral: 3,
  Manual: 4,
};

export class Configuration {
  static flux() {
    return { type: ConfigurationType.Flux };
  }

  static blackbody(kelvin) {
    return { type: ConfigurationType.Blackbody, kelvin };
  }

  static chromatic(x, y = null) {
    if (typeof x === 'object' && x !== null) {
      return {
        type: ConfigurationType.Chromatic,
        x: x.x,
        y: x.y,
      };
    }

    return { type: ConfigurationType.Chromatic, x, y };
  }

  static spectral() {
    return { type: ConfigurationType.Spectral };
  }

  static manual() {
    return { type: ConfigurationType.Manual };
  }
}

export function encodeConfiguration(enc, config) {
  enc.enumVariant(config.type);
  switch (config.type) {
    case ConfigurationType.Blackbody:
      enc.f32(config.kelvin);
      break;
    case ConfigurationType.Chromatic:
      enc.f32(config.x);
      enc.f32(config.y);
      break;
    // Flux, Spectral, Manual have no payload
  }
}

export function decodeConfiguration(dec) {
  const type = dec.enumVariant();
  switch (type) {
    case ConfigurationType.Blackbody:
      return { type, kelvin: dec.f32() };
    case ConfigurationType.Chromatic:
      return { type, x: dec.f32(), y: dec.f32() };
    default:
      return { type };
  }
}

export function encodeConfigurationList(enc, configurations) {
  enc.varint(configurations.length);
  for (const configuration of configurations) {
    encodeConfiguration(enc, configuration);
  }
}

export function decodeConfigurationList(dec) {
  const count = dec.varint();
  const configurations = [];
  for (let index = 0; index < count; index += 1) {
    configurations.push(decodeConfiguration(dec));
  }
  return configurations;
}

// --- Flux ---

export const FluxType = { Relative: 0 };

export class Flux {
  static relative(value) {
    return { type: FluxType.Relative, value };
  }
}

export function encodeFlux(enc, flux) {
  enc.enumVariant(FluxType.Relative);
  enc.f32(flux.value);
}

export function decodeFlux(dec) {
  const variant = dec.enumVariant();
  if (variant === FluxType.Relative) {
    return { type: FluxType.Relative, value: dec.f32() };
  }
  throw new Error(`Unknown Flux variant: ${variant}`);
}

// --- Version ---

export class Version {
  constructor(major = 0, minor = 0, patch = 0) {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
  }

  static parse(value) {
    if (value instanceof Version) {
      return value;
    }

    if (typeof value === 'object' && value !== null) {
      return new Version(value.major ?? 0, value.minor ?? 0, value.patch ?? 0);
    }

    const parts = String(value).split('.');
    if (parts.length !== 3) {
      throw new Error(`Invalid version string: ${value}`);
    }

    return new Version(
      Number.parseInt(parts[0], 10),
      Number.parseInt(parts[1], 10),
      Number.parseInt(parts[2], 10),
    );
  }

  compare(other) {
    const candidate = Version.parse(other);

    if (this.major !== candidate.major) {
      return this.major - candidate.major;
    }
    if (this.minor !== candidate.minor) {
      return this.minor - candidate.minor;
    }
    return this.patch - candidate.patch;
  }

  toString() {
    return `${this.major}.${this.minor}.${this.patch}`;
  }
}

export function compareVersions(a, b) {
  return Version.parse(a).compare(b);
}

export function decodeVersion(dec) {
  return new Version(dec.u8(), dec.u8(), dec.u16());
}

// --- Info structs ---

export function decodeHostInfo(dec) {
  return {
    version: decodeVersion(dec),
    identifier: dec.uuid(),
  };
}

export function decodeFixtureInfo(dec) {
  return { identifier: dec.uuid() };
}

export function decodeSourceInfo(dec) {
  return { identifier: dec.uuid() };
}

export function decodeEmitterInfo(dec) {
  return { identifier: dec.uuid() };
}

export function decodeSpectralDataInfo(dec) {
  return { identifier: dec.uuid() };
}

export function decodeRuntimeInfo(dec) {
  return {
    version: decodeVersion(dec),
    identifier: dec.uuid(),
  };
}

export function decodeEnvironmentInfo(dec) {
  return { identifier: dec.uuid() };
}

// --- SpectralSample ---

export function decodeSpectralSample(dec) {
  return {
    wavelength: dec.f32(),
    measurement: dec.f32(),
  };
}

// --- LogEvent ---

export const LogLevelNames = [null, 'Error', 'Warn', 'Info', 'Debug', 'Trace'];

export function decodeLogEvent(dec) {
  const level = dec.enumVariant();
  const output = dec.string();
  return { level, levelName: LogLevelNames[level] || 'Unknown', output };
}

// --- Command type indices (matching Rust enum order) ---

export const CommandType = {
  Internal: 0,
  Host: 1,
  Runtime: 2,
  Environment: 3,
  Fixture: 4,
  Source: 5,
  Emitter: 6,
};

export const HostCmd = { Info: 0, FixtureCount: 1, FixtureInfo: 2 };
export const RuntimeCmd = {
  Info: 0,
  Host: 1,
  EnvironmentCount: 2,
  EnvironmentInfo: 3,
  SettingGet: 4,
  SettingSet: 5,
  SettingDelete: 6,
};
export const FixtureCmd = { Info: 0, Display: 1, SourceCount: 2, SourceInfo: 3 };
export const SourceCmd = { Info: 0, Display: 1, EmitterCount: 2, EmitterInfo: 3 };
export const EmitterCmd = { Info: 0, FluxRange: 1, FluxSet: 2, SpectralData: 3 };
export const SpectralDataCmd = { Info: 0, Domain: 1, SampleCount: 2, Sample: 3, SampleBatch: 4 };

// --- Event type indices ---

export const EventType = {
  Error: 0,
  Internal: 1,
  Host: 2,
  Runtime: 3,
  Environment: 4,
  Fixture: 5,
  Source: 6,
  Emitter: 7,
};

export const HostEvt = { Info: 0, FixtureCount: 1, FixtureInfo: 2 };
export const RuntimeEvt = {
  Info: 0,
  Log: 1,
  Host: 2,
  EnvironmentCount: 3,
  EnvironmentInfo: 4,
  SettingGet: 5,
  SettingSet: 6,
  SettingDelete: 7,
};
export const FixtureEvt = { Info: 0, Display: 1, SourceCount: 2, SourceInfo: 3 };
export const SourceEvt = { Info: 0, Display: 1, EmitterCount: 2, EmitterInfo: 3 };
export const EmitterEvt = { Info: 0, FluxRange: 1, FluxSet: 2, SpectralData: 3 };
export const SpectralDataEvt = { Info: 0, Domain: 1, SampleCount: 2, Sample: 3, SampleBatch: 4 };
export const StoredSettingType = {
  Missing: 0,
  Public: 1,
  Private: 2,
};

// --- Error decoding ---

export const ErrorType = {
  Unknown: 0, Debug: 1, Unsupported: 2, USB: 3,
  Serialization: 4, Busy: 5, InsufficientData: 6, UnexpectedResponse: 7,
  Timeout: 8,
};

function decodeError(dec) {
  const variant = dec.enumVariant();
  switch (variant) {
    case ErrorType.Debug: return { type: variant, message: dec.string() };
    case ErrorType.USB: return { type: variant, message: dec.string() };
    default: return { type: variant };
  }
}

// --- Encode a UUID (option helper) ---

function encodeUuidOption(enc, uuid) {
  enc.option(uuid, (e, v) => e.uuid(v));
}

// --- Build and serialize a command message ---

export function buildCommandMessage(command, resource = null, context = null) {
  const identifier = uuidV4();
  const enc = new PostcardEncoder();

  // Message::Command = variant 0
  enc.enumVariant(0);

  // CommandMessage struct fields
  enc.uuid(identifier);
  encodeUuidOption(enc, context);
  encodeUuidOption(enc, resource);

  // Command payload - already encoded by caller into commandBytes
  enc.buf.push(...command);

  return { identifier, data: frameBytes(enc.result()) };
}

/** Encode a command enum to raw postcard bytes (without the Message wrapper). */
export function encodeCommand(type, subVariant, encodeFn) {
  const enc = new PostcardEncoder();
  enc.enumVariant(type);
  enc.enumVariant(subVariant);
  if (encodeFn) encodeFn(enc);
  return enc.result();
}

// --- Shortcut command builders ---

export const Commands = {
  // Host commands
  hostInfo: () => encodeCommand(CommandType.Host, HostCmd.Info),
  hostFixtureCount: () => encodeCommand(CommandType.Host, HostCmd.FixtureCount),
  hostFixtureInfo: (idx) => encodeCommand(CommandType.Host, HostCmd.FixtureInfo, e => e.u32(idx)),

  // Runtime commands
  runtimeInfo: () => encodeCommand(CommandType.Runtime, RuntimeCmd.Info),
  runtimeHost: () => encodeCommand(CommandType.Runtime, RuntimeCmd.Host),
  runtimeSettingGet: (key) => encodeCommand(CommandType.Runtime, RuntimeCmd.SettingGet, (e) => {
    e.string(key);
  }),
  runtimeSettingSet: (key, value) => encodeCommand(CommandType.Runtime, RuntimeCmd.SettingSet, (e) => {
    e.string(key);
    e.bytes(value);
  }),
  runtimeSettingDelete: (key) => encodeCommand(CommandType.Runtime, RuntimeCmd.SettingDelete, (e) => {
    e.string(key);
  }),

  // Fixture commands
  fixtureInfo: () => encodeCommand(CommandType.Fixture, FixtureCmd.Info),
  fixtureDisplay: (config, flux) => encodeCommand(CommandType.Fixture, FixtureCmd.Display, e => {
    encodeConfiguration(e, config);
    encodeFlux(e, flux);
  }),
  fixtureSourceCount: () => encodeCommand(CommandType.Fixture, FixtureCmd.SourceCount),
  fixtureSourceInfo: (idx) => encodeCommand(CommandType.Fixture, FixtureCmd.SourceInfo, e => e.u32(idx)),

  // Source commands
  sourceInfo: () => encodeCommand(CommandType.Source, SourceCmd.Info),
  sourceDisplay: (config, flux) => encodeCommand(CommandType.Source, SourceCmd.Display, e => {
    encodeConfiguration(e, config);
    encodeFlux(e, flux);
  }),
  sourceEmitterCount: () => encodeCommand(CommandType.Source, SourceCmd.EmitterCount),
  sourceEmitterInfo: (idx) => encodeCommand(CommandType.Source, SourceCmd.EmitterInfo, e => e.u32(idx)),

  // Emitter commands
  emitterInfo: () => encodeCommand(CommandType.Emitter, EmitterCmd.Info),
  emitterFluxRange: () => encodeCommand(CommandType.Emitter, EmitterCmd.FluxRange),
  emitterFluxSet: (flux) => encodeCommand(CommandType.Emitter, EmitterCmd.FluxSet, e => encodeFlux(e, flux)),
  emitterSpectralInfo: () => encodeCommand(CommandType.Emitter, EmitterCmd.SpectralData, e => e.enumVariant(SpectralDataCmd.Info)),
  emitterSpectralDomain: () => encodeCommand(CommandType.Emitter, EmitterCmd.SpectralData, e => e.enumVariant(SpectralDataCmd.Domain)),
  emitterSpectralSampleCount: () => encodeCommand(CommandType.Emitter, EmitterCmd.SpectralData, e => e.enumVariant(SpectralDataCmd.SampleCount)),
  emitterSpectralSample: (idx) => encodeCommand(CommandType.Emitter, EmitterCmd.SpectralData, e => {
    e.enumVariant(SpectralDataCmd.Sample);
    e.u32(idx);
  }),
  emitterSpectralSampleBatch: (start, end) => encodeCommand(CommandType.Emitter, EmitterCmd.SpectralData, e => {
    e.enumVariant(SpectralDataCmd.SampleBatch);
    e.u32(start);
    e.u32(end);
  }),
};

// --- Decode event message from raw frame bytes ---

export function decodeMessage(frameData) {
  const payload = unframeBytes(frameData);
  const dec = new PostcardDecoder(payload);

  const messageVariant = dec.enumVariant();

  if (messageVariant === 0) {
    // Command (shouldn't normally receive, but handle gracefully)
    return { type: 'command', raw: payload };
  }

  if (messageVariant === 1) {
    // Event
    const identifier = dec.uuid();
    const context = dec.option(d => d.uuid());
    const resource = dec.option(d => d.uuid());
    const event = decodeEvent(dec);

    return {
      type: 'event',
      identifier,
      context,
      resource,
      event,
    };
  }

  throw new Error(`Unknown message variant: ${messageVariant}`);
}

function decodeEvent(dec) {
  const variant = dec.enumVariant();
  switch (variant) {
    case EventType.Error:
      return { type: 'error', error: decodeError(dec) };
    case EventType.Internal:
      return { type: 'internal' };
    case EventType.Host:
      return { type: 'host', event: decodeHostEvent(dec) };
    case EventType.Runtime:
      return { type: 'runtime', event: decodeRuntimeEvent(dec) };
    case EventType.Environment:
      return { type: 'environment', event: decodeEnvironmentEvent(dec) };
    case EventType.Fixture:
      return { type: 'fixture', event: decodeFixtureEvent(dec) };
    case EventType.Source:
      return { type: 'source', event: decodeSourceEvent(dec) };
    case EventType.Emitter:
      return { type: 'emitter', event: decodeEmitterEvent(dec) };
    default:
      throw new Error(`Unknown event type: ${variant}`);
  }
}

function decodeHostEvent(dec) {
  const v = dec.enumVariant();
  switch (v) {
    case HostEvt.Info: return { type: 'info', data: decodeHostInfo(dec) };
    case HostEvt.FixtureCount: return { type: 'fixtureCount', count: dec.u32() };
    case HostEvt.FixtureInfo: return { type: 'fixtureInfo', data: decodeFixtureInfo(dec) };
    default: throw new Error(`Unknown HostEvent variant: ${v}`);
  }
}

function decodeRuntimeEvent(dec) {
  const v = dec.enumVariant();
  switch (v) {
    case RuntimeEvt.Info: return { type: 'info', data: decodeRuntimeInfo(dec) };
    case RuntimeEvt.Log: return { type: 'log', data: decodeLogEvent(dec) };
    case RuntimeEvt.Host: return { type: 'host', data: decodeHostInfo(dec) };
    case RuntimeEvt.EnvironmentCount: return { type: 'environmentCount', count: dec.u32() };
    case RuntimeEvt.EnvironmentInfo: return { type: 'environmentInfo', data: decodeEnvironmentInfo(dec) };
    case RuntimeEvt.SettingGet:
      return {
        type: 'settingGet',
        key: dec.string(),
        setting: decodeStoredSetting(dec),
      };
    case RuntimeEvt.SettingSet:
      return { type: 'settingSet', key: dec.string() };
    case RuntimeEvt.SettingDelete:
      return { type: 'settingDelete', key: dec.string() };
    default: throw new Error(`Unknown RuntimeEvent variant: ${v}`);
  }
}

function decodeStoredSetting(dec) {
  const variant = dec.enumVariant();
  switch (variant) {
    case StoredSettingType.Missing:
      return { type: 'missing' };
    case StoredSettingType.Public:
      return { type: 'public', bytes: dec.bytes() };
    case StoredSettingType.Private:
      return { type: 'private' };
    default:
      throw new Error(`Unknown StoredSetting variant: ${variant}`);
  }
}

function decodeEnvironmentEvent(dec) {
  const v = dec.enumVariant();
  switch (v) {
    case 0: return { type: 'info', data: decodeEnvironmentInfo(dec) };
    case 1: return { type: 'display', config: decodeConfiguration(dec), flux: decodeFlux(dec) };
    case 2: return { type: 'runtimeCount', count: dec.u32() };
    case 3: return { type: 'runtimeInfo', data: decodeRuntimeInfo(dec) };
    case 4: return { type: 'fixtureCount', count: dec.u32() };
    case 5: return { type: 'fixtureInfo', data: decodeFixtureInfo(dec), index: dec.u32() };
    default: throw new Error(`Unknown EnvironmentEvent variant: ${v}`);
  }
}

function decodeFixtureEvent(dec) {
  const v = dec.enumVariant();
  switch (v) {
    case FixtureEvt.Info: return { type: 'info', data: decodeFixtureInfo(dec) };
    case FixtureEvt.Display: return { type: 'display', config: decodeConfiguration(dec), flux: decodeFlux(dec) };
    case FixtureEvt.SourceCount: return { type: 'sourceCount', count: dec.u32() };
    case FixtureEvt.SourceInfo: return { type: 'sourceInfo', data: decodeSourceInfo(dec) };
    default: throw new Error(`Unknown FixtureEvent variant: ${v}`);
  }
}

function decodeSourceEvent(dec) {
  const v = dec.enumVariant();
  switch (v) {
    case SourceEvt.Info: return { type: 'info', data: decodeSourceInfo(dec) };
    case SourceEvt.Display: return { type: 'display', config: decodeConfiguration(dec), flux: decodeFlux(dec) };
    case SourceEvt.EmitterCount: return { type: 'emitterCount', count: dec.u32() };
    case SourceEvt.EmitterInfo: return { type: 'emitterInfo', data: decodeEmitterInfo(dec) };
    default: throw new Error(`Unknown SourceEvent variant: ${v}`);
  }
}

function decodeEmitterEvent(dec) {
  const v = dec.enumVariant();
  switch (v) {
    case EmitterEvt.Info: return { type: 'info', data: decodeEmitterInfo(dec) };
    case EmitterEvt.FluxRange: return { type: 'fluxRange', min: decodeFlux(dec), max: decodeFlux(dec) };
    case EmitterEvt.FluxSet: return { type: 'fluxSet', flux: decodeFlux(dec) };
    case EmitterEvt.SpectralData: return { type: 'spectralData', event: decodeSpectralDataEvent(dec) };
    default: throw new Error(`Unknown EmitterEvent variant: ${v}`);
  }
}

function decodeSpectralDataEvent(dec) {
  const v = dec.enumVariant();
  switch (v) {
    case SpectralDataEvt.Info:
      return { type: 'info', data: decodeSpectralDataInfo(dec) };
    case SpectralDataEvt.Domain:
      return { type: 'domain', min: dec.f32(), max: dec.f32() };
    case SpectralDataEvt.SampleCount:
      return { type: 'sampleCount', count: dec.u32() };
    case SpectralDataEvt.Sample:
      return { type: 'sample', data: decodeSpectralSample(dec) };
    case SpectralDataEvt.SampleBatch: {
      const count = dec.varint(); // heapless::Vec length prefix
      const samples = [];
      for (let i = 0; i < count; i++) {
        samples.push(decodeSpectralSample(dec));
      }
      return { type: 'sampleBatch', samples };
    }
    default:
      throw new Error(`Unknown SpectralDataEvent variant: ${v}`);
  }
}
