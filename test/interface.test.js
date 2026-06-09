/**
 * Offline interface tests for the bundled sample data helpers.
 * Run with: node test/interface.test.js
 */

import {
  CONFIGURATION_PRESETS_KEY,
  Commands,
  Configuration,
  Emitter,
  EnodyTransport,
  Fixture,
  Host,
  Network,
  NetworkCredentials,
  Runtime,
  SENSOR_DATA_STREAMS_KEY,
  SensorStream,
  Source,
  SpectralData,
  UpdateTarget,
  Version,
  WifiAuth,
  sampleEmitter,
  sampleFixture,
  sampleFixtureJson,
  sampleSource,
} from '../src/index.js';
import {
  EventType,
  HostEvt,
  decodeConfigurationList,
  decodeNetwork,
  decodeNetworkCredentials,
  decodeSensorStreams,
  encodeConfigurationList,
  encodeNetworkList,
  encodeSensorStreams,
} from '../src/message.js';
import { frameBytes } from '../src/framing.js';
import { PostcardDecoder, PostcardEncoder, uuidFromString, uuidV4 } from '../src/postcard.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
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

function hostEventFrame(context, hostEventVariant, encodePayload) {
  const enc = new PostcardEncoder();
  enc.enumVariant(1); // Message::Event
  enc.uuid(uuidV4());
  enc.option(context, (encoder, uuid) => encoder.uuid(uuid));
  enc.option(null, () => {});
  enc.enumVariant(EventType.Host);
  enc.enumVariant(hostEventVariant);
  encodePayload?.(enc);
  return frameBytes(enc.result());
}

const fixtureJson = sampleFixtureJson();

function spectralMeasurementsFromJson(spectralDataJson) {
  if (Array.isArray(spectralDataJson)) {
    return spectralDataJson.map((sample) => sample.measurement);
  }
  return spectralDataJson.values;
}

// --- Emitter deserialization ---
{
  const emitterJson = fixtureJson.sources[0].emitters[0];
  const emitter = Emitter.fromJson(emitterJson);
  const spectralData = await emitter.spectralData();
  const expectedMeasurements = spectralMeasurementsFromJson(emitterJson.spectral_data);

  assert(emitter.identifier() === emitterJson.identifier, 'Emitter identifier matches JSON');
  assert(spectralData instanceof SpectralData, 'Emitter spectral data is a SpectralData instance');
  assert(spectralData.sampleCount() === expectedMeasurements.length, 'Emitter sample count matches JSON');
  assert(spectralData.measurements()[0] === expectedMeasurements[0], 'Emitter measurements are loaded');
}

// --- Source deserialization ---
{
  const sourceJson = fixtureJson.sources[0];
  const source = Source.fromJson(sourceJson);
  const emitters = await source.emitters();

  assert(source.identifier() === sourceJson.identifier, 'Source identifier matches JSON');
  assert(emitters.length === sourceJson.emitters.length, 'Source emitter count matches JSON');
}

// --- Source emitter enumeration overreported by firmware ---
{
  let infoAttempts = 0;
  const timeout = new Error('Command timeout (2000ms)');
  timeout.code = 'ENODY_COMMAND_TIMEOUT';
  timeout.timeoutMs = 2000;

  const source = new Source({
    info: { identifier: 'source-id' },
    transport: {
      async sendCommand(commandBytes) {
        if (commandBytes[0] === 5 && commandBytes[1] === 2) {
          return {
            event: {
              event: {
                count: 3,
              },
            },
          };
        }

        if (commandBytes[0] === 5 && commandBytes[1] === 3) {
          infoAttempts++;
          if (commandBytes[2] === 0) {
            return {
              event: {
                event: {
                  data: { identifier: 'emitter-id' },
                },
              },
            };
          }
          throw timeout;
        }

        throw new Error(`Unexpected command ${Array.from(commandBytes).join(',')}`);
      },
    },
  });

  const emitters = await source.emitters();
  assert(emitters.length === 1, 'Source.emitters stops after timeout on overreported emitter count');
  assert(infoAttempts === 2, 'Source.emitters stops at the first timed-out extra emitter');
}

// --- Fixture deserialization ---
{
  const fixture = Fixture.fromJson(fixtureJson);
  const sources = await fixture.sources();

  assert(fixture.identifier() === fixtureJson.identifier, 'Fixture identifier matches JSON');
  assert(sources.length === fixtureJson.sources.length, 'Fixture source count matches JSON');
}

// --- Bundled helpers ---
{
  const fixture = sampleFixture();
  const source = sampleSource();
  const emitter = sampleEmitter();

  assert(!!fixture.identifier(), 'sampleFixture returns a fixture');
  assert(!!source.identifier(), 'sampleSource returns a source');
  assert(!!emitter.identifier(), 'sampleEmitter returns an emitter');
}

// --- Runtime host fallback ---
{
  const hostInfo = {
    identifier: '12345678-1234-1234-1234-123456789abc',
    version: new Version(1, 2, 3),
  };
  let runtimeHostAttempts = 0;
  let hostInfoAttempts = 0;

  const runtime = new Runtime({
    connected: true,
    async sendCommand(commandBytes) {
      if (commandBytes[0] === 2 && commandBytes[1] === 1) {
        runtimeHostAttempts++;
        throw new Error('Device error: {"type":0}');
      }
      if (commandBytes[0] === 1 && commandBytes[1] === 0) {
        hostInfoAttempts++;
        return {
          event: {
            event: {
              data: hostInfo,
            },
          },
        };
      }
      throw new Error(`Unexpected command ${Array.from(commandBytes).join(',')}`);
    },
  });

  const host = await runtime.host();
  assert(runtimeHostAttempts === 1, 'Runtime.host first tries Runtime::Host');
  assert(hostInfoAttempts === 1, 'Runtime.host falls back to Host::Info');
  assert(host.identifier() === hostInfo.identifier, 'Runtime host fallback returns host info');
  assert(host.versionString === '1.2.3', 'Runtime host fallback preserves version');
}

// --- Host WiFi setup helpers ---
{
  const networks = [
    Network.wifi({
      ssid: 'Studio WiFi',
      rssi: -51,
      auth: WifiAuth.Secured,
    }),
  ];
  let scanOptions = null;
  let joinNetwork = null;
  let joinCredentials = null;

  const host = new Host({
    async sendCommand(commandBytes, resource, context, options) {
      if (commandBytes[0] === 1 && commandBytes[1] === 3) {
        scanOptions = options;
        return {
          event: {
            event: {
              type: 'networkScanComplete',
              networks,
            },
          },
        };
      }

      if (commandBytes[0] === 1 && commandBytes[1] === 4) {
        const decoder = new PostcardDecoder(commandBytes.slice(2));
        joinNetwork = decodeNetwork(decoder);
        joinCredentials = decodeNetworkCredentials(decoder);
        return {
          event: {
            event: {
              type: 'networkJoinComplete',
              network: joinNetwork,
            },
          },
        };
      }

      throw new Error(`Unexpected command ${Array.from(commandBytes).join(',')}`);
    },
  }, {
    identifier: 'host-id',
    version: new Version(1, 2, 3),
  });

  const scanned = await host.wifiScan();
  await host.wifiJoin('Studio WiFi', 'secret-pass');

  assert(scanned[0].network.ssid === 'Studio WiFi', 'Host.wifiScan returns WiFi networks');
  assert(typeof scanOptions.responsePredicate === 'function', 'Host.wifiScan waits for scan completion');
  assert(joinNetwork.network.ssid === 'Studio WiFi', 'Host.wifiJoin encodes target SSID');
  assert(joinCredentials.credentials.password === 'secret-pass', 'Host.wifiJoin encodes password credentials');
}

// --- Transport waits for terminal correlated WiFi event ---
{
  const transport = new EnodyTransport();
  transport.port = {};
  transport.writer = { write: async () => {} };

  const networks = [Network.wifi({ ssid: 'Studio WiFi', auth: WifiAuth.Secured })];
  const response = transport.sendCommand(
    Commands.hostNetworkScan([Network.wifi()]),
    null,
    null,
    {
      timeoutMs: 100,
      responsePredicate: (message) => (
        message.event?.type === 'host'
        && message.event.event?.type === 'networkScanComplete'
      ),
    },
  );

  const [contextId] = transport.pendingRequests.keys();
  const context = uuidFromString(contextId);

  transport._handleFrame(hostEventFrame(context, HostEvt.NetworkScanStart, (enc) => {
    encodeNetworkList(enc, [Network.wifi()]);
  }));
  assert(transport.pendingRequests.has(contextId), 'Transport keeps WiFi scan pending after start event');

  transport._handleFrame(hostEventFrame(context, HostEvt.NetworkScanComplete, (enc) => {
    encodeNetworkList(enc, networks);
  }));
  const message = await response;
  assert(!transport.pendingRequests.has(contextId), 'Transport clears WiFi scan after complete event');
  assert(message.event.event.networks[0].network.ssid === 'Studio WiFi', 'Transport resolves with scan completion');
}

// --- Runtime configuration presets ---
{
  const expectedPresets = [
    Configuration.blackbody(2700),
    Configuration.chromatic(0.3127, 0.3290),
  ];
  const presetBytes = new PostcardEncoder();
  encodeConfigurationList(presetBytes, expectedPresets);
  let savedPresetBytes = null;
  let deleteKey = null;

  const runtime = new Runtime({
    connected: true,
    async sendCommand(commandBytes) {
      if (commandBytes[0] === 2 && commandBytes[1] === 4) {
        return {
          event: {
            event: {
              type: 'settingGet',
              key: CONFIGURATION_PRESETS_KEY,
              setting: {
                type: 'public',
                bytes: presetBytes.result(),
              },
            },
          },
        };
      }

      if (commandBytes[0] === 2 && commandBytes[1] === 5) {
        const decoder = new PostcardDecoder(commandBytes.slice(2));
        const key = decoder.string();
        savedPresetBytes = decoder.bytes();
        return {
          event: {
            event: {
              type: 'settingSet',
              key,
            },
          },
        };
      }

      if (commandBytes[0] === 2 && commandBytes[1] === 6) {
        const decoder = new PostcardDecoder(commandBytes.slice(2));
        deleteKey = decoder.string();
        return {
          event: {
            event: {
              type: 'settingDelete',
              key: deleteKey,
            },
          },
        };
      }

      throw new Error(`Unexpected command ${Array.from(commandBytes).join(',')}`);
    },
  });

  const presets = await runtime.configurationPresets();
  assertConfigurationListEq(
    presets,
    expectedPresets,
    'Runtime.configurationPresets loads stored configurations',
  );

  await runtime.setConfigurationPresets(expectedPresets);
  assertConfigurationListEq(
    decodeConfigurationList(new PostcardDecoder(savedPresetBytes)),
    expectedPresets,
    'Runtime.setConfigurationPresets stores postcard-encoded configuration lists',
  );

  await runtime.setConfigurationPresets([]);
  assert(deleteKey === CONFIGURATION_PRESETS_KEY, 'Runtime.setConfigurationPresets([]) deletes the preset setting');
}

// --- Runtime sensor data streams ---
{
  const expectedStreams = [SensorStream.FDC1004];
  const streamBytes = new PostcardEncoder();
  encodeSensorStreams(streamBytes, expectedStreams);
  let savedStreamBytes = null;

  const runtime = new Runtime({
    connected: true,
    async sendCommand(commandBytes) {
      if (commandBytes[0] === 2 && commandBytes[1] === 4) {
        return {
          event: {
            event: {
              type: 'settingGet',
              key: SENSOR_DATA_STREAMS_KEY,
              setting: {
                type: 'public',
                bytes: streamBytes.result(),
              },
            },
          },
        };
      }

      if (commandBytes[0] === 2 && commandBytes[1] === 5) {
        const decoder = new PostcardDecoder(commandBytes.slice(2));
        const key = decoder.string();
        savedStreamBytes = decoder.bytes();
        return {
          event: {
            event: {
              type: 'settingSet',
              key,
            },
          },
        };
      }

      throw new Error(`Unexpected command ${Array.from(commandBytes).join(',')}`);
    },
  });

  const streams = await runtime.sensorDataStreams();
  assert(streams.length === 1 && streams[0] === SensorStream.FDC1004, 'Runtime.sensorDataStreams loads enabled streams');

  await runtime.setSensorDataStreams(expectedStreams);
  const savedStreams = decodeSensorStreams(new PostcardDecoder(savedStreamBytes));
  assert(savedStreams.length === 1 && savedStreams[0] === SensorStream.FDC1004, 'Runtime.setSensorDataStreams stores postcard-encoded stream lists');

  await runtime.disableSensorDataStreams();
  const disabledStreams = decodeSensorStreams(new PostcardDecoder(savedStreamBytes));
  assert(disabledStreams.length === 0, 'Runtime.disableSensorDataStreams stores an empty stream list');
}

// --- Firmware manifest payload components ---
{
  const hostId = '12345678-1234-1234-1234-123456789abc';
  const partitionTable = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const appImage = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith('/firmware.json')) {
      return {
        ok: true,
        json: async () => [
          {
            version: '1.2.3',
            payload: [
              { offset: 0x8000, length: partitionTable.length, data: 'partition-table.bin' },
              { offset: 0x20000, length: appImage.length, data: 'app.bin' },
            ],
          },
        ],
      };
    }

    const body = url.endsWith('/partition-table.bin') ? partitionTable : appImage;
    return {
      ok: true,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  const target = new UpdateTarget({
    host: {
      identifier: () => hostId,
      version: () => new Version(1, 0, 0),
    },
    baseUrl: 'https://firmware.example',
    fetchImpl,
  });

  const payloads = await target.downloadFirmwarePayloads('1.2.3');

  assert(payloads.length === 2, 'UpdateTarget downloads all manifest payload components');
  assert(payloads[0].address === 0x8000, 'UpdateTarget uses partition-table offset from manifest');
  assert(payloads[1].address === 0x20000, 'UpdateTarget uses app-image offset from manifest');
  assert(Array.from(payloads[0].data).join(',') === Array.from(partitionTable).join(','), 'UpdateTarget preserves first payload bytes');
  assert(Array.from(payloads[1].data).join(',') === Array.from(appImage).join(','), 'UpdateTarget preserves second payload bytes');
  assert(requests.some((url) => url.endsWith(`/${hostId}/partition-table.bin`)), 'UpdateTarget downloads partition-table path');
  assert(requests.some((url) => url.endsWith(`/${hostId}/app.bin`)), 'UpdateTarget downloads app-image path');
}

// --- Manual firmware image flashing requires an explicit offset ---
{
  const target = new UpdateTarget({});
  let failedAsExpected = false;
  try {
    await target.flashFirmwareImage(new Uint8Array([0x01]));
  } catch (error) {
    failedAsExpected = error.message.includes('options.offset');
  }

  assert(failedAsExpected, 'UpdateTarget.flashFirmwareImage requires an explicit offset');
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
