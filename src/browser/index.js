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

  addEventListener(type, listener, options) {
    if (typeof navigator === 'undefined' || !navigator.serial?.addEventListener) {
      return;
    }
    navigator.serial.addEventListener(type, listener, options);
  },

  removeEventListener(type, listener, options) {
    if (typeof navigator === 'undefined' || !navigator.serial?.removeEventListener) {
      return;
    }
    navigator.serial.removeEventListener(type, listener, options);
  },
});

export * from '../public-api.js';
