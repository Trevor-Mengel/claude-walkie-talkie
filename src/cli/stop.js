import { stopDaemon, statusDaemon } from '../daemon/lifecycle.js';

export async function stopCommand() {
  const before = await statusDaemon(process.cwd());
  if (!before.running) {
    console.log('Daemon is not running.');
    return;
  }
  await stopDaemon(process.cwd());
  console.log(`Daemon stopped (pid ${before.pid}).`);
}
