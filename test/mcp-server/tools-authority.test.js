// The tool surface's authority behaviour, driven through a recording API stub.
//
// These are the assertions that the v0.2 holes are actually closed: no handler states its own
// identity, reading never writes a cursor, and every refusal comes back as a structured payload
// a model can branch on.

import { describe, test, expect, beforeEach } from 'vitest';
import { buildTools, LEGACY_AUTHORITY_KEYS } from '../../src/mcp-server/tools.js';
import { createCapabilityHolder } from '../../src/mcp-server/capability.js';
import { walkieError } from '../../src/identity/errors.js';

const TOKEN = 'PsQ2xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE';
const CODE = 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDe4FgH7jKl0MnO';

const SELF = {
  principalId: 'prn_01',
  role: 'goal_hub',
  displayAlias: 'builder',
  scopes: ['channel:read', 'channel:publish', 'channel:ack', 'self:alias', 'self:cursor'],
  capabilityId: 'cap_01',
  expiresAt: '2030-01-01T00:00:00.000Z'
};

/** A cursor position is a message id. */
const ACK_ID = '01J000000000000000000000AA';

/** An API stub that records calls and lets a test make any single method fail. */
function recordingApi(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    const override = overrides[name];
    if (typeof override === 'function') return override(...args);
    return Promise.resolve(defaults[name] ?? {});
  };
  const defaults = {
    self: SELF,
    principals: { principals: [{ id: 'prn_01', role: 'goal_hub', displayAlias: 'builder', createdAt: 't' }] },
    inbox: { messages: [], mentionedForMe: [], lastReadId: ACK_ID, lastAckedId: ACK_ID },
    latest: { messages: [] },
    post: { id: 'msg_1', warnings: [] },
    edit: { id: 'msg_1', revision: 2 },
    archive: { ok: true },
    markRead: { id: ACK_ID },
    ack: { id: ACK_ID },
    setAlias: { id: 'prn_01', displayAlias: 'renamed' },
    enrollExchange: {
      token: TOKEN,
      capabilityId: SELF.capabilityId,
      principalId: SELF.principalId,
      role: SELF.role,
      scopes: SELF.scopes,
      expiresAt: SELF.expiresAt
    }
  };
  const api = {};
  for (const name of Object.keys(defaults)) api[name] = record(name);
  api.calls = calls;
  api.names = () => calls.map((c) => c.name);
  return api;
}

/** A holder already carrying an active capability. */
async function activeHolder(api) {
  const tokenBox = { value: null };
  const holder = createCapabilityHolder({
    api,
    tokenBox,
    namespace: 'walkie-test',
    env: {},
    warn: () => {}
  });
  await holder.adopt(TOKEN);
  return { holder, tokenBox };
}

function callTool(tools, name, args = {}) {
  return tools.call({ params: { name, arguments: args } });
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

describe('tool inventory', () => {
  test('the eight v0.2 names survive, plus walkie_enroll and walkie_ack', async () => {
    const api = recordingApi();
    const { holder } = await activeHolder(api);
    const names = buildTools({ api, capability: holder, namespace: 'walkie-test' })
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      'walkie_ack',
      'walkie_archive',
      'walkie_edit',
      'walkie_enroll',
      'walkie_inbox',
      'walkie_read',
      'walkie_rename',
      'walkie_reply',
      'walkie_sessions',
      'walkie_talk'
    ]);
  });

  test('walkie_inbox keeps its v0.2 input schema exactly', async () => {
    const api = recordingApi();
    const { holder } = await activeHolder(api);
    const inbox = buildTools({ api, capability: holder, namespace: 'walkie-test' })
      .list()
      .find((t) => t.name === 'walkie_inbox');
    expect(Object.keys(inbox.inputSchema.properties)).toEqual(['include_memory_updates']);
  });

  test('walkie_enroll never advertises enrollmentCode as a model input', async () => {
    const api = recordingApi();
    const { holder } = await activeHolder(api);
    const enroll = buildTools({ api, capability: holder, namespace: 'walkie-test' })
      .list()
      .find((t) => t.name === 'walkie_enroll');
    expect(Object.keys(enroll.inputSchema.properties)).not.toContain('enrollmentCode');
    expect(enroll.inputSchema.additionalProperties).toBe(false);
  });
});

describe('server-derived identity', () => {
  /** @type {ReturnType<typeof recordingApi>} */
  let api;
  let tools;
  beforeEach(async () => {
    api = recordingApi();
    const { holder } = await activeHolder(api);
    tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });
  });

  test('walkie_talk sends body, type and replyTo and no authority field at all', async () => {
    await callTool(tools, 'walkie_talk', { body: 'hello', type: 'question' });
    const post = api.calls.find((c) => c.name === 'post');
    expect(post.args[0]).toEqual({ body: 'hello', type: 'question', replyTo: undefined });
    const sent = JSON.stringify(post.args[0]);
    for (const key of LEGACY_AUTHORITY_KEYS) expect(sent).not.toContain(key);
  });

  test('walkie_reply sends only reply content', async () => {
    await callTool(tools, 'walkie_reply', { reply_to: '01HZZ', body: 'ack' });
    const post = api.calls.find((c) => c.name === 'post');
    expect(post.args[0]).toEqual({ body: 'ack', type: 'reply', replyTo: '01HZZ' });
  });

  test('walkie_edit and walkie_archive no longer assert who is acting', async () => {
    await callTool(tools, 'walkie_edit', { id: '01HZZ', body: 'fixed' });
    await callTool(tools, 'walkie_archive', { id: '01HZZ', reason: 'stale' });
    expect(api.calls.find((c) => c.name === 'edit').args[1]).toEqual({ body: 'fixed' });
    expect(api.calls.find((c) => c.name === 'archive').args[1]).toEqual({ reason: 'stale' });
  });

  test('a caller that tries to state its own identity is refused with the offending keys', async () => {
    for (const key of LEGACY_AUTHORITY_KEYS) {
      const result = await callTool(tools, 'walkie_talk', { body: 'x', [key]: 'operator' });
      expect(result.isError).toBe(true);
      const payload = payloadOf(result);
      expect(payload.code).toBe('invalid_request');
      expect(payload.detail.rejected).toEqual([key]);
    }
    expect(api.names()).not.toContain('post');
  });
});

describe('reading never writes', () => {
  test('walkie_inbox performs exactly one non-mutating call', async () => {
    const api = recordingApi();
    const { holder } = await activeHolder(api);
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    const result = await callTool(tools, 'walkie_inbox', {});

    expect(api.names().filter((n) => n !== 'self')).toEqual(['inbox']);
    expect(api.names()).not.toContain('markRead');
    expect(api.names()).not.toContain('ack');
    expect(payloadOf(result).lastReadId).toBe(ACK_ID);
  });

  test('walkie_ack is the only path that moves a cursor, and it moves both by default', async () => {
    const api = recordingApi();
    const { holder } = await activeHolder(api);
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    const result = await callTool(tools, 'walkie_ack', { id: ACK_ID });

    // Acknowledgement lands FIRST and the read cursor follows. The order is load-bearing:
    // `ack` is the durable fact the caller asked for, so if the second call fails the tool can
    // report what actually applied instead of a bare error over a half-applied ack.
    expect(api.names().filter((n) => n !== 'self')).toEqual(['ack', 'markRead']);
    expect(payloadOf(result)).toEqual({
      status: 'acknowledged',
      lastReadId: ACK_ID,
      lastAckedId: ACK_ID
    });
  });

  test('mark_read:false acknowledges without touching the read cursor', async () => {
    const api = recordingApi();
    const { holder } = await activeHolder(api);
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    await callTool(tools, 'walkie_ack', { id: ACK_ID, mark_read: false });

    expect(api.names().filter((n) => n !== 'self')).toEqual(['ack']);
  });

  // An ordinal is exactly what must never reach the service again, so it is refused here.
  test('anything that is not a message id is refused locally', async () => {
    const api = recordingApi();
    const { holder } = await activeHolder(api);
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    for (const id of [7, 'later', ACK_ID.toLowerCase(), `${ACK_ID}X`, null]) {
      const result = await callTool(tools, 'walkie_ack', { id });
      expect(payloadOf(result).code, `ack ${String(id)}`).toBe('invalid_request');
    }
    expect(api.names()).not.toContain('ack');
  });
});

describe('structured refusals', () => {
  test('permit_required has one shape, shared by walkie_talk and walkie_reply', async () => {
    const reject = () =>
      Promise.reject(
        walkieError('permit_required', 'an operator permit is required to publish', {
          operation: 'channel.publish'
        })
      );
    const talkApi = recordingApi({ post: reject });
    const replyApi = recordingApi({ post: reject });
    const talkTools = buildTools({
      api: talkApi,
      capability: (await activeHolder(talkApi)).holder,
      namespace: 'walkie-test'
    });
    const replyTools = buildTools({
      api: replyApi,
      capability: (await activeHolder(replyApi)).holder,
      namespace: 'walkie-test'
    });

    const fromTalk = await callTool(talkTools, 'walkie_talk', { body: 'x' });
    const fromReply = await callTool(replyTools, 'walkie_reply', { reply_to: '01H', body: 'x' });

    expect(payloadOf(fromTalk)).toEqual(payloadOf(fromReply));
    expect(Object.keys(payloadOf(fromTalk)).sort()).toEqual(['code', 'detail', 'message', 'status']);
    // A permit request is an outcome to act on, not a tool error.
    expect(fromTalk.isError).toBeUndefined();
    expect(fromReply.isError).toBeUndefined();
  });

  test('403 not_owner reads as an explanation, not an HTTP string', async () => {
    const err = walkieError('not_owner', 'only the author may edit a message', { id: '01H' });
    err.status = 403;
    const api = recordingApi({ edit: () => Promise.reject(err) });
    const { holder } = await activeHolder(api);
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    const result = await callTool(tools, 'walkie_edit', { id: '01H', body: 'x' });
    const payload = payloadOf(result);

    expect(result.isError).toBe(true);
    expect(payload.code).toBe('not_owner');
    expect(payload.hint).toMatch(/did not author/);
    expect(result.content[0].text).not.toMatch(/HTTP 403/);
  });

  test('archive explains the moderation exception', async () => {
    const api = recordingApi({
      archive: () => Promise.reject(walkieError('not_owner', 'not the author', { id: '01H' }))
    });
    const { holder } = await activeHolder(api);
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    const payload = payloadOf(await callTool(tools, 'walkie_archive', { id: '01H' }));
    expect(payload.code).toBe('not_owner');
    expect(payload.hint).toMatch(/operator moderating/);
  });

  test('409 conflict on rename says the alias is not being taken from anyone', async () => {
    const api = recordingApi({
      setAlias: () => Promise.reject(walkieError('conflict', 'alias already in use'))
    });
    const { holder } = await activeHolder(api);
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    const payload = payloadOf(await callTool(tools, 'walkie_rename', { alias: 'builder' }));
    expect(payload.code).toBe('conflict');
    expect(payload.hint).toMatch(/will not be taken from them/);
    expect(payload.hint).toContain('builder');
  });

  test('an unexpected non-walkie throw never leaks its message', async () => {
    const api = recordingApi({
      latest: () => Promise.reject(new Error('ENOENT /Users/someone/.walkie-talkie/store/db'))
    });
    const { holder } = await activeHolder(api);
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    const result = await callTool(tools, 'walkie_read', {});
    expect(payloadOf(result)).toEqual({
      status: 'error',
      tool: 'walkie_read',
      code: 'internal',
      message: 'walkie_read failed unexpectedly'
    });
  });
});

describe('walkie_enroll', () => {
  test('a model-supplied enrollment code is refused before anything is sent', async () => {
    const api = recordingApi();
    const tokenBox = { value: null };
    const holder = createCapabilityHolder({
      api,
      tokenBox,
      namespace: 'walkie-test',
      env: {},
      warn: () => {}
    });
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    for (const invented of ['please-let-me-in', '123456', 'enrollment-code', CODE.slice(0, 20)]) {
      const result = await callTool(tools, 'walkie_enroll', {
        namespace: 'walkie-test',
        role: 'root',
        scopes: ['channel:read'],
        enrollmentCode: invented
      });
      const payload = payloadOf(result);
      expect(result.isError).toBe(true);
      expect(payload.code).toBe('invalid_request');
      expect(payload.message).toMatch(/must not supply enrollmentCode/);
    }
    expect(api.names()).not.toContain('enrollExchange');
    expect(tokenBox.value).toBeNull();
  });

  test('no injected code at all is reported as a missing operator approval', async () => {
    const api = recordingApi();
    const tokenBox = { value: null };
    const holder = createCapabilityHolder({
      api,
      tokenBox,
      namespace: 'walkie-test',
      env: {},
      warn: () => {}
    });
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    const payload = payloadOf(
      await callTool(tools, 'walkie_enroll', {
        namespace: 'walkie-test',
        role: 'root',
        scopes: ['channel:read']
      })
    );
    expect(payload.code).toBe('permit_required');
    expect(payload.message).toMatch(/no operator approved it/);
    expect(api.names()).not.toContain('enrollExchange');
  });

  test('a hook-injected code is redeemed and the response carries no token', async () => {
    const api = recordingApi();
    const tokenBox = { value: null };
    const holder = createCapabilityHolder({
      api,
      tokenBox,
      namespace: 'walkie-test',
      env: {},
      warn: () => {}
    });
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    const result = await callTool(tools, 'walkie_enroll', {
      namespace: 'walkie-test',
      role: 'root',
      scopes: ['channel:read'],
      enrollmentCode: CODE
    });

    expect(payloadOf(result)).toEqual({
      status: 'enrolled',
      role: SELF.role,
      scopes: SELF.scopes,
      expiresAt: SELF.expiresAt
    });
    expect(result.content[0].text).not.toContain(TOKEN);
    // The token did land where the transport can read it, and nowhere else.
    expect(tokenBox.value).toBe(TOKEN);
  });
});

describe('one authority state for the whole process', () => {
  test('before enrollment every channel tool fails the same actionable way', async () => {
    const api = recordingApi();
    const holder = createCapabilityHolder({
      api,
      tokenBox: { value: null },
      namespace: 'walkie-test',
      env: {},
      warn: () => {}
    });
    const tools = buildTools({ api, capability: holder, namespace: 'walkie-test' });

    for (const name of ['walkie_inbox', 'walkie_read', 'walkie_sessions']) {
      const payload = payloadOf(await callTool(tools, name, {}));
      expect(payload.code).toBe('unauthenticated');
      expect(payload.message).toMatch(/walkie_enroll/);
    }
    expect(api.names()).toEqual([]);
  });

  test('one rejected bearer stops every tool, not just the route that rejected it', async () => {
    // v0.2's split brain: walkie_talk kept succeeding while walkie_inbox 404'd.
    const api = recordingApi({
      inbox: () => Promise.reject(walkieError('unauthenticated', 'capability not accepted'))
    });
    const guardedApi = {
      ...api,
      inbox: async (...args) => {
        try {
          return await api.inbox(...args);
        } catch (err) {
          if (err.code === 'unauthenticated') holder.noteUnauthenticated();
          throw err;
        }
      }
    };
    const { holder } = await activeHolder(api);
    const tools = buildTools({ api: guardedApi, capability: holder, namespace: 'walkie-test' });

    const first = payloadOf(await callTool(tools, 'walkie_inbox', {}));
    expect(first.code).toBe('unauthenticated');

    const afterwards = payloadOf(await callTool(tools, 'walkie_talk', { body: 'still here?' }));
    expect(afterwards.code).toBe('unauthenticated');
    expect(afterwards.message).toMatch(/no longer accepted/);
    expect(api.names()).not.toContain('post');
  });
});
