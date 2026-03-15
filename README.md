# enody

JavaScript SDK for Enody spectrally tunable lighting devices.

This is an LLM port of the enody-py framework, with modifications to support browser and node backends.

`enody` provides:

- WebSerial-based discovery and control for EP01 hardware
- A device hierarchy that mirrors the Rust and Python SDKs
- Bundled sample spectral data for offline development
- Optimization helpers for spectral matching and chromaticity work
- Browser firmware update support for EP01 devices

The browser UI that consumes this SDK now lives in the separate sibling project at `/Users/carter/llm_sandbox/src/js-sdk/enody-web`.

## Installation

```bash
npm install enody
```

The package targets modern ESM environments and requires Node 18+ for local tooling.

## Quick Start

### Discover and connect to a device

```js
import { UsbEnvironment } from 'enody';

const environment = new UsbEnvironment();
const runtimes = await environment.runtimes();
const runtime = runtimes[0];
const host = await runtime.host();

console.log(`Host ${host.identifier()} (v${host.versionString})`);

const fixtures = await host.fixtures();
const sources = await fixtures[0].sources();
const emitters = await sources[0].emitters();
```

### Control a fixture

```js
import { Configuration, Flux } from 'enody';

await fixtures[0].display(
  Configuration.blackbody(4000),
  Flux.relative(0.8),
);
```

Convenience helpers are also available:

```js
await fixtures[0].setCCT(4000, 0.8);
await fixtures[0].setChromaticity(0.3127, 0.3290, 0.8);
await fixtures[0].setManual(1.0);
```

### Work offline with bundled sample data

```js
import { sampleFixture, sampleSource, sampleEmitter } from 'enody';

const fixture = sampleFixture();
const source = sampleSource();
const emitter = sampleEmitter();

console.log(fixture.identifier(), source.identifier(), emitter.identifier());
```

### Use the optimizer helpers

```js
import {
  SpectralOptimizer,
  cieXAction,
  cieYAction,
  cieZAction,
  sampleSource,
} from 'enody';

const source = sampleSource();
const emitters = await source.emitters();

const spdMatrix = new Float32Array(emitters.length * 401);
for (let emitterIndex = 0; emitterIndex < emitters.length; emitterIndex += 1) {
  const values = (await emitters[emitterIndex].spectralData()).values();
  spdMatrix.set(values, emitterIndex * 401);
}

const optimizer = new SpectralOptimizer({
  spdMatrix,
  numEmitters: emitters.length,
  cieX: new Float32Array(cieXAction()),
  cieY: new Float32Array(cieYAction()),
  cieZ: new Float32Array(cieZAction()),
});

optimizer.setTargetChromaticity(0.3127, 0.3290);
optimizer.step();
```

### Update firmware

```js
import { UpdateTarget } from 'enody';

const [target] = await UpdateTarget.discover();
const versions = await target.availableFirmware();

await target.updateDevice(versions[0], {
  onLog: console.log,
});
```

By default the updater fetches manifests from `https://firmware.enody.lighting`. In local development you can point it at a proxy:

```js
const [target] = await UpdateTarget.discover({
  baseUrl: '/firmware',
});
```

## API Overview

The primary resource hierarchy follows the native SDKs:

```text
UsbEnvironment -> Runtime -> Host -> Fixture -> Source -> Emitter
```

Key exports:

- `UsbEnvironment`, `Runtime`, `Host`, `Fixture`, `Source`, `Emitter`
- `Configuration`, `Flux`, `Version`
- `sampleFixture`, `sampleSource`, `sampleEmitter`
- `SpectralOptimizer`, `GPUCompute`, `computeChromaticity`, `computeSSI`
- `UpdateTarget`, `ESPFlasher`

## Development

Run the SDK tests from the package directory:

```bash
npm test
```

The sibling demo application can be served with:

```bash
cd /Users/carter/llm_sandbox/src/js-sdk/enody-web
python3 server.py 8080
```
