import {
  EP01_FLASH_SIZE,
  EP01_FLASH_SIZE_BYTES,
  ESPFlasher,
  FlashProgressTracker,
  createEp01FlashOptions,
  roundEraseSizeToSectors,
} from '../src/esp-flasher.js';
import { UpdateTarget } from '../src/update.js';
import { ESPLoader } from 'esptool-js/bundle.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`PASS: ${message}`);
    return;
  }

  failed += 1;
  console.error(`FAIL: ${message}`);
}

async function assertRejects(promise, predicate, message) {
  try {
    await promise;
    assert(false, message);
  } catch (error) {
    assert(predicate(error), message);
  }
}

function fakePort(label) {
  return {
    label,
    readable: true,
    writable: true,
    getInfo() {
      return {
        usbVendorId: 0x303a,
        usbProductId: 0x1001,
      };
    },
  };
}

function createFakeSerial(initialPorts = []) {
  const listeners = new Map();
  let ports = initialPorts;
  return {
    setPorts(nextPorts) {
      ports = nextPorts;
    },

    async getPorts() {
      return ports;
    },

    addEventListener(type, listener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type).add(listener);
    },

    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },

    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
  };
}

// --- Pure EP01 flash option helpers ---
{
  const options = createEp01FlashOptions([{ data: new Uint8Array([1]), address: 0 }], () => {});

  assert(options.compress === false, 'EP01 flash options disable compression');
  assert(options.eraseAll === false, 'EP01 flash options do not use stub-only erase-all');
  assert(options.flashSize === EP01_FLASH_SIZE, 'EP01 flash options use the 8MB flash size string');
  assert(EP01_FLASH_SIZE_BYTES === 8 * 1024 * 1024, 'EP01 flash size is 8MB in bytes');
  assert(roundEraseSizeToSectors(1) === 0x1000, 'Erase size rounds one byte to one 4KB sector');
  assert(roundEraseSizeToSectors(0x1001) === 0x2000, 'Erase size rounds partial sectors up to 4KB boundaries');
}

// --- FlashProgressTracker preserves ACKed blocks across ROM sessions ---
{
  const payloads = [
    { data: new Uint8Array(5), address: 0x8000 },
    { data: new Uint8Array(2), address: 0x20000 },
  ];
  const tracker = new FlashProgressTracker(payloads);

  tracker.prepare(payloads, 4);
  tracker.acknowledgeBlock(0, 0);

  assert(tracker.payloadWritten(0) === 4, 'Flash progress tracker records first ACKed block bytes');
  assert(tracker.isPayloadComplete(0) === false, 'Flash progress tracker leaves payload incomplete until all blocks ACK');

  tracker.acknowledgeBlock(0, 1);
  tracker.acknowledgeBlock(1, 0);

  assert(tracker.payloadWritten(0) === 5, 'Flash progress tracker clamps padded writes to payload length');
  assert(tracker.isComplete() === true, 'Flash progress tracker reports complete after all payload blocks ACK');
}

// --- ESPFlasher adapter configures esptool-js for EP01 SDM flashing ---
{
  const logs = [];
  const loaderInstances = [];

  class FakeTransport {
    constructor(port, tracing) {
      this.device = port;
      this.tracing = tracing;
      this.disconnects = 0;
    }

    setDeviceLostCallback(callback) {
      this.deviceLostCallback = callback;
    }

    async disconnect() {
      this.disconnects += 1;
    }
  }

  class FakeLoader {
    constructor(options) {
      this.options = options;
      this.calls = [];
      this.writeRegCalls = [];
      this.writeFlashCalls = [];
      this.secureDownloadMode = true;
      this.IS_STUB = false;
      this.FLASH_WRITE_SIZE = 0x4000;
      this.chip = {
        CHIP_NAME: 'ESP32-C6',
        FLASH_WRITE_SIZE: 0x400,
        getEraseSize: (_offset, size) => size,
      };
      loaderInstances.push(this);
    }

    async connect(mode, attempts, detecting) {
      this.calls.push(['connect', mode, attempts, detecting]);
    }

    async flashSpiAttach(value) {
      this.calls.push(['flashSpiAttach', value]);
    }

    async flashSetParameters(size) {
      this.calls.push(['flashSetParameters', size]);
    }

    async flashBegin(size, address) {
      this.calls.push(['flashBegin', size, address]);
      return Math.ceil(size / this.FLASH_WRITE_SIZE);
    }

    async flashFinish(reboot, timeout) {
      this.calls.push(['flashFinish', reboot, timeout]);
    }

    async changeBaud() {
      this.calls.push(['changeBaud']);
    }

    async writeReg(address, value, mask) {
      this.writeRegCalls.push([address, value, mask]);
    }

    async flashBlock(data, seq, timeout) {
      this.calls.push(['flashBlock', data.length, seq, timeout]);
    }

    async writeFlash(options) {
      this.writeFlashCalls.push(options);
      await this.flashBlock(new Uint8Array(this.FLASH_WRITE_SIZE), 0, 3000);
      options.reportProgress?.(0, options.fileArray[0].data.length, options.fileArray[0].data.length);
    }

    async softReset(stayInBootloader) {
      this.calls.push(['softReset', stayInBootloader]);
    }
  }

  const flasher = new ESPFlasher(fakePort('adapter'), {
    log: (message) => logs.push(message),
    ESPLoader: FakeLoader,
    Transport: FakeTransport,
  });

  await flasher.connect(115200, { flashBaudrate: 921600 });
  const loader = loaderInstances[0];

  assert(loader.calls.some((call) => call[0] === 'connect' && call[1] === 'default_reset' && call[2] === 7 && call[3] === true), 'Adapter uses esptool-js full reset/connect/chip-detect flow');
  assert(loader.calls.some((call) => call[0] === 'flashSpiAttach' && call[1] === 0), 'Adapter attaches SPI flash through esptool-js');
  assert(loader.calls.some((call) => call[0] === 'flashSetParameters' && call[1] === EP01_FLASH_SIZE_BYTES), 'Adapter sets 8MB SPI flash parameters');
  assert(loader.calls.some((call) => call[0] === 'changeBaud'), 'Adapter changes baud after initial ROM connection when requested');
  assert(loader.FLASH_WRITE_SIZE === 0x400, 'Adapter forces ESP32-C6 ROM flash write size instead of stub size');
  assert(loader.chip.getEraseSize(0x20000, 0x1001) === 0x2000, 'Adapter rounds esptool-js erase size to 4KB sectors');
  assert(loader.writeRegCalls.length >= 7, 'Adapter preserves ESP32-C6 watchdog disable through esptool-js writeReg');

  const progress = [];
  await flasher.flash([
    { data: new Uint8Array([1, 2, 3]), address: 0x8000 },
    { data: new Uint8Array([4, 5]), address: 0x20000 },
  ], (fileIndex, written, total) => progress.push([fileIndex, written, total]));

  const flashBeginCalls = loader.calls.filter((call) => call[0] === 'flashBegin');
  const flashFinishCalls = loader.calls.filter((call) => call[0] === 'flashFinish');

  assert(loader.writeFlashCalls.length === 0, 'Adapter avoids esptool-js writeFlash per-payload FLASH_END behavior in SDM');
  assert(flashBeginCalls.length === 2, 'Adapter starts each manifest payload with esptool-js flashBegin');
  assert(flashBeginCalls[0][2] === 0x8000, 'Adapter preserves first manifest payload address');
  assert(flashBeginCalls[1][2] === 0x20000, 'Adapter preserves second manifest payload address');
  assert(loader.calls.filter((call) => call[0] === 'flashSetParameters' && call[1] === EP01_FLASH_SIZE_BYTES).length >= 2, 'Adapter sets 8MB SPI flash parameters before connecting and flashing');
  assert(loader.calls.some((call) => call[0] === 'flashBlock' && call[1] === loader.FLASH_WRITE_SIZE), 'Adapter writes padded blocks through esptool-js flashBlock');
  assert(flashFinishCalls.length === 1, 'Adapter sends one FLASH_END after the full manifest');
  assert(flashFinishCalls[0][1] === true, 'Adapter requests reboot on the single SDM FLASH_END');
  assert(progress.some((entry) => entry[0] === 0 && entry[1] === 3 && entry[2] === 3), 'Adapter preserves first payload progress callback');
  assert(progress.some((entry) => entry[0] === 1 && entry[1] === 2 && entry[2] === 2), 'Adapter preserves second payload progress callback');
  assert(logs.some((line) => line.startsWith('rom:flash-data:block:ack')), 'Adapter emits FLASH_DATA ack diagnostics from esptool-js flashBlock');

  const resumePayload = { data: new Uint8Array(0x3000), address: 0x20000 };
  const resumeTracker = new FlashProgressTracker([resumePayload]);
  resumeTracker.prepare([resumePayload], loader.FLASH_WRITE_SIZE);
  for (let block = 0; block < 5; block += 1) {
    resumeTracker.acknowledgeBlock(0, block);
  }

  const callCountBeforeResume = loader.calls.length;
  await flasher.flash([resumePayload], () => {}, { progressTracker: resumeTracker });
  const resumeCalls = loader.calls.slice(callCountBeforeResume);
  const resumeFlashBegin = resumeCalls.find((call) => call[0] === 'flashBegin');

  assert(resumeFlashBegin[1] === 0x2000, 'Adapter rolls resumed erase size back to the previous 4KB sector');
  assert(resumeFlashBegin[2] === 0x21000, 'Adapter resumes FLASH_BEGIN on a 4KB sector boundary');
  assert(resumeTracker.isComplete(), 'Adapter completes the tracker after sector-aligned resume rewrite');
  assert(logs.some((line) => line.startsWith('rom:flash-payload:resume-rollback')), 'Adapter logs sector rollback before resumed FLASH_BEGIN');
}

// --- esptool-js parses ESP32-C6 GET_SECURITY_INFO data before ROM status bytes ---
{
  const securityInfoData = new Uint8Array(20);
  securityInfoData[0] = 0x04; // SECURE_DOWNLOAD_ENABLE flag
  securityInfoData[12] = 13; // ESP32-C6 IMAGE_CHIP_ID

  const response = new Uint8Array(8 + securityInfoData.length + 2);
  response[0] = 0x01;
  response[1] = 0x14;
  response.set(securityInfoData, 8);
  response[response.length - 2] = 0x00; // ROM status
  response[response.length - 1] = 0x00; // ROM error code

  class SecurityInfoTransport {
    constructor() {
      this.tracing = false;
      this.writes = [];
    }

    getInfo() {
      return 'fake security-info transport';
    }

    async write(data) {
      this.writes.push(data);
    }

    async read() {
      return response;
    }
  }

  const loader = new ESPLoader({
    transport: new SecurityInfoTransport(),
    baudrate: 115200,
    terminal: { clean() {}, write() {}, writeLine() {} },
  });
  const securityInfo = await loader.getSecurityInfo();

  assert(securityInfo.secureDownloadEnabled === true, 'esptool-js detects Secure Download Mode from GET_SECURITY_INFO flags');
  assert(securityInfo.chipId === 13, 'esptool-js parses ESP32-C6 chip ID before trailing ROM status bytes');
}

// --- UpdateTarget resumes the same flash stream after a WebSerial disconnect ---
{
  const port1 = fakePort('first');
  const port2 = fakePort('refreshed');
  const payloads = [{ data: new Uint8Array([1, 2, 3]), address: 0x8000 }];
  const logs = [];
  const sessions = [];
  const serial = createFakeSerial([port1]);
  let failFirstFlash = true;

  class FakeFlasher {
    constructor(port) {
      this.port = port;
      this.calls = [];
      sessions.push(this);
    }

    async connect(baudrate, options) {
      this.calls.push(['connect', baudrate, options.flashBaudrate]);
    }

    async flash(flashPayloads, onProgress, options) {
      this.calls.push(['flash', flashPayloads.length]);
      if (failFirstFlash) {
        failFirstFlash = false;
        options.progressTracker.prepare(flashPayloads, 1);
        options.progressTracker.acknowledgeBlock(0, 0);
        onProgress?.(0, 1, 3);
        serial.setPorts([port2]);
        setTimeout(() => serial.emit('connect', { target: port2 }), 0);
        const error = new Error('NetworkError: the device has been lost');
        error.name = 'NetworkError';
        throw error;
      }
      assert(options.progressTracker.payloadWritten(0) === 1, 'Retry session starts from the first un-ACKed byte');
      options.progressTracker.acknowledgeBlock(0, 1);
      onProgress?.(0, 2, 3);
      options.progressTracker.acknowledgeBlock(0, 2);
      onProgress?.(0, 3, 3);
    }

    async reboot() {
      this.calls.push(['reboot']);
    }

    async disconnect() {
      this.calls.push(['disconnect']);
    }
  }

  const target = new UpdateTarget({
    port: port1,
    serial,
    flasherFactory: (port) => new FakeFlasher(port),
  });

  await target.flashPayloads(payloads, {
    onLog: (message) => logs.push(message),
    flashBaudrate: 921600,
    refreshIntervalMs: 0,
    reconnectTimeoutMs: 100,
  });

  assert(sessions.length === 2, 'Disconnect during flash creates a second flasher session automatically');
  assert(sessions[0].port === port1, 'First flasher session uses the original selected port');
  assert(sessions[0].calls.map((call) => call[0]).join(',') === 'connect,flash,disconnect', 'Failed session connects, flashes, and disconnects stale transport');
  assert(logs.some((line) => line.startsWith('sdk:update:flash-payloads:disconnect-detected')), 'UpdateTarget logs disconnect detection');
  assert(logs.some((line) => line.startsWith('sdk:update:serial-reconnect:connect-event')), 'UpdateTarget resumes from a WebSerial connect event');
  assert(sessions[1].port === port2, 'Resume session uses the reconnected serial port');
  assert(sessions[1].calls.map((call) => call[0]).join(',') === 'connect,flash,reboot,disconnect', 'Resume session connects, flashes remaining blocks, reboots, and disconnects');
}

// --- UpdateTarget aborts reconnect waits with the caller-provided reason ---
{
  const port = fakePort('aborted');
  const payloads = [{ data: new Uint8Array([1, 2, 3]), address: 0x8000 }];
  const serial = createFakeSerial([port]);
  const controller = new AbortController();
  const abortReason = new Error('firmware progress stalled');
  abortReason.firmwareProgressStalled = true;

  class FakeFlasher {
    async connect() {}

    async flash() {
      const error = new Error('NetworkError: the device has been lost');
      error.name = 'NetworkError';
      throw error;
    }

    async disconnect() {
      setTimeout(() => controller.abort(abortReason), 0);
    }
  }

  const target = new UpdateTarget({
    port,
    serial,
    flasherFactory: () => new FakeFlasher(),
  });

  await assertRejects(
    target.flashPayloads(payloads, {
      signal: controller.signal,
      reconnectTimeoutMs: 5000,
    }),
    (error) => error === abortReason,
    'UpdateTarget aborts WebSerial reconnect waits with the caller-provided reason',
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
