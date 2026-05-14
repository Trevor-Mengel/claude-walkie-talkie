import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, '../../src/daemon/daemon-entry.js');

export async function spawnDaemon(wtDir) {
  const child = spawn(process.execPath, [ENTRY, wtDir, 'test'], { stdio: 'ignore', detached: false });
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(join(wtDir, 'server.port')) && existsSync(join(wtDir, 'server.pid'))) {
      const port = Number(readFileSync(join(wtDir, 'server.port'), 'utf8'));
      return { child, port };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error('daemon never wrote PID/port files');
}
