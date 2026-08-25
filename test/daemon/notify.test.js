// Desktop notifications. Three things were wrong here, and each one is a test below.
//
//   - the self-post suppression compared `p.from` (a principal id) against the literal
//     string `'operator'`, so it NEVER fired: the operator got a toast for every message
//     they typed themselves.
//   - a `permit.required` subscription survived the cutover with nothing emitting it and a
//     body telling the operator to run `collabcast permit <id> --once`, a deleted command.
//   - `notifier.notify` reports a failed spawn through its CALLBACK, so the synchronous
//     try/catch around it could never see one.
//
// `node-notifier` is mocked, so no test can fire a real notification even with the
// COLLABCAST_NO_NOTIFY kill-switch deliberately lifted.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { notifyCalls, behaviour } = vi.hoisted(() => ({
  notifyCalls: [],
  behaviour: { mode: 'ok' }
}));

vi.mock('node-notifier', () => ({
  default: {
    /**
     * @param {object} options
     * @param {(err: Error|null) => void} [callback]
     */
    notify(options, callback) {
      notifyCalls.push(options);
      if (behaviour.mode === 'throw') throw new Error('spawn failed');
      if (behaviour.mode === 'callback-error') {
        callback?.(new Error('no notifier binary on this box'));
        return;
      }
      callback?.(null);
    }
  }
}));

const { attachNotifier } = await import('../../src/daemon/notify.js');

beforeEach(() => {
  notifyCalls.length = 0;
  behaviour.mode = 'ok';
});

/**
 * Attach with the kill-switch lifted, then put it back exactly as it was: the rest of the
 * suite depends on it, and `isolation.js` refuses to run without it.
 *
 * @param {EventEmitter} events
 * @param {object} [opts]
 */
function attachEnabled(events, opts = {}) {
  const original = process.env.COLLABCAST_NO_NOTIFY;
  try {
    delete process.env.COLLABCAST_NO_NOTIFY;
    attachNotifier({ events, projectName: 'proj', ...opts });
  } finally {
    if (original === undefined) delete process.env.COLLABCAST_NO_NOTIFY;
    else process.env.COLLABCAST_NO_NOTIFY = original;
  }
}

describe('attachNotifier: the operator is not notified of their own posts', () => {
  test('a post by the operator principal fires nothing; another principal fires one', () => {
    const events = new EventEmitter();
    attachEnabled(events);

    events.emit('message.posted', {
      id: '01HOP',
      type: 'chat',
      from: 'prn_operator_01',
      role: 'operator'
    });
    expect(notifyCalls).toEqual([]);

    events.emit('message.posted', {
      id: '01HAG',
      type: 'question',
      from: 'prn_agent_02',
      role: 'listener'
    });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].title).toBe('collabcast — proj');
    expect(notifyCalls[0].message).toContain('prn_agent_02');
    expect(notifyCalls[0].message).toContain('question');
  });

  test('every non-operator role is notified', () => {
    const events = new EventEmitter();
    attachEnabled(events);

    for (const role of ['root', 'goal_hub', 'listener', 'legacy']) {
      events.emit('message.posted', { id: '01H', type: 'chat', from: `prn_${role}`, role });
    }
    expect(notifyCalls).toHaveLength(4);
  });

  test('a principal id that merely reads `operator` is not the operator', () => {
    // The v0.2 check was `p.from === 'operator'`; nothing about the id decides this now.
    const events = new EventEmitter();
    attachEnabled(events);

    events.emit('message.posted', { id: '01H', type: 'chat', from: 'operator', role: 'listener' });
    expect(notifyCalls).toHaveLength(1);
  });

  test('an event naming no role is still notified rather than silently dropped', () => {
    const events = new EventEmitter();
    attachEnabled(events);

    events.emit('message.posted', { id: '01H', type: 'chat', from: 'prn_x' });
    events.emit('message.posted', { id: '01I' });
    expect(notifyCalls).toHaveLength(2);
    expect(notifyCalls[1].message).toContain('unidentified principal');
    expect(notifyCalls[1].message).toContain('(message)');
  });
});

describe('attachNotifier: the dead permit.required subscription is gone', () => {
  test('no listener is registered for permit.required', () => {
    const events = new EventEmitter();
    attachEnabled(events);

    expect(events.listenerCount('permit.required')).toBe(0);
    expect(events.eventNames()).toEqual(['message.posted']);
  });

  test('emitting permit.required notifies nobody', () => {
    const events = new EventEmitter();
    attachEnabled(events);

    events.emit('permit.required', { session_id: 'sess_1' });
    expect(notifyCalls).toEqual([]);
  });
});

describe('attachNotifier: COLLABCAST_NO_NOTIFY still suppresses everything', () => {
  test('no listeners are registered and nothing fires', () => {
    // The suite-wide guard is set; this is the production path a test must never leave.
    expect(process.env.COLLABCAST_NO_NOTIFY).toBeTruthy();
    const events = new EventEmitter();
    attachNotifier({ events, projectName: 'proj' });

    expect(events.eventNames()).toEqual([]);
    events.emit('message.posted', { id: '01H', type: 'chat', from: 'prn_x', role: 'listener' });
    expect(notifyCalls).toEqual([]);
  });
});

describe('attachNotifier: a failed notification is reported, once', () => {
  test('a callback error — the only way a failed spawn surfaces — is reported', () => {
    behaviour.mode = 'callback-error';
    const entries = [];
    const events = new EventEmitter();
    attachEnabled(events, { log: (entry) => entries.push(entry) });

    events.emit('message.posted', { id: '01H', type: 'chat', from: 'prn_x', role: 'listener' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'notify.failed', stage: 'notify' });
    expect(entries[0].reason).toContain('no notifier binary');
  });

  test('a synchronous throw is reported too, and never reaches the emitter', () => {
    behaviour.mode = 'throw';
    const entries = [];
    const events = new EventEmitter();
    attachEnabled(events, { log: (entry) => entries.push(entry) });

    expect(() =>
      events.emit('message.posted', { id: '01H', type: 'chat', from: 'prn_x', role: 'listener' })
    ).not.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'notify.failed', stage: 'spawn' });
  });

  test('a headless box is not told a hundred times', () => {
    behaviour.mode = 'callback-error';
    const entries = [];
    const events = new EventEmitter();
    attachEnabled(events, { log: (entry) => entries.push(entry) });

    for (let i = 0; i < 5; i += 1) {
      events.emit('message.posted', { id: `01H${i}`, type: 'chat', from: 'prn_x', role: 'root' });
    }
    expect(notifyCalls).toHaveLength(5);
    expect(entries).toHaveLength(1);
  });

  test('a throwing log sink does not take a post down', () => {
    behaviour.mode = 'callback-error';
    const events = new EventEmitter();
    attachEnabled(events, {
      log: () => {
        throw new Error('sink is broken');
      }
    });

    expect(() =>
      events.emit('message.posted', { id: '01H', type: 'chat', from: 'prn_x', role: 'root' })
    ).not.toThrow();
  });

  test('a successful notification reports nothing', () => {
    const entries = [];
    const events = new EventEmitter();
    attachEnabled(events, { log: (entry) => entries.push(entry) });

    events.emit('message.posted', { id: '01H', type: 'chat', from: 'prn_x', role: 'root' });
    expect(notifyCalls).toHaveLength(1);
    expect(entries).toEqual([]);
  });
});
