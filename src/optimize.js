/**
 * Spectral mixing optimization engine.
 *
 * Implements gradient-descent optimization of emitter weights to match
 * a target chromaticity or CCT, using analytical gradients for the
 * chromaticity loss and numerical gradients for the SSI loss.
 *
 * Supports two backends:
 *   - WebGPU compute shaders (preferred, parallel forward passes)
 *   - CPU fallback (typed array math)
 */

import {
  cieXAction,
  cieYAction,
  cieZAction,
  lConeAction,
  mConeAction,
  melanopicAction,
  rhodopicAction,
  sConeAction,
} from './data.js';

function normalizeSpectra(distributions) {
  if (!Array.isArray(distributions)) {
    return {
      single: true,
      spectra: [distributions],
    };
  }

  const first = distributions[0];
  const nestedArray = Array.isArray(first) || ArrayBuffer.isView(first);
  if (nestedArray) {
    return {
      single: false,
      spectra: distributions,
    };
  }

  return {
    single: true,
    spectra: [distributions],
  };
}

function computeWeightedResponse(distributions, responseCurve) {
  const { single, spectra } = normalizeSpectra(distributions);
  const responses = new Float32Array(spectra.length);

  for (let spectrumIndex = 0; spectrumIndex < spectra.length; spectrumIndex += 1) {
    const spectrum = spectra[spectrumIndex];
    let sum = 0;
    for (let sampleIndex = 0; sampleIndex < responseCurve.length; sampleIndex += 1) {
      sum += spectrum[sampleIndex] * responseCurve[sampleIndex];
    }
    responses[spectrumIndex] = sum;
  }

  return single ? responses[0] : responses;
}

// ─── Blackbody (Planck's law) ───────────────────────────────────────────────

const C2 = 0.014387768775; // hc/k in m·K

export function blackbodySpectrum(T, wavelengths) {
  // Relative spectral radiance via Planck's law (normalized to peak=1)
  const values = new Float32Array(wavelengths.length);
  let maxVal = 0;
  for (let i = 0; i < wavelengths.length; i++) {
    const lam = wavelengths[i] * 1e-9; // nm to m
    const exponent = C2 / (lam * T);
    // Avoid overflow: if exponent > 500, value is essentially 0
    if (exponent > 500) { values[i] = 0; continue; }
    const val = 1.0 / (Math.pow(lam, 5) * (Math.exp(exponent) - 1));
    values[i] = val;
    if (val > maxVal) maxVal = val;
  }
  // Normalize to [0, 1]
  if (maxVal > 0) for (let i = 0; i < values.length; i++) values[i] /= maxVal;
  return values;
}

// ─── SSI (Spectral Similarity Index) ────────────────────────────────────────

const SSI_RESAMPLE_KERNEL = [0.05, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.05];
const SSI_WEIGHT_KERNEL = [4/15, 22/45, 32/45, 8/9, 44/45,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1, 11/15, 3/15];
const SSI_SMOOTH_KERNEL = [0.22, 0.56, 0.22];

function conv1d(input, kernel, stride = 1) {
  const kLen = kernel.length;
  const outLen = Math.floor((input.length - kLen) / stride) + 1;
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    const start = i * stride;
    for (let k = 0; k < kLen; k++) sum += input[start + k] * kernel[k];
    out[i] = sum;
  }
  return out;
}

function conv1dPad(input, kernel) {
  // Padding=(0,1) means pad 0 on left, 1 on right → same output length
  const padded = new Float32Array(input.length + 1);
  padded.set(input, 0);
  // padded[input.length] = 0 (already zero)
  return conv1d(padded, kernel, 1);
}

export function computeSSI(test301, ref301) {
  // Resample: 301 → 30 via 11-tap kernel, stride 10
  const testR = conv1d(test301, SSI_RESAMPLE_KERNEL, 10);
  const refR = conv1d(ref301, SSI_RESAMPLE_KERNEL, 10);

  // Normalize to unity power
  let testSum = 0, refSum = 0;
  for (let i = 0; i < 30; i++) { testSum += testR[i]; refSum += refR[i]; }
  const testN = new Float32Array(30);
  const refN = new Float32Array(30);
  for (let i = 0; i < 30; i++) {
    testN[i] = testR[i] / (testSum || 1);
    refN[i] = refR[i] / (refSum || 1);
  }

  // Difference vector D
  const D = new Float32Array(30);
  for (let i = 0; i < 30; i++) {
    D[i] = (testN[i] - refN[i]) / (refN[i] + 1/30);
  }

  // Weight
  const weighted = new Float32Array(30);
  for (let i = 0; i < 30; i++) weighted[i] = D[i] * SSI_WEIGHT_KERNEL[i];

  // Smooth (3-tap conv with padding=(0,1))
  const smoothed = conv1dPad(weighted, SSI_SMOOTH_KERNEL);

  // Vector magnitude
  let mag2 = 0;
  for (let i = 0; i < smoothed.length; i++) mag2 += smoothed[i] * smoothed[i];
  const magnitude = Math.sqrt(mag2);

  return 100 - 32 * magnitude;
}

// ─── CIE 1931 Chromaticity ──────────────────────────────────────────────────

export function computeChromaticity(emission401, cieX, cieY, cieZ) {
  let X = 0, Y = 0, Z = 0;
  for (let i = 0; i < 401; i++) {
    X += emission401[i] * cieX[i];
    Y += emission401[i] * cieY[i];
    Z += emission401[i] * cieZ[i];
  }
  const S = X + Y + Z;
  return { x: X / S, y: Y / S, X, Y, Z, S };
}

export function melanopicResponse(distributions) {
  return computeWeightedResponse(distributions, melanopicAction());
}

export function rhodopicResponse(distributions) {
  return computeWeightedResponse(distributions, rhodopicAction());
}

export function sConeResponse(distributions) {
  return computeWeightedResponse(distributions, sConeAction());
}

export function mConeResponse(distributions) {
  return computeWeightedResponse(distributions, mConeAction());
}

export function lConeResponse(distributions) {
  return computeWeightedResponse(distributions, lConeAction());
}

export function cieXResponse(distributions) {
  return computeWeightedResponse(distributions, cieXAction());
}

export function cieYResponse(distributions) {
  return computeWeightedResponse(distributions, cieYAction());
}

export function cieZResponse(distributions) {
  return computeWeightedResponse(distributions, cieZAction());
}

export function cie1931Chromaticity(distributions) {
  const curves = {
    x: cieXAction(),
    y: cieYAction(),
    z: cieZAction(),
  };
  const { single, spectra } = normalizeSpectra(distributions);
  const chromaticities = spectra.map((spectrum) => computeChromaticity(spectrum, curves.x, curves.y, curves.z));
  return single ? chromaticities[0] : chromaticities;
}

// ─── Forward pass: compute emission from weights + SPD matrix ───────────────

export function computeEmission(weights, spdMatrix, numEmitters, numWavelengths) {
  const emission = new Float32Array(numWavelengths);
  for (let w = 0; w < numWavelengths; w++) {
    let sum = 0;
    for (let e = 0; e < numEmitters; e++) {
      const wt = Math.max(0, Math.min(1, weights[e]));
      sum += wt * spdMatrix[e * numWavelengths + w];
    }
    emission[w] = sum + 1e-9;
  }
  return emission;
}

// ─── Adam Optimizer ─────────────────────────────────────────────────────────

export class AdamOptimizer {
  constructor(numParams, lr = 1e-3, beta1 = 0.9, beta2 = 0.999, eps = 1e-8) {
    this.lr = lr;
    this.beta1 = beta1;
    this.beta2 = beta2;
    this.eps = eps;
    this.m = new Float32Array(numParams); // first moment
    this.v = new Float32Array(numParams); // second moment
    this.t = 0;
  }

  step(params, grads) {
    this.t++;
    const bc1 = 1 - Math.pow(this.beta1, this.t);
    const bc2 = 1 - Math.pow(this.beta2, this.t);
    for (let i = 0; i < params.length; i++) {
      this.m[i] = this.beta1 * this.m[i] + (1 - this.beta1) * grads[i];
      this.v[i] = this.beta2 * this.v[i] + (1 - this.beta2) * grads[i] * grads[i];
      const mHat = this.m[i] / bc1;
      const vHat = this.v[i] / bc2;
      params[i] -= this.lr * mHat / (Math.sqrt(vHat) + this.eps);
    }
  }
}

// ─── WebGPU Compute Backend ─────────────────────────────────────────────────

const FORWARD_SHADER = /* wgsl */`
struct Params {
  num_emitters: u32,
  num_wavelengths: u32,
  num_perturbations: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> weights: array<f32>;     // [num_perturbations * num_emitters]
@group(0) @binding(2) var<storage, read> spd: array<f32>;         // [num_emitters * num_wavelengths]
@group(0) @binding(3) var<storage, read> cie_xyz: array<f32>;     // [3 * num_wavelengths]
@group(0) @binding(4) var<storage, read_write> out_xy: array<f32>; // [num_perturbations * 2]
@group(0) @binding(5) var<storage, read_write> out_emission: array<f32>; // [num_perturbations * num_wavelengths]

// Each workgroup handles one perturbation (one weight vector).
// We use 256 threads per workgroup.
var<workgroup> ws_xyz: array<f32, 768>; // 256 * 3 partial sums

@compute @workgroup_size(256)
fn forward(@builtin(local_invocation_index) tid: u32,
           @builtin(workgroup_id) wid: vec3<u32>) {
  let pid = wid.x; // perturbation index
  let ne = params.num_emitters;
  let nw = params.num_wavelengths;
  let w_base = pid * ne;

  // Phase 1: compute emission and CIE partial sums
  var px: f32 = 0.0;
  var py: f32 = 0.0;
  var pz: f32 = 0.0;

  for (var wl = tid; wl < nw; wl += 256u) {
    var em: f32 = 0.0;
    for (var e = 0u; e < ne; e++) {
      let w = clamp(weights[w_base + e], 0.0, 1.0);
      em += w * spd[e * nw + wl];
    }
    em += 1e-9;
    out_emission[pid * nw + wl] = em;
    px += em * cie_xyz[wl];
    py += em * cie_xyz[nw + wl];
    pz += em * cie_xyz[2u * nw + wl];
  }

  // Store partial sums
  ws_xyz[tid * 3u] = px;
  ws_xyz[tid * 3u + 1u] = py;
  ws_xyz[tid * 3u + 2u] = pz;
  workgroupBarrier();

  // Phase 2: reduce (tree reduction for 256 threads)
  for (var stride = 128u; stride > 0u; stride >>= 1u) {
    if (tid < stride) {
      ws_xyz[tid * 3u]     += ws_xyz[(tid + stride) * 3u];
      ws_xyz[tid * 3u + 1u] += ws_xyz[(tid + stride) * 3u + 1u];
      ws_xyz[tid * 3u + 2u] += ws_xyz[(tid + stride) * 3u + 2u];
    }
    workgroupBarrier();
  }

  // Phase 3: thread 0 writes chromaticity
  if (tid == 0u) {
    let X = ws_xyz[0];
    let Y = ws_xyz[1];
    let Z = ws_xyz[2];
    let S = X + Y + Z;
    out_xy[pid * 2u] = X / S;
    out_xy[pid * 2u + 1u] = Y / S;
  }
}
`;

export class GPUCompute {
  constructor() {
    this.device = null;
    this.pipeline = null;
    this.ready = false;
  }

  async init() {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    this.device = await adapter.requestDevice();

    const module = this.device.createShaderModule({ code: FORWARD_SHADER });
    this.pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'forward' },
    });
    this.ready = true;
    return true;
  }

  /**
   * Run forward pass for multiple weight vectors in parallel on the GPU.
   * @param {Float32Array[]} weightVectors - Array of weight vectors
   * @param {Float32Array} spdFlat - Flattened SPD matrix [numEmitters * numWavelengths]
   * @param {Float32Array} cieXYZ - Flattened CIE XYZ [3 * numWavelengths]
   * @param {number} numEmitters
   * @param {number} numWavelengths
   * @returns {{ xy: Float32Array, emission: Float32Array }} chromaticities and emissions
   */
  async forward(weightVectors, spdFlat, cieXYZ, numEmitters, numWavelengths) {
    const numPert = weightVectors.length;

    // Pack all weight vectors into a single buffer
    const allWeights = new Float32Array(numPert * numEmitters);
    for (let i = 0; i < numPert; i++) {
      allWeights.set(weightVectors[i], i * numEmitters);
    }

    const dev = this.device;

    // Uniform buffer
    const paramsData = new Uint32Array([numEmitters, numWavelengths, numPert, 0]);
    const paramsBuf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(paramsBuf, 0, paramsData);

    // Storage buffers
    const weightsBuf = dev.createBuffer({ size: allWeights.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(weightsBuf, 0, allWeights);

    const spdBuf = dev.createBuffer({ size: spdFlat.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(spdBuf, 0, spdFlat);

    const cieBuf = dev.createBuffer({ size: cieXYZ.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(cieBuf, 0, cieXYZ);

    const xySize = numPert * 2 * 4;
    const xyBuf = dev.createBuffer({ size: xySize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const emSize = numPert * numWavelengths * 4;
    const emBuf = dev.createBuffer({ size: emSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

    // Bind group
    const bindGroup = dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: weightsBuf } },
        { binding: 2, resource: { buffer: spdBuf } },
        { binding: 3, resource: { buffer: cieBuf } },
        { binding: 4, resource: { buffer: xyBuf } },
        { binding: 5, resource: { buffer: emBuf } },
      ],
    });

    // Dispatch
    const encoder = dev.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(numPert);
    pass.end();

    // Readback
    const xyReadBuf = dev.createBuffer({ size: xySize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const emReadBuf = dev.createBuffer({ size: emSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.copyBufferToBuffer(xyBuf, 0, xyReadBuf, 0, xySize);
    encoder.copyBufferToBuffer(emBuf, 0, emReadBuf, 0, emSize);
    dev.queue.submit([encoder.finish()]);

    await xyReadBuf.mapAsync(GPUMapMode.READ);
    await emReadBuf.mapAsync(GPUMapMode.READ);
    const xy = new Float32Array(xyReadBuf.getMappedRange().slice(0));
    const emission = new Float32Array(emReadBuf.getMappedRange().slice(0));
    xyReadBuf.unmap();
    emReadBuf.unmap();

    // Cleanup
    paramsBuf.destroy();
    weightsBuf.destroy();
    spdBuf.destroy();
    cieBuf.destroy();
    xyBuf.destroy();
    emBuf.destroy();
    xyReadBuf.destroy();
    emReadBuf.destroy();

    return { xy, emission };
  }
}

// ─── Spectral Optimizer ─────────────────────────────────────────────────────

export class SpectralOptimizer {
  /**
   * @param {object} opts
   * @param {Float32Array} opts.spdMatrix - Flattened [numEmitters x 401]
   * @param {number} opts.numEmitters
   * @param {Float32Array} opts.cieX - CIE X response (401)
   * @param {Float32Array} opts.cieY - CIE Y response (401)
   * @param {Float32Array} opts.cieZ - CIE Z response (401)
   * @param {GPUCompute|null} opts.gpu - WebGPU backend (or null for CPU)
   */
  constructor(opts) {
    this.spdMatrix = opts.spdMatrix;
    this.numEmitters = opts.numEmitters;
    this.numWavelengths = 401;
    this.cieX = opts.cieX;
    this.cieY = opts.cieY;
    this.cieZ = opts.cieZ;
    this.gpu = opts.gpu;

    // Packed CIE for GPU
    this.cieXYZ = new Float32Array(3 * 401);
    this.cieXYZ.set(this.cieX, 0);
    this.cieXYZ.set(this.cieY, 401);
    this.cieXYZ.set(this.cieZ, 802);

    // Precompute per-emitter CIE dot products for analytical gradient
    this.emitterCieX = new Float32Array(this.numEmitters);
    this.emitterCieY = new Float32Array(this.numEmitters);
    this.emitterCieZ = new Float32Array(this.numEmitters);
    for (let e = 0; e < this.numEmitters; e++) {
      let sx = 0, sy = 0, sz = 0;
      for (let w = 0; w < 401; w++) {
        const spd = this.spdMatrix[e * 401 + w];
        sx += spd * this.cieX[w];
        sy += spd * this.cieY[w];
        sz += spd * this.cieZ[w];
      }
      this.emitterCieX[e] = sx;
      this.emitterCieY[e] = sy;
      this.emitterCieZ[e] = sz;
    }

    // Current state
    this.weights = new Float32Array(this.numEmitters).fill(0.5);
    this.optimizer = null;
    this.iteration = 0;
    this.running = false;
    this.mode = 'chromaticity'; // or 'cct'
    this.targetX = 0.3127;
    this.targetY = 0.3290;
    this.targetCCT = 4000;
    this.refSpectrum = null; // For CCT mode

    // SSI/chromaticity loss weights (matching Python)
    this.ssiWeight = 1.0 / 2500.0;
    this.chromWeight = 1.0 / 5.0;

    // Target SSI goal for CCT mode (100 = best quality, 0 = worst)
    this.targetSSI = 100;

    // Color boost state
    this.colorSampleReflectance = null; // Float32Array(401) for selective color boost
    this.boostWeight = 1.0 / 100.0;    // Weight for color boost objective

    // Precomputed per-emitter dot products with color sample (set in setColorBoost)
    this.emitterSampleDots = null;

    // Results
    this.emission = null;
    this.chromaticity = null;
    this.loss = 0;
    this.ssiScore = 0;
    this.lossHistory = [];
  }

  /** Set target chromaticity and initialize optimizer.
   *  If keepWeights is true, start from current weights instead of resetting. */
  setTargetChromaticity(x, y, lr = 5e-4, keepWeights = false) {
    this.mode = 'chromaticity';
    this.targetX = x;
    this.targetY = y;
    if (!keepWeights) this.weights.fill(0.5);
    this.optimizer = new AdamOptimizer(this.numEmitters, lr);
    this.iteration = 0;
    this.lossHistory = [];
  }

  /** Set target CCT and initialize optimizer.
   *  If keepWeights is true, start from current weights instead of resetting. */
  setTargetCCT(cctKelvin, lr = 5e-5, keepWeights = false) {
    this.mode = 'cct';
    this.targetCCT = cctKelvin;
    const wavelengths = [];
    for (let i = 0; i < 401; i++) wavelengths.push(380 + i);
    this.refSpectrum = blackbodySpectrum(cctKelvin, wavelengths);

    // Also compute reference chromaticity
    const refChrom = computeChromaticity(this.refSpectrum, this.cieX, this.cieY, this.cieZ);
    this.targetX = refChrom.x;
    this.targetY = refChrom.y;

    if (!keepWeights) this.weights.fill(0.5);
    this.optimizer = new AdamOptimizer(this.numEmitters, lr);
    this.iteration = 0;
    this.lossHistory = [];
  }

  /**
   * Set a target spectral shape for optimization.
   * The optimizer will minimize weighted spectral distance to this target.
   * @param {Float32Array} targetSpectrum - 401-sample target (380-780nm)
   * @param {string} label - Display label for this target
   */
  setTargetSpectrum(targetSpectrum, label = 'spectrum', lr = 5e-4, keepWeights = false) {
    this.mode = 'spectral';
    this.refSpectrum = targetSpectrum;
    this.targetLabel = label;

    // Compute reference chromaticity for display
    const refChrom = computeChromaticity(this.refSpectrum, this.cieX, this.cieY, this.cieZ);
    this.targetX = refChrom.x;
    this.targetY = refChrom.y;

    if (!keepWeights) this.weights.fill(0.5);
    this.optimizer = new AdamOptimizer(this.numEmitters, lr);
    this.iteration = 0;
    this.lossHistory = [];
  }

  /**
   * Enter color-boost mode: maximize response of a color sample's reflectance
   * under the current emission, while maintaining chromaticity match.
   * Starts from current weights (should be called after primary convergence).
   * @param {Float32Array} sampleReflectance - 401-sample reflectance (380-780nm)
   * @param {number} targetX - chromaticity x to maintain
   * @param {number} targetY - chromaticity y to maintain
   */
  setColorBoost(sampleReflectance, targetX, targetY, lr = 5e-4) {
    this.mode = 'colorBoost';
    this.colorSampleReflectance = sampleReflectance;
    this.targetX = targetX;
    this.targetY = targetY;

    // Precompute per-emitter dot products with the color sample
    this.emitterSampleDots = new Float32Array(this.numEmitters);
    for (let e = 0; e < this.numEmitters; e++) {
      let dot = 0;
      for (let w = 0; w < 401; w++) {
        dot += this.spdMatrix[e * 401 + w] * sampleReflectance[w];
      }
      this.emitterSampleDots[e] = dot;
    }

    this.optimizer = new AdamOptimizer(this.numEmitters, lr);
    this.iteration = 0;
    this.lossHistory = [];
  }

  /** Run a single optimization step. Returns the current state. */
  step() {
    if (!this.optimizer) return null;

    // Forward pass
    this.emission = computeEmission(this.weights, this.spdMatrix, this.numEmitters, 401);
    this.chromaticity = computeChromaticity(this.emission, this.cieX, this.cieY, this.cieZ);

    // Compute loss and gradients
    let grads;
    if (this.mode === 'colorBoost') {
      // Maximize color sample response while maintaining chromaticity.
      // response = sum(emission * sampleReflectance)
      // loss = -response (we minimize, so negate to maximize)
      // Combined with chromaticity constraint.
      const chromResult = this._chromaticityLossAndGrad();

      // Compute sample response and its analytical gradient
      let response = 0;
      for (let w = 0; w < 401; w++) {
        response += this.emission[w] * this.colorSampleReflectance[w];
      }
      // d(response)/d(weight_i) = emitterSampleDots[i] (precomputed)
      // We want to MAXIMIZE response, so gradient for loss = -response is -emitterSampleDots

      // The chromaticity constraint must strongly dominate to maintain chroma.
      // Scale boost gradient to be small relative to chromaticity gradient.
      const boostW = this.boostWeight;
      const chromW = 10.0; // Very strong chromaticity constraint for color boost
      this.loss = -boostW * response + chromW * chromResult.loss;
      this.ssiScore = response; // Repurpose ssiScore to show response magnitude
      grads = new Float32Array(this.numEmitters);
      for (let i = 0; i < this.numEmitters; i++) {
        grads[i] = -boostW * this.emitterSampleDots[i] + chromW * chromResult.grads[i];
      }
    } else if (this.mode === 'chromaticity') {
      const result = this._chromaticityLossAndGrad();
      this.loss = result.loss;
      grads = result.grads;
      this.ssiScore = 0;
    } else if (this.mode === 'spectral') {
      // Spectral mode: SSI + chromaticity (same as CCT but with arbitrary target)
      const chromResult = this._chromaticityLossAndGrad();
      const ssiResult = this._ssiLossAndGrad();
      this.loss = this.ssiWeight * ssiResult.loss + this.chromWeight * chromResult.loss;
      this.ssiScore = ssiResult.ssi;
      grads = new Float32Array(this.numEmitters);
      for (let i = 0; i < this.numEmitters; i++) {
        grads[i] = this.ssiWeight * ssiResult.grads[i] + this.chromWeight * chromResult.grads[i];
      }
    } else {
      // CCT mode: chromaticity + SSI losses
      // SSI loss targets the exact targetSSI value: loss = |SSI - targetSSI|
      // When targetSSI < 100, the optimizer actively pushes SSI DOWN toward it.
      const chromResult = this._chromaticityLossAndGrad();
      const ssiResult = this._ssiLossAndGrad();
      this.ssiScore = ssiResult.ssi;

      // Target a specific SSI value. ssiResult.loss = (100 - SSI).
      // We minimize |SSI - targetSSI|, flipping the SSI gradient sign
      // when SSI overshoots the goal (to push it back down).
      const goalLoss = 100 - this.targetSSI;
      const ssiDelta = ssiResult.loss - goalLoss;
      const ssiSign = ssiDelta > 0 ? 1 : -1;
      const targetedSsiLoss = Math.abs(ssiDelta);

      this.loss = this.ssiWeight * targetedSsiLoss + this.chromWeight * chromResult.loss;
      grads = new Float32Array(this.numEmitters);
      for (let i = 0; i < this.numEmitters; i++) {
        grads[i] = this.ssiWeight * ssiSign * ssiResult.grads[i] + this.chromWeight * chromResult.grads[i];
      }
    }

    // Apply zero gradient for clamped weights (projection)
    for (let i = 0; i < this.numEmitters; i++) {
      if ((this.weights[i] <= 0 && grads[i] > 0) ||
          (this.weights[i] >= 1 && grads[i] < 0)) {
        grads[i] = 0;
      }
    }

    this.optimizer.step(this.weights, grads);
    this.iteration++;
    this.lossHistory.push(this.loss);

    return this.getState();
  }

  /** Run a batch of steps (for animation frame). */
  stepBatch(count = 10) {
    let state;
    for (let i = 0; i < count; i++) state = this.step();
    return state;
  }

  /** Analytical gradient for chromaticity Euclidean distance loss. */
  _chromaticityLossAndGrad() {
    const { x, y, X, Y, Z, S } = this.chromaticity;
    const dx = x - this.targetX;
    const dy = y - this.targetY;
    const loss = Math.sqrt(dx * dx + dy * dy + 1e-9);

    // d(loss)/d(x,y)
    const dloss_dx = dx / loss;
    const dloss_dy = dy / loss;

    // d(x,y)/d(X,Y,Z) — Jacobian of chromaticity w.r.t. tristimulus
    const S2 = S * S;
    const dloss_dX = dloss_dx * (Y + Z) / S2 + dloss_dy * (-Y) / S2;
    const dloss_dY = dloss_dx * (-X) / S2 + dloss_dy * (X + Z) / S2;
    const dloss_dZ = dloss_dx * (-X) / S2 + dloss_dy * (-Y) / S2;

    // d(X,Y,Z)/d(weights) — precomputed dot products
    const grads = new Float32Array(this.numEmitters);
    for (let i = 0; i < this.numEmitters; i++) {
      const w = Math.max(0, Math.min(1, this.weights[i]));
      // Only contribute gradient if weight is active
      grads[i] = dloss_dX * this.emitterCieX[i]
               + dloss_dY * this.emitterCieY[i]
               + dloss_dZ * this.emitterCieZ[i];
    }

    return { loss, grads };
  }

  /** Numerical gradient for SSI loss via finite differences. */
  _ssiLossAndGrad() {
    const eps = 1e-4;

    // Base SSI
    const baseEmission = this.emission;
    const baseSsi = computeSSI(
      baseEmission.slice(0, 301),
      this.refSpectrum.slice(0, 301)
    );
    const baseLoss = 100 - baseSsi;

    const grads = new Float32Array(this.numEmitters);
    for (let i = 0; i < this.numEmitters; i++) {
      const origW = this.weights[i];
      this.weights[i] = origW + eps;
      const pertEmission = computeEmission(this.weights, this.spdMatrix, this.numEmitters, 401);
      const pertSsi = computeSSI(
        pertEmission.slice(0, 301),
        this.refSpectrum.slice(0, 301)
      );
      const pertLoss = 100 - pertSsi;
      grads[i] = (pertLoss - baseLoss) / eps;
      this.weights[i] = origW;
    }

    return { loss: baseLoss, grads, ssi: baseSsi };
  }

  /** Get current optimizer state for visualization. */
  getState() {
    return {
      iteration: this.iteration,
      weights: new Float32Array(this.weights).map(w => Math.max(0, Math.min(1, w))),
      emission: this.emission,
      chromaticity: this.chromaticity ? { x: this.chromaticity.x, y: this.chromaticity.y } : null,
      loss: this.loss,
      ssiScore: this.ssiScore,
      mode: this.mode,
      targetX: this.targetX,
      targetY: this.targetY,
      targetCCT: this.targetCCT,
      refSpectrum: this.refSpectrum,
    };
  }
}
