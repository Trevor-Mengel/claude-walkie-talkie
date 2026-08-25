import { describe, test, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { appendMessage, parseChannel } from '../../src/core/channel.js';
import { createTmpProject } from '../helpers/tmp-project.js';

function post(channelPath, i) {
  return appendMessage(channelPath, {
    type: 'broadcast',
    fromSessionId: `cs_writer${i}`,
    fromAlias: `writer-${i}`,
    fromTool: 'claude-code',
    mentions: [],
    timestamp: '2026-05-14T15:32:00.000Z',
    body: `message ${i}`
  });
}

describe('a poisoned id floor is a named failure, not a dead channel', () => {
  // `highestId` scans MARKER_ID_RE across the whole file — deliberately wider than the
  // block parser, so a reader's cursor sitting on a corrupted marker is still cleared.
  // That width is correct and unchanged; what it means is that ONE marker holding the
  // maximum base32 value poisons the floor for every future post. Before the fix the
  // resulting throw was not in the wire vocabulary, so `toWalkie` passed it through and
  // the channel answered `500 internal` for every principal, permanently, with no
  // diagnostic naming the marker. Reachable by hand-edit, by a bad merge, or (before the
  // provenance escape) by an attacker-chosen `id=` smuggled through a git identity.
  test('a max-valued marker id yields a conflict naming the id, not an internal error', async () => {
    const project = createTmpProject({ projectName: 'poisoned' });
    const max = 'Z'.repeat(26);
    const text = readFileSync(project.channelPath, 'utf8').replace(
      '<!-- WALKIE:HEADER_END -->',
      `<!-- WALKIE:HEADER_END -->\n\n## ⚡ someone → all\n<!-- walkie:msg id=${max} type=broadcast from=cs_old -->\n**Time:** 2026-05-14T15:32:00.000Z\n\nold\n\n---\n`
    );
    writeFileSync(project.channelPath, text);

    let thrown;
    try {
      await post(project.channelPath, 1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.code).toBe('conflict');
    expect(thrown.code).not.toBe('internal');
    expect(thrown.message).toContain(max);
    expect(thrown.detail).toEqual({ floorId: max });
  });

  test('an explicit id sidesteps the poisoned floor, so the channel is recoverable', async () => {
    const project = createTmpProject({ projectName: 'poisoned-explicit' });
    const max = 'Z'.repeat(26);
    writeFileSync(
      project.channelPath,
      readFileSync(project.channelPath, 'utf8').replace(
        '<!-- WALKIE:HEADER_END -->',
        `<!-- WALKIE:HEADER_END -->\n\n## ⚡ someone → all\n<!-- walkie:msg id=${max} type=broadcast from=cs_old -->\n**Time:** 2026-05-14T15:32:00.000Z\n\nold\n\n---\n`
      )
    );
    // The floor is only consulted when an id has to be minted, so the failure is scoped to
    // minting rather than to the file — which is what makes the operator's repair (delete
    // the marker) sufficient.
    const id = await appendMessage(project.channelPath, {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      type: 'broadcast',
      fromSessionId: 'cs_writer',
      fromTool: 'claude-code',
      mentions: [],
      timestamp: '2026-05-14T15:32:00.000Z',
      body: 'still writable'
    });
    expect(id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });
});

describe('concurrent channel writes are queued, not shed', () => {
  // The file lock's retry budget is WALL-CLOCK (~1.7s). Measured against the real route
  // stack, 40 concurrent posts produced 21 x 201 and 19 x ELOCKED->500; the cliff sat
  // near 21 and moves DOWN on a slower disk or a busier event loop. The existing
  // cross-process test uses 10 spawned workers, comfortably under that cliff, so it
  // passed and always would have.
  //
  // 40 is above the measured ceiling and models the real failure: one daemon process
  // handling concurrent posts. The in-process queue in front of the file lock means the
  // lock is never self-contended, so every write lands.
  test('40 concurrent in-process appends all land, in order, with distinct ids', async () => {
    const project = createTmpProject({ projectName: 'contention' });
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) => post(project.channelPath, i))
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    // No opaque failures. If a write is ever shed it must say so retryably.
    for (const r of rejected) {
      expect(['busy'], String(r.reason?.message)).toContain(r.reason?.code);
    }
    expect(rejected).toHaveLength(0);

    const text = readFileSync(project.channelPath, 'utf8');
    const { messages } = parseChannel(text);
    expect(messages).toHaveLength(40);
    expect(new Set(messages.map((m) => m.id)).size).toBe(40);
    // Append-at-top: the file must read strictly newest-first, so a torn or interleaved
    // write would show up as an ordering break rather than only as a missing message.
    const ids = messages.map((m) => m.id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(new Set(messages.map((m) => m.body))).toEqual(
      new Set(Array.from({ length: 40 }, (_, i) => `message ${i}`))
    );
  }, 60000);

  test('a lock held by another process surfaces as a retryable busy, never internal', async () => {
    const project = createTmpProject({ projectName: 'locked' });
    // proper-lockfile is what `withChannelLock` uses; holding it directly reproduces
    // exactly what a second daemon or a concurrent CLI invocation does. The in-process
    // queue cannot help here — the contention is genuinely external — so this is the
    // path that must be VISIBLY retryable rather than silently lost.
    const release = await lockfile.lock(project.channelPath, { realpath: false });
    try {
      let thrown;
      try {
        await post(project.channelPath, 0);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.code).toBe('busy');
      expect(thrown.code).not.toBe('internal');
      expect(thrown.code).not.toBe('ELOCKED');
      // Nothing was written, which is why repeating the identical request is correct.
      expect(parseChannel(readFileSync(project.channelPath, 'utf8')).messages).toHaveLength(0);
      // No filesystem path in a message that reaches a client verbatim.
      expect(thrown.message).not.toContain(project.root);
    } finally {
      await release();
    }
  }, 30000);

  test('a failed write does not wedge the queue for the writes behind it', async () => {
    const project = createTmpProject({ projectName: 'wedge' });
    // A body the renderer refuses (invalid type) rejects INSIDE the lock. The queue must
    // run the next operation regardless, or one bad request would stall the channel.
    const bad = appendMessage(project.channelPath, {
      type: 'not-a-type',
      fromSessionId: 'cs_bad',
      mentions: [],
      timestamp: '2026-05-14T15:32:00.000Z',
      body: 'x'
    });
    const good = post(project.channelPath, 7);
    await expect(bad).rejects.toThrow(/invalid message type/);
    await expect(good).resolves.toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(parseChannel(readFileSync(project.channelPath, 'utf8')).messages).toHaveLength(1);
  });
});
