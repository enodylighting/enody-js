function normalizeUsbNumber(value) {
  if (value == null || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return value;
  }

  return Number.parseInt(String(value), 16);
}

function matchesFilters(info, filters = []) {
  if (!filters || filters.length === 0) {
    return true;
  }

  const vendorId = normalizeUsbNumber(info.vendorId);
  const productId = normalizeUsbNumber(info.productId);

  return filters.some((filter) => {
    if (filter.usbVendorId != null && vendorId !== filter.usbVendorId) {
      return false;
    }
    if (filter.usbProductId != null && productId !== filter.usbProductId) {
      return false;
    }
    return true;
  });
}

async function loadSerialPortModule() {
  try {
    return await import('serialport');
  } catch (error) {
    throw new Error(
      'The Node serial backend requires the `serialport` package. Run `npm install @enody/enody` to install package dependencies before using Node hardware access.',
      { cause: error },
    );
  }
}

class NodeSerialReader {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async read() {
    return this.adapter.read();
  }

  async cancel() {
    this.adapter.cancelReads();
  }

  releaseLock() {}
}

class NodeSerialWriter {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async write(data) {
    await this.adapter.write(data);
  }

  releaseLock() {}
}

class NodeSerialPortAdapter {
  constructor(info) {
    this.info = info;
    this.path = info.path;
    this._port = null;
    this._readQueue = [];
    this._pendingReads = [];
    this._closed = true;
    this._lastError = null;
  }

  get readable() {
    return {
      getReader: () => new NodeSerialReader(this),
    };
  }

  get writable() {
    return {
      getWriter: () => new NodeSerialWriter(this),
    };
  }

  async open(options) {
    if (this._port?.isOpen) {
      return;
    }

    const { SerialPort } = await loadSerialPortModule();

    this._readQueue = [];
    this._pendingReads = [];
    this._lastError = null;
    this._closed = false;

    const port = new SerialPort({
      path: this.path,
      baudRate: options.baudRate,
      autoOpen: false,
      dataBits: options.dataBits,
      stopBits: options.stopBits,
      parity: options.parity,
    });

    port.on('data', (chunk) => {
      const value = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (this._pendingReads.length > 0) {
        const pending = this._pendingReads.shift();
        pending.resolve({ value, done: false });
        return;
      }
      this._readQueue.push(value);
    });

    port.on('error', (error) => {
      this._lastError = error;
      while (this._pendingReads.length > 0) {
        this._pendingReads.shift().reject(error);
      }
    });

    port.on('close', () => {
      this._closed = true;
      while (this._pendingReads.length > 0) {
        this._pendingReads.shift().resolve({ value: undefined, done: true });
      }
    });

    await new Promise((resolve, reject) => {
      port.open((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this._port = port;
  }

  async close() {
    if (!this._port) {
      this._closed = true;
      return;
    }

    const port = this._port;
    this._port = null;

    await new Promise((resolve, reject) => {
      port.close((error) => {
        if (error && error.message && !error.message.includes('Port is not open')) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async setSignals(signals) {
    if (!this._port) {
      throw new Error('Serial port is not open');
    }

    await new Promise((resolve, reject) => {
      this._port.set({
        dtr: signals.dataTerminalReady,
        rts: signals.requestToSend,
      }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async read() {
    if (this._lastError) {
      const error = this._lastError;
      this._lastError = null;
      throw error;
    }

    if (this._readQueue.length > 0) {
      return { value: this._readQueue.shift(), done: false };
    }

    if (this._closed) {
      return { value: undefined, done: true };
    }

    return new Promise((resolve, reject) => {
      this._pendingReads.push({ resolve, reject });
    });
  }

  cancelReads() {
    while (this._pendingReads.length > 0) {
      this._pendingReads.shift().resolve({ value: undefined, done: true });
    }
  }

  async write(data) {
    if (!this._port) {
      throw new Error('Serial port is not open');
    }

    const buffer = Buffer.from(data);

    await new Promise((resolve, reject) => {
      this._port.write(buffer, (error) => {
        if (error) {
          reject(error);
          return;
        }
        this._port.drain((drainError) => {
          if (drainError) {
            reject(drainError);
            return;
          }
          resolve();
        });
      });
    });
  }
}

export function createNodeSerialProvider() {
  return {
    async getPorts(options = {}) {
      const { SerialPort } = await loadSerialPortModule();
      const filters = options.filters ?? [];
      const ports = await SerialPort.list();
      if (options.path) {
        return ports
          .filter((info) => info.path === options.path)
          .map((info) => new NodeSerialPortAdapter(info));
      }
      return ports
        .filter((info) => matchesFilters(info, filters))
        .map((info) => new NodeSerialPortAdapter(info));
    },

    async requestPort(options = {}) {
      const requestedPath = options.path ?? process.env.ENODY_PORT ?? null;
      const ports = await this.getPorts(options);

      if (requestedPath) {
        const requested = ports.find((port) => port.path === requestedPath);
        if (!requested) {
          throw new Error(`No matching serial device found for path ${requestedPath}`);
        }
        return requested;
      }

      if (ports.length === 0) {
        throw new Error('No matching Enody serial devices were found');
      }

      if (ports.length > 1) {
        const available = ports.map((port) => port.path).join(', ');
        throw new Error(
          `Multiple serial devices matched. Set ENODY_PORT or pass { path } explicitly. Available: ${available}`,
        );
      }

      return ports[0];
    },
  };
}
