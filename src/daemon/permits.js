import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function configPath(wtDir) {
  return join(wtDir, 'config.json');
}

async function loadConfig(wtDir) {
  const path = configPath(wtDir);
  if (!existsSync(path)) return { permits: [] };
  return JSON.parse(await readFile(path, 'utf8'));
}

async function saveConfig(wtDir, data) {
  await writeFile(configPath(wtDir), JSON.stringify(data, null, 2));
}

export async function listPermits(wtDir) {
  const cfg = await loadConfig(wtDir);
  return cfg.permits ?? [];
}

export async function grantPermit(wtDir, { sessionId, mode, durationMs }) {
  const cfg = await loadConfig(wtDir);
  cfg.permits = (cfg.permits ?? []).filter((p) => p.sessionId !== sessionId);
  const permit = { sessionId, mode };
  if (mode === 'duration' && durationMs) {
    permit.expiresAt = new Date(Date.now() + durationMs).toISOString();
  }
  cfg.permits.push(permit);
  await saveConfig(wtDir, cfg);
  return permit;
}

export async function revokePermit(wtDir, sessionId) {
  const cfg = await loadConfig(wtDir);
  cfg.permits = (cfg.permits ?? []).filter((p) => p.sessionId !== sessionId);
  await saveConfig(wtDir, cfg);
}

/**
 * Returns { allowed, reason? }. Consumes a "once" permit on success.
 */
export async function checkAndConsume(wtDir, sessionId) {
  const cfg = await loadConfig(wtDir);
  const permits = cfg.permits ?? [];
  const idx = permits.findIndex((p) => p.sessionId === sessionId);
  if (idx === -1) return { allowed: false, reason: 'no permit' };
  const permit = permits[idx];
  if (permit.mode === 'always') return { allowed: true };
  if (permit.mode === 'duration') {
    if (new Date(permit.expiresAt).getTime() < Date.now()) {
      permits.splice(idx, 1);
      cfg.permits = permits;
      await saveConfig(wtDir, cfg);
      return { allowed: false, reason: 'permit expired' };
    }
    return { allowed: true };
  }
  if (permit.mode === 'once') {
    permits.splice(idx, 1);
    cfg.permits = permits;
    await saveConfig(wtDir, cfg);
    return { allowed: true };
  }
  return { allowed: false, reason: 'unknown mode' };
}
