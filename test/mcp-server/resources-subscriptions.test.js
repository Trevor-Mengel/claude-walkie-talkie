// Subscriptions must be bounded, and a dead one must be visible.
//
// Wave F findings, both in `buildResources`:
//
//   1. `subscribe` did `subscriptions.add(request.params.uri)` and validated nothing. Any string
//      a client sent was retained forever in an unbounded Set, and the client was told it had
//      subscribed to a resource that does not exist — so it waited indefinitely for
//      notifications that could never arrive about a URI the server does not serve.
//
//   2. When the event feed faulted, the handler nulled the stream and wrote ONE LINE TO STDERR.
//      stderr is the server process's log, not something the MCP client reads. The stream was
//      never re-established and nothing was sent to the client, so the subscription became
//      permanently inert while the client still believed it was live: no notifications, no
//      error, no way to tell the difference from a quiet channel.
//
// The property under test for (2) is observability from the CLIENT's side. Every assertion below
// looks only at what was pushed through `server.notification`, because that is the only surface
// a client can see.

import { describe, test, expect } from 'vitest';
import { buildResources } from '../../src/mcp-server/resources.js';
import { createCapabilityHolder } from '../../src/mcp-server/capability.js';
import { collabcastError } from '../../src/identity/errors.js';

const TOKEN = 'SbS8xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE';
const SELF = {
  principalId: 'prn_01',
  role: 'goal_hub',
  displayAlias: 'builder',
  scopes: ['channel:read'],
  capabilityId: 'cap_01',
  expiresAt: null
};

const INBOX = 'collabcast://channel/inbox';

function stubApi() {
  return {
    self: async () => SELF,
    inbox: async () => ({ messages: [], mentionedForMe: [], lastReadId: '', lastAckedId: '' }),
    latest: async () => ({ messages: [] }),
    principals: async () => ({ principals: [] })
  };
}

/**
 * @param {{openFails?:number[]}} [opts] indices of `events()` calls that should reject, so a
 *   test can make the reconnect attempt fail while the first open succeeded.
 */
async function harness({ openFails = [] } = {}) {
  const api = stubApi();
  const capability = createCapabilityHolder({
    api,
    tokenBox: { value: null },
    namespace: 'collabcast-test',
    env: {},
    warn: () => {}
  });
  await capability.adopt(TOKEN);

  const notifications = [];
  const closes = [];
  const handlers = [];
  let opens = 0;

  const resources = buildResources({
    server: { notification: (n) => notifications.push(n) },
    api,
    capability,
    events: async (onEvent, onError) => {
      const index = opens;
      opens += 1;
      if (openFails.includes(index)) {
        throw collabcastError('unavailable', 'the collabcast event feed refused the connection');
      }
      handlers.push({ onEvent, onError });
      return { close: () => closes.push(index) };
    }
  });

  return {
    resources,
    notifications,
    closes,
    handlers,
    opens: () => opens,
    /** The most recently installed feed handlers. */
    latest: () => handlers[handlers.length - 1],
    updates: () =>
      notifications
        .filter((n) => n.method === 'notifications/resources/updated')
        .map((n) => n.params.uri),
    logs: () => notifications.filter((n) => n.method === 'notifications/message')
  };
}

describe('subscribe validates the URI', () => {
  test('a URI that names no resource is refused rather than accumulated', async () => {
    const h = await harness();

    for (const uri of [
      'collabcast://channel/nope',
      'collabcast://channel/inbox/extra',
      'file:///etc/passwd',
      'https://example.com/',
      '',
      'x'.repeat(4096)
    ]) {
      await expect(h.resources.subscribe({ params: { uri } })).rejects.toMatchObject({
        code: 'not_found'
      });
      // Nothing was retained, so a client cannot grow this set with junk.
      expect(h.resources.subscribed()).toEqual([]);
    }
    // And no feed was opened on behalf of a resource that does not exist.
    expect(h.opens()).toBe(0);
    expect(h.resources.streamState()).toBe('idle');
  });

  test('the set is bounded by the resource table, however many times a client subscribes', async () => {
    const h = await harness();
    const real = h.resources.list().map((r) => r.uri);

    for (let round = 0; round < 5; round += 1) {
      for (const uri of real) await h.resources.subscribe({ params: { uri } });
      await h.resources.subscribe({ params: { uri: 'collabcast://channel/nope' } }).catch(() => {});
    }

    expect(h.resources.subscribed().sort()).toEqual([...real].sort());
    expect(h.resources.subscribed().length).toBe(real.length);
  });

  test('a subscribe that cannot arm the feed leaves nothing registered', async () => {
    const h = await harness({ openFails: [0] });

    await expect(h.resources.subscribe({ params: { uri: INBOX } })).rejects.toMatchObject({
      code: 'unavailable'
    });
    // The old ordering added the URI first, so a rejected subscribe still looked subscribed.
    expect(h.resources.subscribed()).toEqual([]);
  });

  test('concurrent subscribes open exactly one feed', async () => {
    const h = await harness();
    const real = h.resources.list().map((r) => r.uri);

    await Promise.all(real.map((uri) => h.resources.subscribe({ params: { uri } })));

    // Two racing subscribes on a null stream each used to call `events()`, and the first
    // handle was overwritten — an orphan request holding the socket with nobody to close it.
    expect(h.opens()).toBe(1);
    expect(h.resources.streamState()).toBe('live');
  });
});

describe('a faulted subscription is visible to the client', () => {
  test('the fault is reported to the client, not only to stderr', async () => {
    const h = await harness();
    await h.resources.subscribe({ params: { uri: INBOX } });
    const feed = h.latest();

    feed.onError(collabcastError('unavailable', 'the collabcast event feed closed'));

    const first = h.logs()[0];
    expect(first, 'the client must be told the feed died').toBeDefined();
    expect(first.params.level).toBe('warning');
    expect(first.params.logger).toBe('collabcast.subscriptions');
    expect(first.params.data.live).toBe(false);
    expect(first.params.data.code).toBe('unavailable');
    // The message names the affected subscription so a client knows what went quiet.
    expect(first.params.data.subscriptions).toEqual([INBOX]);
  });

  test('the feed is re-established and the missed window is signalled', async () => {
    const h = await harness();
    await h.resources.subscribe({ params: { uri: INBOX } });
    h.latest().onError(collabcastError('unavailable', 'closed'));

    // The reconnect is a floating promise inside the error handler; let it settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.opens()).toBe(2);
    expect(h.resources.streamState()).toBe('live');
    // Recovery is announced...
    expect(h.logs().map((n) => n.params.level)).toEqual(['warning', 'info']);
    // ...and the subscriber is woken once, because anything posted while the feed was down was
    // never notified and a passive client would otherwise never learn it missed messages.
    expect(h.updates()).toEqual([INBOX]);

    // The replacement feed is live: a post on it notifies as normal.
    h.latest().onEvent('message.posted', { id: '01H', from: 'prn_other' });
    expect(h.updates()).toEqual([INBOX, INBOX]);
  });

  test('a reconnect that also fails is reported as terminal, never as silence', async () => {
    const h = await harness({ openFails: [1] });
    await h.resources.subscribe({ params: { uri: INBOX } });
    h.latest().onError(collabcastError('unavailable', 'closed'));

    await new Promise((resolve) => setImmediate(resolve));

    expect(h.resources.streamState()).toBe('faulted');
    const levels = h.logs().map((n) => n.params.level);
    expect(levels).toEqual(['warning', 'error']);
    const terminal = h.logs()[1];
    expect(terminal.params.data.live).toBe(false);
    expect(terminal.params.data.message ?? terminal.params.data).toBeDefined();
    // No false "everything is fine" resource update was sent.
    expect(h.updates()).toEqual([]);
  });

  test('a re-subscribe after a terminal fault re-arms the feed', async () => {
    const h = await harness({ openFails: [1] });
    await h.resources.subscribe({ params: { uri: INBOX } });
    h.latest().onError(collabcastError('unavailable', 'closed'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.resources.streamState()).toBe('faulted');

    await h.resources.subscribe({ params: { uri: INBOX } });
    expect(h.resources.streamState()).toBe('live');
    h.latest().onEvent('message.posted', { id: '01I', from: 'prn_other' });
    expect(h.updates()).toEqual([INBOX]);
  });

  test('a fault with no subscribers says nothing to the client', async () => {
    const h = await harness();
    await h.resources.subscribe({ params: { uri: INBOX } });
    const feed = h.latest();
    await h.resources.unsubscribe({ params: { uri: INBOX } });

    feed.onError(collabcastError('unavailable', 'closed'));
    await new Promise((resolve) => setImmediate(resolve));

    // Nobody is listening, so there is nothing to warn about and nothing to reconnect for.
    expect(h.logs()).toEqual([]);
    expect(h.opens()).toBe(1);
  });
});

describe('read still refuses an unknown resource', () => {
  test('the same not_found, from the one validator both paths share', async () => {
    const h = await harness();
    await expect(
      h.resources.read({ params: { uri: 'collabcast://channel/nope' } })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
