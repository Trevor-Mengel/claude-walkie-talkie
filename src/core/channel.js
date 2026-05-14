import { writeFile, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { parseMessage, formatMessage } from './format.js';
import { newId } from './ids.js';

const HEADER_END = '<!-- WALKIE:HEADER_END -->';

/**
 * @param {string} text
 * @returns {{header:string, headerEndIdx:number, body:string, messages:object[]}}
 */
export function parseChannel(text) {
  const idx = text.indexOf(HEADER_END);
  if (idx === -1) throw new Error('Channel file missing WALKIE:HEADER_END marker');
  const headerEndIdx = idx + HEADER_END.length;
  const header = text.slice(0, headerEndIdx);
  const body = text.slice(headerEndIdx);
  const messages = [];
  let cursor = 0;
  while (cursor < body.length) {
    const nextHeading = body.indexOf('\n## ', cursor);
    if (nextHeading === -1) break;
    const afterHeading = nextHeading + 1;
    const followingHeading = body.indexOf('\n## ', afterHeading);
    const blockEnd = followingHeading === -1 ? body.length : followingHeading;
    const block = body.slice(afterHeading, blockEnd);
    const parsed = parseMessage(block);
    if (parsed) messages.push(parsed);
    cursor = blockEnd;
  }
  return { header, headerEndIdx, body, messages };
}

/** @param {string} path */
export async function readChannel(path) {
  const text = await readFile(path, 'utf8');
  return parseChannel(text);
}

// ─── Append-at-top ────────────────────────────────────────────────────────────

/** Module-level map tracking recent internal writes (used by watcher to skip own edits). */
const INTERNAL_WRITE_FLAG = new Map();

/**
 * Returns true if this process wrote to `path` within the last ~200ms.
 * Used by the watcher to distinguish own writes from external edits.
 * @param {string} path
 */
export function isInternalWrite(path) {
  const t = INTERNAL_WRITE_FLAG.get(path);
  return t !== undefined && Date.now() - t < 200;
}

async function withChannelLock(path, fn) {
  const release = await lockfile.lock(path, {
    retries: { retries: 20, minTimeout: 25, maxTimeout: 100, factor: 1.5 },
    stale: 5000,
    realpath: false
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Atomically inserts a new message block immediately after the WALKIE:HEADER_END marker,
 * so the most recent message appears at the top of the message list.
 *
 * @param {string} path - Absolute path to channel.md
 * @param {object} msgInput - Message object (id will be generated if missing)
 * @returns {Promise<string>} The message id
 */
export async function appendMessage(path, msgInput) {
  const msg = { ...msgInput };
  if (!msg.id) msg.id = newId();
  const block = formatMessage(msg);

  await withChannelLock(path, async () => {
    const text = await readFile(path, 'utf8');
    const idx = text.indexOf(HEADER_END);
    if (idx === -1) throw new Error('Channel file missing WALKIE:HEADER_END marker');
    const headerEnd = idx + HEADER_END.length;
    const head = text.slice(0, headerEnd);
    // Strip any leading newlines from the tail.
    const tail = text.slice(headerEnd).replace(/^\n+/, '');
    // If the tail starts with '---', that separator is the empty-channel placeholder.
    // block already ends with '---\n\n', so we strip the redundant leading separator from tail.
    const strippedTail = tail.startsWith('---') ? tail.replace(/^---\n*/, '') : tail;

    const next = `${head}\n\n${block}${strippedTail}`;
    const tmpPath = `${path}.tmp.${msg.id}`;
    await writeFile(tmpPath, next, 'utf8');
    INTERNAL_WRITE_FLAG.set(path, Date.now());
    await rename(tmpPath, path);
  });

  return msg.id;
}

/**
 * Returns canonical paths for a walkie-talkie project.
 * @param {string} projectRoot
 */
export function paths(projectRoot) {
  const wt = join(projectRoot, '.walkie-talkie');
  return {
    wtDir: wt,
    channel: join(wt, 'channel.md'),
    config: join(wt, 'config.json'),
    lockfileDir: wt,
    sessionsDir: join(wt, '.sessions'),
    logsDir: join(wt, 'logs'),
    pidFile: join(wt, 'server.pid'),
    portFile: join(wt, 'server.port')
  };
}
