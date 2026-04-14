/**
 * Default source entrypoint for local Node-based development and tests.
 *
 * Published consumers should import from `enody`, which resolves to the
 * browser or Node entrypoint through package conditional exports.
 */

export * from './node/index.js';
