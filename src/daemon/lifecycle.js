import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, 'daemon-entry.js');

function paths(projectRoot) {
  const wt = join(projectRoot, '.walkie-talkie');
  return { wt, pid: join(wt, 'server.pid'), port: join(wt, 'server.port') };
}

async function readPid(projectRoot) {
  const p = paths(projectRoot);
  if (!existsSync(p.pid)) return null;
  const txt = await readFile(p.pid, 'utf8');
  return Number(txt.trim());
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function statusDaemon(projectRoot) {
  const pid = await readPid(projectRoot);
  if (!pid || !isAlive(pid)) return { running: false };
  const p = paths(projectRoot);
  const port = existsSync(p.port) ? Number((await readFile(p.port, 'utf8')).trim()) : null;
  return { running: true, pid, port };
}

export async function startDaemon(projectRoot, { projectName = 'project' } = {}) {
  const current = await statusDaemon(projectRoot);
  if (current.running) return current;
  const p = paths(projectRoot);
  const child = spawn(process.execPath, [ENTRY, p.wt, projectName], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(p.pid) && existsSync(p.port)) {
      return statusDaemon(projectRoot);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('daemon failed to start within 5 seconds');
}

export async function stopDaemon(projectRoot) {
  const pid = await readPid(projectRoot);
  if (pid && isAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch (_e) {}
  }
  const p = paths(projectRoot);
  try { await unlink(p.pid); } catch (_e) {}
  try { await unlink(p.port); } catch (_e) {}
}

export async function ensureRunning(projectRoot, opts) {
  const status = await statusDaemon(projectRoot);
  if (status.running) return status;
  return startDaemon(projectRoot, opts);
}
