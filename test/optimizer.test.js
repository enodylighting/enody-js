/**
 * Tests for the spectral optimization helpers.
 * Run with: node test/optimizer.test.js
 */

import {
  AdamOptimizer,
  SpectralOptimizer,
  blackbodySpectrum,
  cieXAction,
  cieYAction,
  cieZAction,
  computeChromaticity,
  computeEmission,
  computeSSI,
  sampleFixture,
} from '../src/index.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${msg}`); }
}

function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) < tol) passed++;
  else { failed++; console.error(`FAIL: ${msg} — expected ~${b}, got ${a} (tol=${tol})`); }
}

const fixture = sampleFixture();
const response = {
  cieX: new Float32Array(cieXAction()),
  cieY: new Float32Array(cieYAction()),
  cieZ: new Float32Array(cieZAction()),
};

// --- Blackbody spectrum ---
{
  const wavelengths = Array.from({ length: 401 }, (_, index) => 380 + index);
  const bb = blackbodySpectrum(5500, wavelengths);
  assert(bb.length === 401, 'Blackbody has 401 samples');
  assertClose(Math.max(...bb), 1.0, 1e-6, 'Blackbody is normalized to peak≈1');
  let peakIdx = 0;
  for (let index = 1; index < bb.length; index += 1) {
    if (bb[index] > bb[peakIdx]) peakIdx = index;
  }
  assert(peakIdx > 130 && peakIdx < 170, `Blackbody 5500K peak at index ${peakIdx} (expected ~147)`);
}

// --- CIE Chromaticity of D65 white ---
{
  const wavelengths = Array.from({ length: 401 }, (_, index) => 380 + index);
  const d65 = blackbodySpectrum(6504, wavelengths);
  const chrom = computeChromaticity(d65, response.cieX, response.cieY, response.cieZ);
  assertClose(chrom.x, 0.3127, 0.01, `D65 x = ${chrom.x.toFixed(4)}`);
  assertClose(chrom.y, 0.3290, 0.01, `D65 y = ${chrom.y.toFixed(4)}`);
}

// --- SSI: identical spectra should score 100 ---
{
  const wavelengths = Array.from({ length: 401 }, (_, index) => 380 + index);
  const bb = blackbodySpectrum(4000, wavelengths);
  const ssi = computeSSI(bb.slice(0, 301), bb.slice(0, 301));
  assertClose(ssi, 100, 0.1, `SSI of identical spectra = ${ssi.toFixed(1)}`);
}

// --- SSI: different spectra should score < 100 ---
{
  const wavelengths = Array.from({ length: 401 }, (_, index) => 380 + index);
  const bb3000 = blackbodySpectrum(3000, wavelengths).slice(0, 301);
  const bb6500 = blackbodySpectrum(6500, wavelengths).slice(0, 301);
  const ssi = computeSSI(bb3000, bb6500);
  assert(ssi < 80, `SSI of 3000K vs 6500K = ${ssi.toFixed(1)} (should be < 80)`);
  assert(ssi > 0, `SSI should be positive: ${ssi.toFixed(1)}`);
}

// --- Emission computation ---
{
  const spd = new Float32Array(2 * 401);
  spd[500 - 380] = 1.0;
  spd[401 + (600 - 380)] = 1.0;

  const emission = computeEmission(new Float32Array([0.5, 0.5]), spd, 2, 401);
  assertClose(emission[500 - 380], 0.5 + 1e-9, 1e-6, 'Emission at 500nm');
  assertClose(emission[600 - 380], 0.5 + 1e-9, 1e-6, 'Emission at 600nm');
}

// --- Adam optimizer convergence ---
{
  const params = new Float32Array([5.0]);
  const adam = new AdamOptimizer(1, 0.1);
  for (let index = 0; index < 200; index += 1) {
    adam.step(params, new Float32Array([2 * params[0]]));
  }
  assertClose(params[0], 0, 0.01, `Adam minimizes x^2: x=${params[0].toFixed(4)}`);
}

// --- Full optimizer: chromaticity convergence ---
{
  const source = (await fixture.sources())[0];
  const emitters = await source.emitters();
  const numEmitters = emitters.length;
  const spdMatrix = new Float32Array(numEmitters * 401);

  for (let emitterIndex = 0; emitterIndex < numEmitters; emitterIndex += 1) {
    const values = (await emitters[emitterIndex].spectralData()).values();
    const peak = Math.max(...values);
    for (let wavelengthIndex = 0; wavelengthIndex < 401; wavelengthIndex += 1) {
      spdMatrix[emitterIndex * 401 + wavelengthIndex] = peak > 0 ? values[wavelengthIndex] / peak : 0;
    }
  }

  const optimizer = new SpectralOptimizer({
    spdMatrix,
    numEmitters,
    cieX: response.cieX,
    cieY: response.cieY,
    cieZ: response.cieZ,
    gpu: null,
  });

  optimizer.setTargetChromaticity(0.3127, 0.3290, 1e-3);
  for (let index = 0; index < 500; index += 1) optimizer.step();

  const state = optimizer.getState();
  assert(state.loss < 0.01, `Chromaticity loss < 0.01 after 500 iter: ${state.loss.toExponential(3)}`);
  assertClose(state.chromaticity.x, 0.3127, 0.01, `Final x ≈ 0.3127: ${state.chromaticity.x.toFixed(4)}`);
  assertClose(state.chromaticity.y, 0.3290, 0.01, `Final y ≈ 0.3290: ${state.chromaticity.y.toFixed(4)}`);
}

// --- Full optimizer: CCT convergence ---
{
  const source = (await fixture.sources())[0];
  const emitters = await source.emitters();
  const numEmitters = emitters.length;
  const spdMatrix = new Float32Array(numEmitters * 401);

  for (let emitterIndex = 0; emitterIndex < numEmitters; emitterIndex += 1) {
    const values = (await emitters[emitterIndex].spectralData()).values();
    const peak = Math.max(...values);
    for (let wavelengthIndex = 0; wavelengthIndex < 401; wavelengthIndex += 1) {
      spdMatrix[emitterIndex * 401 + wavelengthIndex] = peak > 0 ? values[wavelengthIndex] / peak : 0;
    }
  }

  const optimizer = new SpectralOptimizer({
    spdMatrix,
    numEmitters,
    cieX: response.cieX,
    cieY: response.cieY,
    cieZ: response.cieZ,
    gpu: null,
  });

  optimizer.setTargetCCT(4000, 1e-4);
  for (let index = 0; index < 1000; index += 1) optimizer.step();

  const state = optimizer.getState();
  assert(state.loss < 1.0, `CCT loss < 1.0 after 1000 iter: ${state.loss.toExponential(3)}`);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
