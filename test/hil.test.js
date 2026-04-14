/**
 * Hardware-in-the-loop smoke test for a connected EP01.
 *
 * This is intentionally opt-in and lenient:
 * - if no device is attached, the test exits successfully with a skip message
 * - set ENODY_REQUIRE_DEVICE=1 to turn "no device found" into a failure
 * - set ENODY_PORT=/dev/tty... to force a specific serial device in Node
 */

import { UsbEnvironment } from '../src/index.js';

async function main() {
  const environment = new UsbEnvironment();
  const runtimes = await environment.runtimes({
    requestPort: false,
    path: process.env.ENODY_PORT,
  });

  if (runtimes.length === 0) {
    const message = 'SKIP: no compatible EP01 serial devices found';
    if (process.env.ENODY_REQUIRE_DEVICE === '1') {
      throw new Error(message);
    }
    console.log(message);
    return;
  }

  const runtime = runtimes[0];
  const host = await runtime.host();
  const fixtures = await host.fixtures();

  console.log(`Connected to host ${host.identifier()} (v${host.versionString})`);
  console.log(`Fixtures: ${fixtures.length}`);

  if (fixtures.length > 0) {
    const sources = await fixtures[0].sources();
    console.log(`Sources in first fixture: ${sources.length}`);
    if (sources.length > 0) {
      const emitters = await sources[0].emitters();
      console.log(`Emitters in first source: ${emitters.length}`);
    }
  }

  await environment.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
