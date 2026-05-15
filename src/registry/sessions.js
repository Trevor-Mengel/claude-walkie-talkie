import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../core/ids.js';
import { now } from '../core/time.js';

const FILE = 'active.json';

function pathFor(wtDir) {
  return join(wtDir, '.sessions', FILE);
}

async function ensureFile(wtDir) {
  const path = pathFor(wtDir);
  if (existsSync(path)) return path;
  await mkdir(join(wtDir, '.sessions'), { recursive: true });
  await writeFile(path, JSON.stringify({ active: [], recent: [] }, null, 2));
  return path;
}

export async function loadSessions(wtDir) {
  const path = await ensureFile(wtDir);
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

async function saveSessions(wtDir, data) {
  const path = await ensureFile(wtDir);
  await writeFile(path, JSON.stringify(data, null, 2));
}

function generateAlias(active, tool) {
  let n = 1;
  const aliases = new Set(active.filter((s) => s.tool === tool).map((s) => s.alias));
  while (aliases.has(`${tool}-${n}`)) n += 1;
  return `${tool}-${n}`;
}

function generateSessionId(tool) {
  const prefix = tool === 'claude-code' ? 'cs_' : tool === 'claude-cowork' ? 'cw_' : `${tool}_`;
  return `${prefix}${newId().toLowerCase().slice(-12)}`;
}

function suffixForCollision(existingAliases, alias) {
  let n = 1;
  let candidate;
  do {
    candidate = `${alias}-v${n}`;
    n += 1;
  } while (existingAliases.has(candidate));
  return candidate;
}

export async function joinSession(wtDir, { tool, sessionId, alias }) {
  const data = await loadSessions(wtDir);
  const existing = data.active.find((s) => s.sessionId === sessionId);
  if (existing) {
    existing.lastSeen = now();
    await saveSessions(wtDir, data);
    return existing;
  }
  let finalAlias;
  if (alias) {
    const aliasSet = new Set(data.active.map((s) => s.alias));
    if (aliasSet.has(alias)) {
      // collision — suffix the existing holder, keep new alias for incoming
      const conflict = data.active.find((s) => s.alias === alias);
      conflict.alias = suffixForCollision(aliasSet, alias);
      finalAlias = alias;
    } else {
      finalAlias = alias;
    }
  } else {
    finalAlias = generateAlias(data.active, tool);
  }
  const session = {
    sessionId: sessionId || generateSessionId(tool),
    tool,
    alias: finalAlias,
    joined: now(),
    lastSeen: now()
  };
  data.active.push(session);
  await saveSessions(wtDir, data);
  return session;
}

export async function renameSession(wtDir, sessionId, newAlias) {
  const data = await loadSessions(wtDir);
  const target = data.active.find((s) => s.sessionId === sessionId);
  if (!target) throw new Error(`Session ${sessionId} not found in active`);
  const conflict = data.active.find((s) => s.alias === newAlias && s.sessionId !== sessionId);
  if (conflict) {
    const aliasSet = new Set(data.active.map((s) => s.alias));
    conflict.alias = suffixForCollision(aliasSet, newAlias);
  }
  target.alias = newAlias;
  target.lastSeen = now();
  await saveSessions(wtDir, data);
  return target;
}

export async function markSeen(wtDir, sessionId) {
  const data = await loadSessions(wtDir);
  const target = data.active.find((s) => s.sessionId === sessionId);
  if (target) {
    target.lastSeen = now();
    await saveSessions(wtDir, data);
  }
}

export async function rolloverStale(wtDir, thresholdMs) {
  const data = await loadSessions(wtDir);
  const cutoff = Date.now() - thresholdMs;
  const stillActive = [];
  for (const s of data.active) {
    if (new Date(s.lastSeen).getTime() < cutoff) {
      data.recent.unshift({ ...s, retiredAt: now() });
    } else {
      stillActive.push(s);
    }
  }
  data.active = stillActive;
  data.recent = data.recent.slice(0, 50);
  await saveSessions(wtDir, data);
}

export async function markRead(wtDir, sessionId, upToId) {
  const data = await loadSessions(wtDir);
  const target = data.active.find((s) => s.sessionId === sessionId);
  if (!target) throw new Error(`Session ${sessionId} not found in active`);
  if (!target.lastReadId || upToId > target.lastReadId) {
    target.lastReadId = upToId;
  }
  target.lastSeen = now();
  await saveSessions(wtDir, data);
  return target;
}

export async function getLastReadId(wtDir, sessionId) {
  const data = await loadSessions(wtDir);
  const target = data.active.find((s) => s.sessionId === sessionId);
  return target?.lastReadId ?? null;
}
