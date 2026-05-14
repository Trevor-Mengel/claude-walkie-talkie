import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { now } from '../core/time.js';

const FILE = 'invitations.json';

function pathFor(wtDir) {
  return join(wtDir, '.sessions', FILE);
}

async function ensureFile(wtDir) {
  const path = pathFor(wtDir);
  if (existsSync(path)) return path;
  await mkdir(join(wtDir, '.sessions'), { recursive: true });
  await writeFile(path, '[]');
  return path;
}

export async function loadInvitations(wtDir) {
  const path = await ensureFile(wtDir);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function save(wtDir, data) {
  const path = await ensureFile(wtDir);
  await writeFile(path, JSON.stringify(data, null, 2));
}

export async function addInvitation(wtDir, { alias, invitedBy, fromMessage }) {
  const data = await loadInvitations(wtDir);
  if (data.some((i) => i.alias === alias)) return;
  data.push({ alias, invitedBy, fromMessage, invitedAt: now() });
  await save(wtDir, data);
}

export async function findInvitation(wtDir, alias) {
  const data = await loadInvitations(wtDir);
  return data.find((i) => i.alias === alias) ?? null;
}

export async function fulfillInvitation(wtDir, alias, fulfillingSessionId) {
  const data = await loadInvitations(wtDir);
  const idx = data.findIndex((i) => i.alias === alias);
  if (idx === -1) return null;
  const [inv] = data.splice(idx, 1);
  await save(wtDir, data);
  return { ...inv, fulfilledBy: fulfillingSessionId, fulfilledAt: now() };
}

export async function expireOlderThan(wtDir, thresholdMs) {
  const data = await loadInvitations(wtDir);
  const cutoff = Date.now() - thresholdMs;
  const kept = data.filter((i) => new Date(i.invitedAt).getTime() >= cutoff);
  if (kept.length !== data.length) await save(wtDir, kept);
}
