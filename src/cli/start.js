import { startDaemon } from '../daemon/lifecycle.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function startCommand() {
  const cwd = process.cwd();
  const cfgPath = join(cwd, '.walkie-talkie', 'config.json');
  if (!existsSync(cfgPath)) {
    console.error('No .walkie-talkie/ here. Run `walkie init` first.');
    process.exit(1);
  }
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  const status = await startDaemon(cwd, { projectName: cfg.projectName });
  console.log(`Daemon running on http://127.0.0.1:${status.port} (pid ${status.pid})`);
}
