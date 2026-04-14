# enody

JavaScript SDK for Enody spectrally tunable lighting devices.

This is an LLM port of the enody-py framework, with modifications to support browser and node backends.

`enody` provides:

- One import path that works in both the browser and Node.js
- WebSerial-based discovery and control for EP01 hardware in browser apps
- Node-based serial discovery and control for scripts, CLIs, and notebooks
- A device hierarchy that mirrors the Rust and Python SDKs
- Bundled sample spectral data for offline development
- Optimization helpers for spectral matching and chromaticity work
- Firmware update support for EP01 devices

The browser UI that consumes this SDK now lives in the separate sibling project at `/Users/carter/llm_sandbox/src/js-sdk/enody-web`.

## Installation

```bash
npm install enody
```

The package targets modern ESM environments and requires Node 18+ for local tooling.

`import { UsbEnvironment, Configuration, Flux } from 'enody'` resolves to the
appropriate implementation automatically:

- in Node.js, `enody` uses the Node serial backend
- in browser builds, `enody` uses WebSerial

That means the same import works in browser apps, scripts, and Node-backed
notebooks.

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

### Use the same import in Node or a notebook

```js
import { UsbEnvironment, Configuration, Flux } from 'enody';

const env = new UsbEnvironment();
const runtime = (await env.runtimes())[0];
const host = await runtime.host();
const fixture = (await host.fixtures())[0];

await fixture.display(
  Configuration.blackbody(4000),
  Flux.relative(0.8),
);
```

When multiple serial devices are present in Node, set `ENODY_PORT` to target a
specific port path.

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

Run the optional Node hardware-in-the-loop smoke test with a connected EP01:

```bash
npm run test:hil
```

To force a specific serial device in Node:

```bash
ENODY_PORT=/dev/tty.usbmodem1234 npm run test:hil
```

The sibling demo application can be served with:

```bash
cd /Users/carter/llm_sandbox/src/js-sdk/enody-web
python3 server.py 8080
```
