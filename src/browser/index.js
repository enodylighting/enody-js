import { setDefaultSerialProvider } from '../serial-provider-registry.js';

setDefaultSerialProvider({
  async getPorts() {
    if (typeof navigator === 'undefined' || !navigator.serial) {
      throw new Error('WebSerial is not available in this environment');
    }
    return navigator.serial.getPorts();
  },

  async requestPort(options = {}) {
    if (typeof navigator === 'undefined' || !navigator.serial) {
      throw new Error('WebSerial is not available in this environment');
    }
    return navigator.serial.requestPort(options);
  },
});

export * from '../public-api.js';
