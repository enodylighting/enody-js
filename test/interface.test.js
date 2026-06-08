/**
 * Offline interface tests for the bundled sample data helpers.
 * Run with: node test/interface.test.js
 */

import {
  CONFIGURATION_PRESETS_KEY,
  Configuration,
  Emitter,
  Fixture,
  Runtime,
  Source,
  SpectralData,
  Version,
  sampleEmitter,
  sampleFixture,
  sampleFixtureJson,
  sampleSource,
} from '../src/index.js';
import { decodeConfigurationList, encodeConfigurationList } from '../src/message.js';
import { PostcardDecoder, PostcardEncoder } from '../src/postcard.js';

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

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
