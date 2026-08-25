import { writeFile, rename, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  MARKER_LINE_RE,
  MARKER_LOOKAHEAD_LINES,
  parseMessage,
  formatMessage
} from './format.js';
import { newIdAfter } from './ids.js';
import { appendRevision } from './history.js';
import { now } from './time.js';

const HEADER_END = '<!-- WALKIE:HEADER_END -->';
const NULL_GIT = { branch: null, hash: null, userName: null, userEmail: null };

/**
 * An `id=<ULID>` token on a marker line. Only the shape an id can actually have is
 * accepted, so a hand-typed value cannot poison the floor `highestId` derives.
 */
const MARKER_ID_RE = /<!--\s*walkie:msg\b[^\n]*?\bid=([0-9A-HJKMNP-TV-Z]{26})\b/g;

/**
 * A block boundary is a `## ` heading followed (within `MARKER_LOOKAHEAD_LINES`) by a
 * message marker on a line of its own. Both come from format.js: the boundary scan and
 * `parseMessage` MUST agree on what a block is, and two copies of the rule would drift
 * into "one block here, two blocks there".
 */

/**
 * Byte offsets (into `text`) of the `\n` that begins each message block.
 *
 * Only a `## ` heading followed by a `walkie:msg` marker starts a block, so a
 * heading that appears inside a body cannot split a message in two (a body can
 * never contain a walkie control comment — `isValidMessageBody` rejects them).
 * The small lookahead tolerates hand-edited blank lines between the heading and
 * its marker.
 * @param {string} text
 * @returns {number[]}
 */
function blockStarts(text) {
  const starts = [];
  let cursor = 0;
  for (;;) {
    const idx = text.indexOf('\n## ', cursor);
    if (idx === -1) break;
    cursor = idx + 1;
    let lineStart = text.indexOf('\n', idx + 1);
    for (let n = 0; n < MARKER_LOOKAHEAD_LINES && lineStart !== -1; n += 1) {
      const lineEnd = text.indexOf('\n', lineStart + 1);
      const line = text.slice(lineStart + 1, lineEnd === -1 ? text.length : lineEnd).trim();
      if (MARKER_LINE_RE.test(line)) {
        starts.push(idx);
        break;
      }
      // A second heading, or content that is neither blank nor a marker, means
      // this heading owns no marker.
      if (line !== '') break;
      lineStart = lineEnd;
    }
  }
  return starts;
}

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
  const starts = blockStarts(body);
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i] + 1;
    const to = i + 1 < starts.length ? starts[i + 1] : body.length;
    const parsed = parseMessage(body.slice(from, to));
    if (parsed) messages.push(parsed);
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

/**
 * In-process write queue, in front of the cross-process file lock.
 *
 * Every channel mutation serialises on one `proper-lockfile` lock whose retry budget is
 * WALL-CLOCK (20 retries, 25ms→100ms, factor 1.5 — roughly 1.7s total). Measured against
 * the real route stack, 40 concurrent `POST /channel/message` produced 21 × 201 and
 * 19 × ELOCKED; the cliff sat around 21 and, being wall-clock, it moves DOWN on a slower
 * disk or a busier event loop. Concurrent multi-agent posting is this product's premise,
 * so shedding half of it is delivery loss, not a capacity note.
 *
 * The single-writer discipline itself is sound — the writes that landed were well-formed,
 * distinct and in exact file order — so what is replaced is the QUEUE in front of it, not
 * the lock. The daemon is already the only writer in its process, so chaining same-path
 * mutations onto one promise costs nothing and removes in-process contention entirely: the
 * file lock is then only ever contested by a genuinely separate process (a CLI invocation,
 * a second daemon), which is the case it was designed for.
 *
 * The chain runs the next operation whether the previous one resolved or rejected — one
 * failed write must never wedge the channel — and the map entry is dropped once no newer
 * operation is waiting, so the map cannot grow with the set of paths touched.
 */
const WRITE_QUEUE = new Map();

function enqueue(path, fn) {
  const prev = WRITE_QUEUE.get(path);
  const run = prev ? prev.then(fn, fn) : fn();
  const tail = run.then(
    () => {},
    () => {}
  );
  WRITE_QUEUE.set(path, tail);
  tail.then(() => {
    if (WRITE_QUEUE.get(path) === tail) WRITE_QUEUE.delete(path);
  });
  return run;
}

/**
 * A shed write, named.
 *
 * `proper-lockfile` throws `{ code: 'ELOCKED' }`, which is not in the wire vocabulary, so
 * `toWalkie` passed it through and the transport rendered `500 internal` — telling an
 * agent it had hit a bug when in fact retrying was exactly right, and the message simply
 * left the conversation. Nothing was written, so `busy` is the honest answer: repeat the
 * identical request shortly.
 *
 * No path in the message: this one reaches a client verbatim.
 */
function channelBusy() {
  const err = new Error(
    'another process is writing the channel; nothing was changed, so retry this request shortly'
  );
  err.code = 'busy';
  return err;
}

async function withChannelLock(path, fn) {
  return enqueue(path, () => lockChannelFile(path, fn));
}

/**
 * The cross-process lock. `stale: 5000` means a lock held past 5s may be STOLEN, and
 * proper-lockfile defends that by refreshing the lockfile mtime every `stale/2` — from a
 * timer, on an event loop this process also runs synchronous `better-sqlite3` calls on. A
 * hold that outlived a missed refresh would permit a genuine lost update, since every
 * write path is a full-file rewrite and the last one wins.
 *
 * The queue does not widen that margin, and two things bound it:
 *  - Per-hold duration is UNCHANGED. Queue waiting happens before `lockfile.lock`, so it
 *    is time spent outside the lock and cannot be stolen from.
 *  - Nothing inside these three lock bodies touches the store: `appendMessage`,
 *    `editMessage` and `archiveMessage` do async fs work only (read, render, append
 *    revision, write tmp, rename). The audit and store writes live in the routes, outside.
 * If anything, the margin improves: the retry storm this queue removes was itself up to
 * 20 timers per concurrent request competing with the refresh timer.
 */
async function lockChannelFile(path, fn) {
  let release;
  try {
    release = await lockfile.lock(path, {
      retries: { retries: 20, minTimeout: 25, maxTimeout: 100, factor: 1.5 },
      stale: 5000,
      realpath: false
    });
  } catch (err) {
    if (err && err.code === 'ELOCKED') throw channelBusy();
    throw err;
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Temp-file suffixes never carry caller-supplied path characters. */
function tmpSuffix(value) {
  return String(value).replace(/[^0-9A-Za-z_-]/g, '');
}

/**
 * Locates one message block by id.
 * @param {string} text
 * @param {string} msgId
 * @returns {{start:number, end:number, parsed:object, isLast:boolean}|null}
 */
function findMessageBlock(text, msgId) {
  const starts = blockStarts(text);
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    const parsed = parseMessage(text.slice(start + 1, end));
    if (parsed && parsed.id === msgId) {
      return { start, end, parsed, isLast: end === text.length };
    }
  }
  return null;
}

/**
 * A block whose body `parseMessage` could not recover must never be rewritten: every
 * write path re-renders the block from that parse, so an unterminated body fence
 * would turn a recoverable hand-edit into permanent truncation.
 * @param {object} parsed
 * @param {string} msgId
 */
function assertRenderable(parsed, msgId) {
  if (!parsed.bodyError) return;
  const err = new Error(
    `message ${msgId} cannot be modified: its block in channel.md is corrupt ` +
      `(${parsed.bodyError}) — repair the walkie:body fence by hand first`
  );
  err.code = 'conflict';
  err.detail = { id: msgId, reason: parsed.bodyError };
  throw err;
}

/**
 * Replaces a located block with a freshly rendered one.
 *
 * Index-based splice, never `String.prototype.replace` with a dynamic
 * replacement: a body containing `$&`, `` $` ``, `$'` or `$1` would otherwise be
 * interpreted as a replacement pattern (a `$'` body duplicated the whole tail of
 * the file on the next edit or archive).
 *
 * A trailing block owns the file's final newline; an interior block does not —
 * the following block's leading `\n` is its boundary — so trailing newlines are
 * trimmed for interior blocks to keep the file byte-stable.
 */
function spliceBlock(text, loc, msg) {
  const rendered = `\n${formatMessage(msg)}`;
  const replacement = loc.isLast ? rendered : rendered.replace(/\n+$/, '');
  return text.slice(0, loc.start) + replacement + text.slice(loc.end);
}

async function writeAtomic(path, tmpPath, content) {
  await writeFile(tmpPath, content, 'utf8');
  INTERNAL_WRITE_FLAG.set(path, Date.now());
  await rename(tmpPath, path);
}

/**
 * The highest id written into any marker in `text` — deliberately a WIDER scan than
 * `parseChannel`, which yields only blocks whose marker parses as a whole. A block whose
 * marker was corrupted after it was served (a hand-edit, a duplicated key) keeps its
 * `id=` token, and a reader's cursor may still be sitting on it; a new message has to
 * clear that id too, not just the highest one that still parses. Over-inclusive is the
 * safe direction here: a floor can only ever push a new id further up.
 *
 * @param {string} text
 * @returns {string|null} the highest id present, or null when the channel is empty
 */
function highestId(text) {
  let highest = null;
  for (const m of text.matchAll(MARKER_ID_RE)) {
    if (highest === null || m[1] > highest) highest = m[1];
  }
  return highest;
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

  await withChannelLock(path, async () => {
    const text = await readFile(path, 'utf8');
    const idx = text.indexOf(HEADER_END);
    if (idx === -1) throw new Error('Channel file missing WALKIE:HEADER_END marker');
    // Minted here, inside the lock, rather than before it: the lock already
    // serialises every writer, so flooring the new id on the highest id the file
    // already holds makes ordering structural instead of clock-dependent. A
    // backwards clock step across a restart can no longer mint a message below a
    // reader's cursor, where it would be invisible to everyone forever.
    if (!msg.id) msg.id = newIdAfter(highestId(text));
    const block = formatMessage(msg);
    const headerEnd = idx + HEADER_END.length;
    const head = text.slice(0, headerEnd);
    // Strip any leading newlines from the tail.
    const tail = text.slice(headerEnd).replace(/^\n+/, '');
    // If the tail starts with '---', that separator is the empty-channel placeholder.
    // block already ends with '---\n\n', so we strip the redundant leading separator from tail.
    const strippedTail = tail.startsWith('---') ? tail.replace(/^---\n*/, '') : tail;

    const next = `${head}\n\n${block}${strippedTail}`;
    await writeAtomic(path, `${path}.tmp.${tmpSuffix(msg.id)}`, next);
  });

  return msg.id;
}

/**
 * Edit a message's body in place. Bumps revision, appends prior body to history.
 * @param {string} path channel.md path
 * @param {string} msgId
 * @param {string} newBody
 * @param {string} editedBy session id
 * @returns {Promise<{revision:number}>}
 */
export async function editMessage(path, msgId, newBody, editedBy) {
  return withChannelLock(path, async () => {
    const text = await readFile(path, 'utf8');
    const loc = findMessageBlock(text, msgId);
    if (!loc) throw new Error(`Message ${msgId} not found`);
    const parsed = loc.parsed;
    assertRenderable(parsed, msgId);
    const priorBody = (parsed.body ?? '').trim();
    const currentRevision = parsed.revision ?? 0;
    const nextRevision = currentRevision + 1;
    const editedAt = now();
    const sessionsDir = join(dirname(path), '.sessions');
    await appendRevision(sessionsDir, msgId, {
      revision: nextRevision,
      editedAt,
      editedBy,
      priorBody
    });
    // Rebuild the block using formatMessage with updated fields. parseMessage
    // round-trips identity (session id, alias, tool, timestamp) and git
    // provenance out of the marker; the fallbacks only fire for pre-v0.3 blocks.
    const updated = spliceBlock(text, loc, {
      ...parsed,
      body: newBody,
      revision: nextRevision,
      editedAt,
      fromTool: parsed.fromTool ?? 'operator',
      fromAlias: parsed.fromAlias ?? parsed.fromSessionId,
      timestamp: parsed.timestamp ?? now(),
      git: parsed.git ?? NULL_GIT
    });
    await writeAtomic(path, `${path}.tmp.edit-${tmpSuffix(msgId)}`, updated);
    return { revision: nextRevision };
  });
}

/**
 * Archive a message in place. Marker gets archived=true, archived-by, archived-reason.
 * Block re-rendered with banner via formatMessage. Idempotent: parseMessage
 * recovers the original body out of the archive wrapper, so re-archiving neither
 * nests the wrapper nor grows the file.
 * @param {string} path
 * @param {string} msgId
 * @param {string} archivedBy
 * @param {string|null} reason
 */
export async function archiveMessage(path, msgId, archivedBy, reason) {
  return withChannelLock(path, async () => {
    const text = await readFile(path, 'utf8');
    const loc = findMessageBlock(text, msgId);
    if (!loc) throw new Error(`Message ${msgId} not found`);
    const parsed = loc.parsed;
    assertRenderable(parsed, msgId);
    const updated = spliceBlock(text, loc, {
      ...parsed,
      archived: true,
      archivedBy,
      archivedReason: reason ?? null,
      fromAlias: parsed.fromAlias ?? parsed.fromSessionId,
      fromTool: parsed.fromTool ?? 'operator',
      timestamp: parsed.timestamp ?? now(),
      git: parsed.git ?? NULL_GIT
    });
    await writeAtomic(path, `${path}.tmp.archive-${tmpSuffix(msgId)}`, updated);
  });
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
