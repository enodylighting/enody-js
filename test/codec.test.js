/**
 * Basic tests for postcard codec and framing logic.
 * Run with: node test/codec.test.js
 */

import { PostcardEncoder, PostcardDecoder, uuidV4, uuidToString, uuidFromString } from '../src/postcard.js';
import { frameBytes, unframeBytes, FrameAccumulator } from '../src/framing.js';
import {
  Commands,
  ErrorType,
  HostEvt,
  EventType,
  Network,
  NetworkCredentials,
  SensorStream,
  WifiAuth,
  buildCommandMessage,
  decodeConfigurationList,
  decodeMessage,
  encodeNetworkList,
  describeCommand,
  encodeConfigurationList,
  decodeSensorStreams,
  encodeSensorStreams,
  errorTypeName,
} from '../src/message.js';

let passed = 0;
let failed = 0;

const INTERNAL_EVENT_SENSOR_DATA_VARIANT = 9;
const SENSOR_DATA_EVENT_FDC1004_VARIANT = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

function assertEq(a, b, msg) {
  const equal = typeof a === 'object' && typeof b === 'object'
    ? JSON.stringify(a) === JSON.stringify(b)
    : a === b;
  if (equal) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

function assertConfigurationListEq(actual, expected, message) {
  const equal = actual.length === expected.length && actual.every((configuration, index) => {
    const candidate = expected[index];
    if (configuration.type !== candidate.type) {
      return false;
    }

    if (configuration.type === 1) {
      return Math.abs(configuration.kelvin - candidate.kelvin) < 0.01;
    }

    if (configuration.type === 2) {
      return Math.abs(configuration.x - candidate.x) < 1e-5
        && Math.abs(configuration.y - candidate.y) < 1e-5;
    }

    return true;
  });

  assert(equal, message);
}

function hostEventFrame(hostEventVariant, encodePayload) {
  const enc = new PostcardEncoder();
  enc.enumVariant(1); // Message::Event
  enc.uuid(uuidV4());
  enc.option(null, () => {});
  enc.option(null, () => {});
  enc.enumVariant(EventType.Host);
  enc.enumVariant(hostEventVariant);
  encodePayload?.(enc);
  return frameBytes(enc.result());
}

function internalEventFrame(internalEventVariant, encodePayload) {
  const enc = new PostcardEncoder();
  enc.enumVariant(1); // Message::Event
  enc.uuid(uuidV4());
  enc.option(null, () => {});
  enc.option(null, () => {});
  enc.enumVariant(EventType.Internal);
  enc.enumVariant(internalEventVariant);
  encodePayload?.(enc);
  return frameBytes(enc.result());
}

// --- Varint encoding ---
{
  const enc = new PostcardEncoder();
  enc.varint(0);
  assertEq(enc.result()[0], 0, 'varint(0)');
}
{
  const enc = new PostcardEncoder();
  enc.varint(127);
  assertEq(enc.result()[0], 127, 'varint(127)');
}
{
  const enc = new PostcardEncoder();
  enc.varint(128);
  const r = enc.result();
  assertEq(r[0], 0x80, 'varint(128) byte 0');
  assertEq(r[1], 0x01, 'varint(128) byte 1');
}
{
  const enc = new PostcardEncoder();
  enc.varint(300);
  const dec = new PostcardDecoder(enc.result());
  assertEq(dec.varint(), 300, 'varint(300) roundtrip');
}

// --- f32 encoding ---
{
  const enc = new PostcardEncoder();
  enc.f32(4000.0);
  const dec = new PostcardDecoder(enc.result());
  const val = dec.f32();
  assert(Math.abs(val - 4000.0) < 0.01, `f32(4000.0) roundtrip: got ${val}`);
}

// --- UUID roundtrip ---
{
  const uuid = uuidV4();
  const str = uuidToString(uuid);
  const back = uuidFromString(str);
  assertEq(Array.from(uuid), Array.from(back), 'UUID roundtrip');
  assert(str.length === 36, 'UUID string length');
  assert(str[14] === '4', 'UUID v4 version nibble');
}

// --- UUID via postcard ---
{
  const uuid = uuidV4();
  const enc = new PostcardEncoder();
  enc.uuid(uuid);
  const dec = new PostcardDecoder(enc.result());
  const decoded = dec.uuid();
  assertEq(Array.from(uuid), Array.from(decoded), 'UUID postcard roundtrip');
}

// --- Option encoding ---
{
  const enc = new PostcardEncoder();
  enc.option(null, () => {});
  assertEq(enc.result()[0], 0, 'Option None');
}
{
  const enc = new PostcardEncoder();
  enc.option(42, (e, v) => e.u8(v));
  const r = enc.result();
  assertEq(r[0], 1, 'Option Some tag');
  assertEq(r[1], 42, 'Option Some value');
}

// --- Frame encoding/decoding ---
{
  const payload = new Uint8Array([0x01, 0x02, 0x03, 0x10, 0xFF]);
  const framed = frameBytes(payload);
  assertEq(framed[0], 0x02, 'Frame starts with STX');
  assertEq(framed[framed.length - 1], 0x03, 'Frame ends with ETX');

  const unframed = unframeBytes(framed);
  assertEq(Array.from(unframed), Array.from(payload), 'Frame roundtrip');
}

// --- Frame with all control chars ---
{
  const payload = new Uint8Array([0x02, 0x03, 0x10]);
  const framed = frameBytes(payload);
  const unframed = unframeBytes(framed);
  assertEq(Array.from(unframed), Array.from(payload), 'Frame with control chars');
}

// --- FrameAccumulator ---
{
  const acc = new FrameAccumulator();
  const payload = new Uint8Array([0x41, 0x42]); // AB
  const framed = frameBytes(payload);

  // Feed one byte at a time
  const allFrames = [];
  for (const byte of framed) {
    const frames = acc.feed(new Uint8Array([byte]));
    allFrames.push(...frames);
  }
  assertEq(allFrames.length, 1, 'FrameAccumulator found 1 frame');
  const unframed = unframeBytes(allFrames[0]);
  assertEq(Array.from(unframed), [0x41, 0x42], 'FrameAccumulator content');
}

// --- Command building ---
{
  const cmdBytes = Commands.hostInfo();
  assert(cmdBytes instanceof Uint8Array, 'hostInfo returns Uint8Array');
  // Command::Host = variant 1, HostCommand::Info = variant 0
  assertEq(cmdBytes[0], 1, 'hostInfo: Command::Host variant');
  assertEq(cmdBytes[1], 0, 'hostInfo: HostCommand::Info variant');
}

{
  const cmdBytes = Commands.hostFixtureCount();
  assertEq(cmdBytes[0], 1, 'hostFixtureCount: Command::Host variant');
  assertEq(cmdBytes[1], 1, 'hostFixtureCount: HostCommand::FixtureCount variant');
}

{
  const cmdBytes = Commands.hostFixtureInfo(0);
  assertEq(cmdBytes[0], 1, 'hostFixtureInfo(0): Command::Host variant');
  assertEq(cmdBytes[1], 2, 'hostFixtureInfo(0): HostCommand::FixtureInfo variant');
  assertEq(cmdBytes[2], 0, 'hostFixtureInfo(0): index=0');
}

{
  const cmdBytes = Commands.hostNetworkScan([Network.wifi()]);
  assertEq(cmdBytes[0], 1, 'hostNetworkScan: Command::Host variant');
  assertEq(cmdBytes[1], 3, 'hostNetworkScan: HostCommand::NetworkScan variant');
  assertEq(cmdBytes[2], 1, 'hostNetworkScan: one filter');
  assertEq(cmdBytes[3], 0, 'hostNetworkScan: Network::Wifi variant');
}

{
  const cmdBytes = Commands.hostNetworkJoin(
    Network.wifi({ ssid: 'Studio WiFi' }),
    NetworkCredentials.wifiPassword('secret-pass'),
  );
  const description = describeCommand(cmdBytes);
  assertEq(cmdBytes[0], 1, 'hostNetworkJoin: Command::Host variant');
  assertEq(cmdBytes[1], 4, 'hostNetworkJoin: HostCommand::NetworkJoin variant');
  assertEq(description.name, 'Host.NetworkJoin', 'describeCommand names network joins');
  assertEq(description.network.network.ssid, 'Studio WiFi', 'describeCommand decodes WiFi SSID');
  assertEq(description.credentialsType, 1, 'describeCommand reports WiFi credentials');
  assertEq(description.passwordLength, 11, 'describeCommand reports password length');
}

{
  const cmdBytes = Commands.emitterFluxSet({ value: 0.5 });
  assertEq(cmdBytes[0], 6, 'emitterFluxSet: Command::Emitter variant');
  assertEq(cmdBytes[1], 2, 'emitterFluxSet: EmitterCommand::FluxSet variant');
  assertEq(cmdBytes[2], 0, 'emitterFluxSet: Flux::Relative variant');
}

{
  const cmdBytes = Commands.fixtureDisplay(
    { type: 1, kelvin: 4000.0 }, // Blackbody
    { value: 0.8 }
  );
  assertEq(cmdBytes[0], 4, 'fixtureDisplay: Command::Fixture variant');
  assertEq(cmdBytes[1], 1, 'fixtureDisplay: FixtureCommand::Display variant');
  assertEq(cmdBytes[2], 1, 'fixtureDisplay: Configuration::Blackbody variant');
}

{
  const cmdBytes = Commands.runtimeSettingGet('dev.enody.configuration-presets');
  assertEq(cmdBytes[0], 2, 'runtimeSettingGet: Command::Runtime variant');
  assertEq(cmdBytes[1], 4, 'runtimeSettingGet: RuntimeCommand::SettingGet variant');
}

{
  const cmdBytes = Commands.runtimeSettingSet(
    'dev.enody.configuration-presets',
    new Uint8Array([0x01, 0x02, 0x03]),
  );
  assertEq(cmdBytes[0], 2, 'runtimeSettingSet: Command::Runtime variant');
  assertEq(cmdBytes[1], 5, 'runtimeSettingSet: RuntimeCommand::SettingSet variant');
}

{
  const description = describeCommand(Commands.runtimeSettingSet(
    'dev.enody.configuration-presets',
    new Uint8Array([0x01, 0x02, 0x03]),
  ));
  assertEq(description.name, 'Runtime.SettingSet', 'describeCommand names runtime setting writes');
  assertEq(description.key, 'dev.enody.configuration-presets', 'describeCommand decodes setting key');
  assertEq(description.valueByteLength, 3, 'describeCommand reports setting value length');
}

{
  const description = describeCommand(Commands.emitterSpectralSampleBatch(8, 24));
  assertEq(description.name, 'Emitter.SpectralData.SampleBatch', 'describeCommand names spectral batches');
  assertEq(description.start, 8, 'describeCommand decodes spectral batch start');
  assertEq(description.end, 24, 'describeCommand decodes spectral batch end');
}

{
  assertEq(errorTypeName(ErrorType.Timeout), 'Timeout', 'errorTypeName maps known errors');
  assertEq(errorTypeName(99), 'ErrorType(99)', 'errorTypeName falls back for unknown errors');
}

{
  const presets = [
    { type: 1, kelvin: 2700 },
    { type: 2, x: 0.3127, y: 0.3290 },
  ];
  const enc = new PostcardEncoder();
  encodeConfigurationList(enc, presets);
  const decoded = decodeConfigurationList(new PostcardDecoder(enc.result()));
  assertConfigurationListEq(decoded, presets, 'Configuration preset list roundtrip');
}

{
  const enc = new PostcardEncoder();
  encodeSensorStreams(enc, [SensorStream.FDC1004]);
  const encoded = enc.result();
  assertEq(Array.from(encoded), [1, 0], 'Sensor stream list encodes FDC1004');
  const decoded = decodeSensorStreams(new PostcardDecoder(encoded));
  assertEq(decoded, [SensorStream.FDC1004], 'Sensor stream list decodes FDC1004');
}

{
  const message = decodeMessage(internalEventFrame(INTERNAL_EVENT_SENSOR_DATA_VARIANT, (enc) => {
    enc.enumVariant(SENSOR_DATA_EVENT_FDC1004_VARIANT);
    enc.varint(3);
    enc.f32(12);
    enc.f32(35.4);
    enc.f32(42.1);
  }));
  const sensorEvent = message.event.event;
  assertEq(message.event.type, 'internal', 'decodeMessage decodes internal event envelope');
  assertEq(sensorEvent.type, 'sensorData', 'decodeMessage decodes SensorData internal event');
  assertEq(sensorEvent.event.type, 'fdc1004', 'decodeMessage decodes FDC1004 sensor data');
  assert(sensorEvent.event.samples.length === 3, 'FDC1004 event includes all samples');
  assert(Math.abs(sensorEvent.event.samples.at(-1) - 42.1) < 0.01, 'FDC1004 samples decode as f32 values');
}

{
  const message = decodeMessage(internalEventFrame(6, (enc) => {
    enc.f32(15.5);
  }));
  assertEq(message.event.type, 'internal', 'unknown internal events retain generic internal envelope');
  assert(!('event' in message.event), 'unknown internal events are not surfaced as named SDK events');
}

{
  const networks = [
    Network.wifi({
      ssid: 'Studio WiFi',
      bssid: new Uint8Array([1, 2, 3, 4, 5, 6]),
      channel: 6,
      rssi: -58,
      auth: WifiAuth.Secured,
    }),
  ];
  const message = decodeMessage(hostEventFrame(HostEvt.NetworkScanComplete, (enc) => {
    encodeNetworkList(enc, networks);
  }));
  const [network] = message.event.event.networks;
  assertEq(message.event.event.type, 'networkScanComplete', 'decodeMessage decodes network scan completion');
  assertEq(network.network.ssid, 'Studio WiFi', 'decodeNetwork decodes SSID');
  assertEq(network.network.rssi, -58, 'decodeNetwork decodes signed RSSI');
  assertEq(network.network.auth, WifiAuth.Secured, 'decodeNetwork decodes auth type');
}

{
  const cmdBytes = Commands.emitterSpectralSampleBatch(0, 32);
  assertEq(cmdBytes[0], 6, 'spectralBatch: Command::Emitter variant');
  assertEq(cmdBytes[1], 3, 'spectralBatch: EmitterCommand::SpectralData variant');
  assertEq(cmdBytes[2], 4, 'spectralBatch: SpectralDataCommand::SampleBatch variant');
  assertEq(cmdBytes[3], 0, 'spectralBatch: start=0');
  assertEq(cmdBytes[4], 32, 'spectralBatch: end=32');
}

// --- Full message build ---
{
  const { identifier, data } = buildCommandMessage(Commands.hostInfo());
  assert(identifier.length === 16, 'Message identifier is 16 bytes');
  assert(data[0] === 0x02, 'Message frame starts with STX');
  assert(data[data.length - 1] === 0x03, 'Message frame ends with ETX');
}

// --- Summary ---
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
