/**
 * Offline interface tests for the bundled sample data helpers.
 * Run with: node test/interface.test.js
 */

import {
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

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
