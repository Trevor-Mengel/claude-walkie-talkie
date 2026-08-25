import { describe, test, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import request from 'supertest';
import { readChannel } from '../../../src/core/channel.js';
import { createFixture, mintActor, cursorRows, cleanupFixtures } from './helpers.js';

afterEach(cleanupFixtures);

async function post(app, actor, body, extra = {}) {
  const res = await request(app)
    .post('/channel/message')
    .set('Authorization', actor.bearer)
    .send({ body, ...extra });
  expect(res.status).toBe(201);
  return res.body.id;
}

function inbox(app, actor, query = '') {
  return request(app).get(`/inbox${query}`).set('Authorization', actor.bearer);
}

function ack(app, actor, id, includeMemoryUpdates) {
  const payload = { id };
  if (includeMemoryUpdates !== undefined) {
    payload.include_memory_updates = includeMemoryUpdates;
  }
  return request(app).post('/cursor/ack').set('Authorization', actor.bearer).send(payload);
}

function bodies(res) {
  return res.body.messages.map((m) => (m.body === null ? '<corrupt>' : m.body.trim()));
}

function rewriteChannel(path, fn) {
  writeFileSync(path, fn(readFileSync(path, 'utf8')), 'utf8');
}

/**
 * Duplicates the `id=` token on one message's marker, which is what a hand-edit or a
 * botched copy-paste in `channel.md` produces. `parseMarker` treats a repeated key as
 * corruption and returns null, so the whole block drops out of `readChannel` — the
 * message is neither delivered nor counted.
 */
function corruptMarker(path, id) {
  rewriteChannel(path, (text) =>
    text.replace(new RegExp(`(<!-- walkie:msg [^\\n]*\\bid=${id}\\b)`), `$1 id=${id}`)
  );
}

/** Removes one message's closing body fence: identity still parses, the body does not. */
function corruptBody(path, id) {
  rewriteChannel(path, (text) =>
    text
      .split('\n')
      .filter((line) => !line.includes(`walkie:body-end id=${id}`))
      .join('\n')
  );
}

async function parsedIds(path) {
  const { messages } = await readChannel(path);
  return messages.map((m) => m.id);
}

// The cursor used to be the 1-based ordinal of a message among those that PARSED, recomputed
// on every read. So losing one message renumbered every message after it and moved every
// stored cursor forward over messages that had never been delivered — silently, permanently,
// with no error and no audit row. Ordinals are gone; a cursor is a message id.
describe('a cursor survives losing an unrelated message', () => {
  test('an unread message stays deliverable when an OLDER message drops out of the parse', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    await post(fx.app, writer, 'first');
    const second = await post(fx.app, writer, 'second');
    await post(fx.app, writer, 'third');
    await post(fx.app, writer, 'fourth');

    // The reader processed through the second message and said so.
    expect((await ack(fx.app, reader, second)).status).toBe(200);
    const before = await inbox(fx.app, reader);
    expect(bodies(before)).toEqual(['third', 'fourth']);

    // Now the acked message itself is corrupted. Under ordinals this renumbered
    // `third` down onto the acked ordinal 2 and it was never shown to anyone again.
    corruptMarker(fx.channelPath, second);
    expect(await parsedIds(fx.channelPath)).not.toContain(second);

    const after = await inbox(fx.app, reader);
    expect(bodies(after)).toEqual(['third', 'fourth']);
    expect(after.body.lastAckedId).toBe(second);
  });

  test('corrupting an unrelated message between two reads does not change the view', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    const first = await post(fx.app, writer, 'first');
    const second = await post(fx.app, writer, 'second');
    await post(fx.app, writer, 'third');
    await post(fx.app, writer, 'fourth');

    await ack(fx.app, reader, second);
    const before = await inbox(fx.app, reader);

    // `first` is below the cursor and irrelevant to this reader — and yet under
    // ordinals its disappearance shifted everything above it.
    corruptMarker(fx.channelPath, first);
    expect(await parsedIds(fx.channelPath)).not.toContain(first);

    const after = await inbox(fx.app, reader);
    expect(after.body.messages.map((m) => m.id)).toEqual(before.body.messages.map((m) => m.id));
    expect(bodies(after)).toEqual(['third', 'fourth']);
  });

  test('a message whose body is corrupt keeps its place in the queue', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    const first = await post(fx.app, writer, 'first');
    const second = await post(fx.app, writer, 'second');
    const third = await post(fx.app, writer, 'third');

    // An open body fence with no close: identity survives, the body is refused.
    corruptBody(fx.channelPath, second);
    expect(await parsedIds(fx.channelPath)).toEqual([third, second, first]);

    const all = await inbox(fx.app, reader);
    expect(all.body.messages.map((m) => m.id)).toEqual([first, second, third]);
    const corrupt = all.body.messages[1];
    expect(corrupt.body).toBe(null);
    expect(corrupt.bodyError).toBe('unterminated-body-fence');

    // It occupies its slot on both sides: acking the message BEFORE it still delivers
    // it, and acking it delivers only what follows it.
    await ack(fx.app, reader, first);
    expect((await inbox(fx.app, reader)).body.messages.map((m) => m.id)).toEqual([second, third]);
    await ack(fx.app, reader, second);
    expect((await inbox(fx.app, reader)).body.messages.map((m) => m.id)).toEqual([third]);
  });

  test('a cursor is a message id, and an ordinal is refused', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    await post(fx.app, writer, 'only');

    for (const value of [1, 0, '2', 'not-an-id', '01j0000000000000000000000a', null]) {
      const res = await ack(fx.app, reader, value);
      expect(res.status, `ack ${String(value)}`).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    }
    expect(cursorRows(fx.store, reader.principal.id)).toEqual([]);
  });
});

describe('GET /inbox is strictly non-mutating', () => {
  test('two consecutive calls return the identical message set', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    await post(fx.app, writer, 'first');
    await post(fx.app, writer, 'second');

    const one = await inbox(fx.app, reader);
    const two = await inbox(fx.app, reader);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(one.body.messages.map((m) => m.id)).toEqual(two.body.messages.map((m) => m.id));
    expect(one.body.messages.length).toBe(2);
    expect(one.body.lastReadId).toBe('');
    expect(one.body.lastAckedId).toBe('');
    expect(two.body.lastAckedId).toBe('');
  });

  test('no cursor row exists before or after reading', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    await post(fx.app, writer, 'payload');

    expect(cursorRows(fx.store, reader.principal.id)).toEqual([]);
    await inbox(fx.app, reader);
    await inbox(fx.app, reader);
    // The exact property v0.2 violated: reading created and advanced a cursor.
    expect(cursorRows(fx.store, reader.principal.id)).toEqual([]);
  });

  test('an existing cursor is not touched by a read', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    const one = await post(fx.app, writer, 'one');
    const two = await post(fx.app, writer, 'two');

    expect((await ack(fx.app, reader, one)).status).toBe(200);
    const before = cursorRows(fx.store, reader.principal.id);
    expect(before).toEqual([
      { kind: 'ack', last_message_id: one, updated_at: before[0].updated_at }
    ]);

    const res = await inbox(fx.app, reader);
    expect(res.body.messages.map((m) => m.id)).toEqual([two]);
    expect(res.body.lastAckedId).toBe(one);
    expect(cursorRows(fx.store, reader.principal.id)).toEqual(before);
  });
});

describe('GET /inbox contents', () => {
  test('returns messages after the ack cursor, oldest first', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    const a = await post(fx.app, writer, 'a');
    const b = await post(fx.app, writer, 'b');
    const c = await post(fx.app, writer, 'c');

    const all = await inbox(fx.app, reader);
    expect(all.body.messages.map((m) => m.id)).toEqual([a, b, c]);
    // No message carries an ordinal: `id` IS the acknowledgement token.
    expect(all.body.messages.every((m) => m.seq === undefined)).toBe(true);

    await ack(fx.app, reader, b);
    const rest = await inbox(fx.app, reader);
    expect(rest.body.messages.map((m) => m.id)).toEqual([c]);
  });

  // This test USED to post exactly two messages with no ack between them, which meant
  // `cursors.ack === ''` and the cutoff filtered nothing — so it passed byte-identically
  // whether the category filter ran before or after the cutoff, and the S1 defect walked
  // straight past it. The acked case is the whole point, and it lives here rather than in
  // a sibling test so the blind spot cannot survive the repair.
  test('memory updates are excluded by default and stay reachable after a later ack', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    const one = await post(fx.app, writer, 'normal');
    const noted = await post(fx.app, writer, 'noted', { type: 'memory-update' });
    const three = await post(fx.app, writer, 'three');
    // Ids are monotonic, so `noted` sits BETWEEN the two broadcasts — the arrangement that
    // makes a single scalar mark over two differently-filtered sets unsound.
    expect(one < noted && noted < three).toBe(true);

    const without = await inbox(fx.app, reader);
    expect(without.body.messages.map((m) => m.type)).toEqual(['broadcast', 'broadcast']);
    expect(without.body.messages.map((m) => m.id)).toEqual([one, three]);
    const with_ = await inbox(fx.app, reader, '?include_memory_updates=true');
    expect(with_.body.messages.map((m) => m.type)).toEqual([
      'broadcast',
      'memory-update',
      'broadcast'
    ]);

    // The reader acks `three`: exactly what it was shown and exactly what `walkie_ack`
    // instructs ("the id of the last message it actually processed"). No attacker, no
    // race, no corruption — the ordinary path.
    await ack(fx.app, reader, three);
    expect((await inbox(fx.app, reader)).body.messages).toEqual([]);

    // `noted` was never delivered, so it must still be there. Under the old ordering it
    // was below the single mark and unreachable forever: non-delivery silently recorded
    // as acknowledgement.
    const still = await inbox(fx.app, reader, '?include_memory_updates=true');
    expect(still.body.messages.map((m) => m.id)).toContain(noted);
    // The inclusive view's own mark never moved, so it re-offers the two broadcasts too.
    // That is at-least-once delivery, which every consumer dedupes by id — the acceptable
    // direction. Skipping is the unacceptable one.
    expect(still.body.messages.map((m) => m.id)).toEqual([one, noted, three]);
  });

  test('each view carries its own mark, and neither ack drags the other forward', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    const one = await post(fx.app, writer, 'normal');
    const noted = await post(fx.app, writer, 'noted', { type: 'memory-update' });
    const three = await post(fx.app, writer, 'three');

    // Default-view ack: the default mark moves, the inclusive one does not.
    const acked = await ack(fx.app, reader, three);
    expect(acked.body).toEqual({ id: three, cursors: { default: three, withMemoryUpdates: '' } });
    const afterDefault = await inbox(fx.app, reader);
    expect(afterDefault.body.cursors).toEqual({
      default: { lastReadId: '', lastAckedId: three },
      withMemoryUpdates: { lastReadId: '', lastAckedId: '' }
    });
    // And the reported marks are the ones governing whichever view answered.
    expect(afterDefault.body.lastAckedId).toBe(three);
    const inclusive = await inbox(fx.app, reader, '?include_memory_updates=true');
    expect(inclusive.body.lastAckedId).toBe('');

    // Inclusive-view ack: BOTH move, because that view is a superset — the reader
    // genuinely saw every non-archived message at or below that id.
    const both = await ack(fx.app, reader, three, true);
    expect(both.body).toEqual({
      id: three,
      cursors: { default: three, withMemoryUpdates: three }
    });
    expect((await inbox(fx.app, reader, '?include_memory_updates=true')).body.messages).toEqual([]);
    expect((await inbox(fx.app, reader)).body.messages).toEqual([]);

    // The other direction, on a fresh reader: an inclusive ack of the MIDDLE message
    // carries the default mark with it, so the default view resumes after it rather than
    // re-offering `one`.
    const other = mintActor(fx.store, { alias: 'other' });
    const carried = await ack(fx.app, other, noted, true);
    expect(carried.body.cursors).toEqual({ default: noted, withMemoryUpdates: noted });
    expect((await inbox(fx.app, other)).body.messages.map((m) => m.id)).toEqual([three]);
  });

  test('archived messages never appear', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    const id = await post(fx.app, writer, 'retracted');
    await request(fx.app)
      .post(`/channel/message/${id}/archive`)
      .set('Authorization', writer.bearer)
      .send({});
    const res = await inbox(fx.app, reader);
    expect(res.body.messages).toEqual([]);
  });

  test('reading the inbox requires channel:read', async () => {
    const fx = createFixture();
    const publisher = mintActor(fx.store, { scopes: ['channel:publish'] });
    const res = await inbox(fx.app, publisher);
    expect(res.status).toBe(403);
    expect(res.body.error.detail.scope).toBe('channel:read');
  });

  test('a bogus boolean query value is rejected', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store);
    const res = await inbox(fx.app, reader, '?include_memory_updates=yes');
    expect(res.status).toBe(400);
  });
});

describe('mentionedForMe matches on principal id, never on alias', () => {
  test('an alias thief does not steal directed traffic', async () => {
    const fx = createFixture();
    const alice = mintActor(fx.store, { alias: 'alice' });
    const bob = mintActor(fx.store, { alias: 'bob' });
    const writer = mintActor(fx.store, { alias: 'writer' });

    // Traffic directed at alice, by her alias at the time of writing.
    await post(fx.app, writer, 'alice please look @alice');

    // Alice renames, freeing the alias; Bob then claims it — the exact v0.2
    // alias-theft sequence.
    const rename = await request(fx.app)
      .post('/self/alias')
      .set('Authorization', alice.bearer)
      .send({ alias: 'alice-old' });
    expect(rename.status).toBe(200);
    const steal = await request(fx.app)
      .post('/self/alias')
      .set('Authorization', bob.bearer)
      .send({ alias: 'alice' });
    expect(steal.status).toBe(200);

    const aliceInbox = await request(fx.app).get('/inbox').set('Authorization', alice.bearer);
    const bobInbox = await request(fx.app).get('/inbox').set('Authorization', bob.bearer);
    expect(aliceInbox.body.mentionedForMe.length).toBe(1);
    expect(bobInbox.body.mentionedForMe).toEqual([]);
  });

  test('@all addresses everyone', async () => {
    const fx = createFixture();
    const reader = mintActor(fx.store, { alias: 'reader' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    await post(fx.app, writer, 'listen up @all');
    const res = await request(fx.app).get('/inbox').set('Authorization', reader.bearer);
    expect(res.body.mentionedForMe.length).toBe(1);
  });

  test('@operator addresses the operator role and nobody else', async () => {
    const fx = createFixture();
    const op = mintActor(fx.store, { alias: 'human', role: 'operator' });
    const agent = mintActor(fx.store, { alias: 'agent' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    await post(fx.app, writer, 'need a decision @operator');

    const opInbox = await request(fx.app).get('/inbox').set('Authorization', op.bearer);
    const agentInbox = await request(fx.app).get('/inbox').set('Authorization', agent.bearer);
    expect(opInbox.body.mentionedForMe.length).toBe(1);
    expect(agentInbox.body.mentionedForMe).toEqual([]);
  });

  test('mentionedForMe is a subset of messages', async () => {
    const fx = createFixture();
    const target = mintActor(fx.store, { alias: 'target' });
    const writer = mintActor(fx.store, { alias: 'writer' });
    await post(fx.app, writer, 'unrelated chatter');
    await post(fx.app, writer, 'for you @target');

    const res = await request(fx.app).get('/inbox').set('Authorization', target.bearer);
    expect(res.body.messages.length).toBe(2);
    expect(res.body.mentionedForMe.length).toBe(1);
    const ids = new Set(res.body.messages.map((m) => m.id));
    for (const m of res.body.mentionedForMe) expect(ids.has(m.id)).toBe(true);
  });
});
