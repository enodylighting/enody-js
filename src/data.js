/**
 * Bundled sample data and color response curves.
 *
 * The SDK loads the JSON assets once at module import time so consumers can
 * use the helper functions synchronously in both browsers and Node.js.
 */

import { Fixture } from './device.js';

async function loadBundledJson(url) {
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(url, 'utf8'));
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load bundled data from ${url}`);
  }
  return response.json();
}

const fixtureJsonUrl = new URL('./data/fixture.json', import.meta.url);
const responseJsonUrl = new URL('./data/response.json', import.meta.url);

const fixtureJson = await loadBundledJson(fixtureJsonUrl);
const responseJson = await loadBundledJson(responseJsonUrl);

function responseMeasurements(name) {
  const response = responseJson[name];
  if (Array.isArray(response)) {
    return response.map((sample) => sample.measurement);
  }
  return [...response.values];
}

export function sampleFixture() {
  return Fixture.fromJson(fixtureJson);
}

export function sampleSource() {
  return sampleFixture()._sources[0];
}

export function sampleEmitter() {
  return sampleSource()._emitters[0];
}

export function melanopicAction() {
  return responseMeasurements('Melanopic response');
}

export function rhodopicAction() {
  return responseMeasurements('Rhodopic response');
}

export function sConeAction() {
  return responseMeasurements('S-cone-opic response');
}

export function mConeAction() {
  return responseMeasurements('M-cone-opic response');
}

export function lConeAction() {
  return responseMeasurements('L-cone-opic response');
}

export function cieXAction() {
  return responseMeasurements('CIE-X response');
}

export function cieYAction() {
  return responseMeasurements('CIE-Y response');
}

export function cieZAction() {
  return responseMeasurements('CIE-Z response');
}

export function sampleFixtureJson() {
  return fixtureJson;
}

export function responseJsonData() {
  return responseJson;
}
