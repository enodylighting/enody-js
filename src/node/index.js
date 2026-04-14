import { createNodeSerialProvider } from './serial-provider.js';
import { setDefaultSerialProvider } from '../serial-provider-registry.js';

setDefaultSerialProvider(createNodeSerialProvider());

export * from '../public-api.js';
