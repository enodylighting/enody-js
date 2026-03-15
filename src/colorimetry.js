/**
 * Lightweight color science primitives shared across the SDK.
 *
 * These mirror the Python package's core types closely enough to support
 * offline fixture/sample-data workflows in the browser and Node.js.
 */

export class Chromaticity {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

export class XYZ {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

export class SpectralSample {
  constructor(wavelength, measurement) {
    this.wavelength = wavelength;
    this.measurement = measurement;
  }
}

export class SpectralData {
  static fromJson(jsonData, name = null) {
    if (Array.isArray(jsonData)) {
      return new SpectralData(
        jsonData.map((sample) => new SpectralSample(sample.wavelength, sample.measurement)),
        name,
      );
    }

    if (jsonData?.wavelengths && jsonData?.values) {
      const samples = [];
      const count = Math.min(jsonData.wavelengths.length, jsonData.values.length);
      for (let index = 0; index < count; index += 1) {
        samples.push(new SpectralSample(jsonData.wavelengths[index], jsonData.values[index]));
      }
      return new SpectralData(samples, name);
    }

    throw new Error('Unsupported spectral data JSON shape');
  }

  constructor(samples, name = null) {
    this._samples = samples;
    this._name = name;
  }

  name() {
    return this._name;
  }

  samples() {
    return this._samples;
  }

  sampleCount() {
    return this._samples.length;
  }

  wavelengths() {
    return this._samples.map((sample) => sample.wavelength);
  }

  measurements() {
    return this._samples.map((sample) => sample.measurement);
  }

  values() {
    return this.measurements();
  }

  tensor() {
    return Float32Array.from(this.measurements());
  }
}
