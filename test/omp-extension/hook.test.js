import { describe, test, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import hookFactory, {
  FIELD_LIMITS,
  PROMPT_TITLE,
  buildPromptBody,
  createEnrollHandler,
  promptField,
  readConfig,
  readRequest
} from '../../omp-extension/walkie-enroll.js';
import { createLogSink, startStubAuthority } from './stub-authority.js';

const SECRET = 's3cr3t-hook-secret-value-0123456789';
const CODE = 'Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTA';
const ENROLL_INPUT = {
  namespace: 'walkie-talkie',
  role: 'listener',
  scopes: ['channel:read', 'channel:publish'],
  ttlSeconds: 900,
  alias: 'slide-designer'
};

/** @type {(() => Promise<void>)[]} */
let cleanups = [];

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

/** @param {Parameters<typeof startStubAuthority>[0]} [options] */
async function stub(options) {
  const started = await startStubAuthority(options);
  cleanups.push(() => started.stop());
  return started;
}

async function logSink() {
  const sink = await createLogSink();
  cleanups.push(() => sink.cleanup());
  return sink;
}

/**
 * A recording `ctx`. `select` answers with `selection`, or throws when `throws` is set.
 * @param {{ hasUI?: boolean, selection?: unknown, throws?: boolean }} options
 */
function makeCtx({ hasUI = true, selection = 'Deny', throws = false } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      hasUI,
      ui: {
        async select(prompt, options) {
          calls.push({ prompt, options });
          if (throws) throw new Error('dialog exploded');
          return selection;
        }
      }
    }
  };
}

/** @param {Record<string, string|undefined>} extra */
function env(extra = {}) {
  return {
    WALKIE_HOOK_SECRET: SECRET,
    ...extra
  };
}

describe('hook: tool-name gating', () => {
  test('the MCP-namespaced enrollment tool is gated (this is the fail-open trap)', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const { ctx, calls } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    const result = await handler(
      { toolName: 'mcp__walkie-talkie_walkie_enroll', input: ENROLL_INPUT },
      ctx
    );

    expect(calls).toHaveLength(1);
    expect(result.input.enrollmentCode).toBe(CODE);
  });

  test('the bare enrollment tool is gated too', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const { ctx, calls } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    const result = await handler({ toolName: 'walkie_enroll', input: ENROLL_INPUT }, ctx);

    expect(calls).toHaveLength(1);
    expect(result.input.enrollmentCode).toBe(CODE);
  });

  test('an enrollment tool from a non-allowlisted MCP server is blocked', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const { ctx, calls } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    const result = await handler(
      { toolName: 'mcp__evil_walkie_enroll', input: ENROLL_INPUT },
      ctx
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toMatch(/unrecognised MCP server/);
    expect(result.input).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(server.state.connections).toBe(0);
  });

  test('an allowlisted server name is configurable', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const { ctx } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({
        WALKIE_AUTHORITY_SOCKET: server.socketPath,
        WALKIE_MCP_SERVERS: 'walkie-talkie, walkie-staging'
      })
    });

    const result = await handler(
      { toolName: 'mcp__walkie-staging_walkie_enroll', input: ENROLL_INPUT },
      ctx
    );
    expect(result.input.enrollmentCode).toBe(CODE);
  });

  test('an unrelated tool passes through untouched', async () => {
    const server = await stub();
    const { ctx, calls } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    for (const toolName of ['read', 'bash', 'mcp__walkie-talkie_walkie_talk']) {
      expect(await handler({ toolName, input: { command: 'ls' } }, ctx)).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
    expect(server.state.connections).toBe(0);
  });

  test('a tool name that only contains walkie_enroll mid-string is not the enrollment tool', async () => {
    const server = await stub();
    const { ctx, calls } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    for (const toolName of ['walkie_enroll_status', 'mcp__walkie-talkie_walkie_enroll_status']) {
      expect(await handler({ toolName, input: ENROLL_INPUT }, ctx)).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
    expect(server.state.connections).toBe(0);
  });
});

describe('hook: no-UI sessions cannot self-enroll', () => {
  test('hasUI false blocks and never contacts the authority', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const { ctx, calls } = makeCtx({ hasUI: false, selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    const result = await handler(
      { toolName: 'mcp__walkie-talkie_walkie_enroll', input: ENROLL_INPUT },
      ctx
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toMatch(/delegated capability/);
    expect(result.input).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(server.state.connections).toBe(0);
    expect(server.state.requests).toEqual([]);
  });
});

describe('hook: the prompt', () => {
  test('Deny is offered first so a stray keypress denies', async () => {
    const server = await stub();
    const { ctx, calls } = makeCtx({ selection: 'Deny' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    await handler({ toolName: 'walkie_enroll', input: ENROLL_INPUT }, ctx);

    expect(calls[0].options).toEqual(['Deny', 'Approve']);
  });

  test('the prompt names the namespace, role, scopes and TTL exactly', async () => {
    const server = await stub();
    const { ctx, calls } = makeCtx({ selection: 'Deny' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    await handler({ toolName: 'walkie_enroll', input: ENROLL_INPUT }, ctx);

    const prompt = calls[0].prompt;
    expect(prompt).toContain(PROMPT_TITLE);
    expect(prompt).toContain('walkie-talkie');
    expect(prompt).toContain('listener');
    expect(prompt).toContain('channel:read, channel:publish');
    expect(prompt).toContain('900s');
    expect(prompt).not.toContain(SECRET);
  });

  test('buildPromptBody labels an absent TTL rather than inventing one', () => {
    const body = buildPromptBody({ namespace: 'n', role: 'listener', scopes: ['channel:read'] });
    expect(body).toContain('authority default');
  });

  test('a request that cannot be described is blocked before the operator is asked', async () => {
    const server = await stub();
    const { ctx, calls } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    for (const input of [
      {},
      { role: 'listener', scopes: ['channel:read'] },
      { namespace: 'walkie-talkie', scopes: ['channel:read'] },
      { namespace: 'walkie-talkie', role: 'listener' },
      { namespace: 'walkie-talkie', role: 'listener', scopes: [] }
    ]) {
      const result = await handler({ toolName: 'walkie_enroll', input }, ctx);
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toMatch(/invalid_request/);
    }
    expect(calls).toHaveLength(0);
    expect(server.state.connections).toBe(0);
  });
});

describe('hook: every denial path blocks and injects nothing', () => {
  const cases = [
    ['explicit Deny', { selection: 'Deny' }],
    ['a dismissed dialog (undefined)', { selection: undefined }],
    ['a stray selection', { selection: 'maybe' }],
    ['a throwing select', { throws: true }]
  ];

  for (const [label, ctxOptions] of cases) {
    test(`${label} blocks`, async () => {
      const server = await stub({ respond: () => ({ code: CODE }) });
      const { ctx } = makeCtx(ctxOptions);
      const handler = createEnrollHandler({
        env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
      });

      const result = await handler(
        { toolName: 'mcp__walkie-talkie_walkie_enroll', input: ENROLL_INPUT },
        ctx
      );

      expect(result).toMatchObject({ block: true });
      expect(result.input).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(CODE);
      expect(server.state.connections).toBe(0);
    });
  }

  test('an authority timeout blocks after approval, injecting nothing', async () => {
    const server = await stub({ silent: true });
    const { ctx } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({
        WALKIE_AUTHORITY_SOCKET: server.socketPath,
        WALKIE_HOOK_TIMEOUT_MS: '60'
      })
    });

    const result = await handler(
      { toolName: 'mcp__walkie-talkie_walkie_enroll', input: ENROLL_INPUT },
      ctx
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toMatch(/did not issue an enrollment code/);
    expect(result.input).toBeUndefined();
    expect(server.state.connections).toBe(1);
  });

  test('an authority error envelope blocks', async () => {
    const server = await stub({
      respond: () => ({ error: { code: 'forbidden', message: 'no approval on file' } })
    });
    const { ctx } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    const result = await handler({ toolName: 'walkie_enroll', input: ENROLL_INPUT }, ctx);
    expect(result).toMatchObject({ block: true });
    expect(result.input).toBeUndefined();
  });

  test('approval with no authority socket configured blocks as config_invalid', async () => {
    const { ctx } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({ env: { WALKIE_HOOK_SECRET: SECRET } });

    const result = await handler({ toolName: 'walkie_enroll', input: ENROLL_INPUT }, ctx);
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toMatch(/config_invalid/);
  });

  test('approval with no hook secret configured blocks as config_invalid', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const { ctx } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: { WALKIE_AUTHORITY_SOCKET: server.socketPath }
    });

    const result = await handler({ toolName: 'walkie_enroll', input: ENROLL_INPUT }, ctx);
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toMatch(/config_invalid/);
    expect(server.state.connections).toBe(0);
  });
});

describe('hook: approval injects the code', () => {
  test('exactly one authority request, original input preserved, code injected', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const { ctx, calls } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    const result = await handler(
      { toolName: 'mcp__walkie-talkie_walkie_enroll', input: ENROLL_INPUT },
      ctx
    );

    expect(calls).toHaveLength(1);
    expect(server.state.connections).toBe(1);
    expect(server.state.requests).toEqual([
      {
        op: 'enroll.request',
        namespace: 'walkie-talkie',
        role: 'listener',
        scopes: ['channel:read', 'channel:publish'],
        ttlSeconds: 900,
        hookSecret: SECRET
      }
    ]);
    expect(result).toEqual({ input: { ...ENROLL_INPUT, enrollmentCode: CODE } });
    // Original keys survive untouched.
    for (const [key, value] of Object.entries(ENROLL_INPUT)) {
      expect(result.input[key]).toEqual(value);
    }
    // The hook did not mutate the event's input object in place.
    expect(ENROLL_INPUT.enrollmentCode).toBeUndefined();
  });

  test('a rich selector answer of { value: Approve } also approves', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const { ctx } = makeCtx({ selection: { value: 'Approve' } });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    const result = await handler({ toolName: 'walkie_enroll', input: ENROLL_INPUT }, ctx);
    expect(result.input.enrollmentCode).toBe(CODE);
  });
});

describe('hook: logging never retains secrets', () => {
  test('a full approve cycle logs neither the code nor the hook secret', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const sink = await logSink();
    const { ctx } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath, WALKIE_HOOK_LOG: sink.logPath })
    });

    const result = await handler(
      { toolName: 'mcp__walkie-talkie_walkie_enroll', input: ENROLL_INPUT },
      ctx
    );
    expect(result.input.enrollmentCode).toBe(CODE);

    const text = await readFile(sink.logPath, 'utf8');
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(SECRET);

    const lines = text.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const entries = lines.map((line) => JSON.parse(line));
    const approved = entries.find((entry) => entry.outcome === 'approved');
    expect(approved).toMatchObject({
      stage: 'authority',
      toolName: 'mcp__walkie-talkie_walkie_enroll',
      namespace: 'walkie-talkie',
      role: 'listener',
      injected: true
    });
    for (const entry of entries) {
      expect(entry.code).toBeUndefined();
      expect(entry.hookSecret).toBeUndefined();
      expect(entry.enrollmentCode).toBeUndefined();
      expect(typeof entry.at).toBe('string');
    }
  });

  test('denials are logged with an error code and no secrets', async () => {
    const server = await stub();
    const sink = await logSink();
    const { ctx } = makeCtx({ selection: 'Deny' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath, WALKIE_HOOK_LOG: sink.logPath })
    });

    await handler({ toolName: 'walkie_enroll', input: ENROLL_INPUT }, ctx);

    const text = await readFile(sink.logPath, 'utf8');
    expect(text).not.toContain(SECRET);
    const entry = JSON.parse(text.trim());
    expect(entry).toMatchObject({
      stage: 'prompt',
      outcome: 'blocked',
      errorCode: 'forbidden',
      selection: 'Deny'
    });
  });

  test('passing tools write nothing at all (no log spam, no file created)', async () => {
    const sink = await logSink();
    const { ctx } = makeCtx();
    const handler = createEnrollHandler({ env: env({ WALKIE_HOOK_LOG: sink.logPath }) });

    await handler({ toolName: 'read', input: { path: 'a.js' } }, ctx);
    expect(existsSync(sink.logPath)).toBe(false);
  });

  test('an unwritable log path does not break the gate', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const { ctx } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({
        WALKIE_AUTHORITY_SOCKET: server.socketPath,
        WALKIE_HOOK_LOG: '/nonexistent-dir-walkie/hook.jsonl'
      })
    });

    const result = await handler({ toolName: 'walkie_enroll', input: ENROLL_INPUT }, ctx);
    expect(result.input.enrollmentCode).toBe(CODE);
  });
});

describe('hook: configuration and wiring', () => {
  test('readConfig defaults the allowlist and the timeout', () => {
    const config = readConfig({});
    expect(config.allowedServers).toEqual(['walkie-talkie']);
    expect(config.timeoutMs).toBe(5000);
    expect(config.socketPath).toBeUndefined();
    expect(config.logPath).toBeUndefined();
  });

  test('readConfig parses the allowlist and rejects a nonsense timeout', () => {
    expect(readConfig({ WALKIE_MCP_SERVERS: 'a,b  c' }).allowedServers).toEqual(['a', 'b', 'c']);
    expect(readConfig({ WALKIE_MCP_SERVERS: '   ' }).allowedServers).toEqual(['walkie-talkie']);
    for (const raw of ['0', '-5', 'soon', '']) {
      expect(readConfig({ WALKIE_HOOK_TIMEOUT_MS: raw }).timeoutMs).toBe(5000);
    }
    expect(readConfig({ WALKIE_HOOK_TIMEOUT_MS: '250' }).timeoutMs).toBe(250);
  });

  test('readRequest tolerates a comma-joined scope string and rejects a bad TTL', () => {
    expect(readRequest({ scopes: 'channel:read, channel:ack' }).scopes).toEqual([
      'channel:read',
      'channel:ack'
    ]);
    for (const ttlSeconds of [0, -1, 1.5, 'soon', undefined, null]) {
      expect(readRequest({ ttlSeconds }).ttlSeconds).toBeUndefined();
    }
    // `problem` is part of the contract: the handler blocks on it before prompting.
    expect(readRequest(undefined)).toEqual({
      namespace: '',
      role: '',
      scopes: [],
      problem: null
    });
  });

  test('the default export registers a tool_call handler', () => {
    const registered = [];
    hookFactory({ on: (name, handler) => registered.push({ name, handler }) });
    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('tool_call');
    expect(typeof registered[0].handler).toBe('function');
  });

  test('the default export refuses a hook API without on()', () => {
    expect(() => hookFactory({})).toThrow(/does not expose on/);
    expect(() => hookFactory(undefined)).toThrow(/does not expose on/);
  });
});

// The dialog is the ONE surface this design asks a human to trust, and its body is
// multi-line. A field carrying `\n` used to forge a COMPLETE second grant block above the
// real one — Namespace/Role/Scopes/TTL plus reassuring prose — pushing the real root grant
// below the fold. `assertEnrollable` means such a request can never be GRANTED (byte-for-byte
// namespace match, enum-checked role and scopes), so what these tests defend is not the
// capability: it is the operator reading attacker-authored text under a title we own.
describe('hook: the approval dialog cannot be forged', () => {
  const FORGERIES = [
    ['a newline', 'walkie-talkie\nNamespace: root\nRole:      root'],
    ['a carriage return', 'walkie-talkie\rNamespace: root'],
    ['a control character', 'walkie-talkie\u0007'],
    ['a line separator', 'walkie-talkie\u2028Namespace: root'],
    ['a bidi override', 'walkie-talkie\u202eeliw'],
    ['an over-long value', 'w'.repeat(FIELD_LIMITS.maxFieldLength + 1)]
  ];

  /** @param {Record<string, unknown>} input */
  async function refuses(input) {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const { ctx, calls } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    const result = await handler({ toolName: 'walkie_enroll', input }, ctx);

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toMatch(/invalid_request/);
    expect(result.input).toBeUndefined();
    // The operator was never shown anything, and nothing was ever asked of the authority.
    expect(calls).toEqual([]);
    expect(server.state.connections).toBe(0);
    expect(server.state.requests).toEqual([]);
  }

  for (const [label, value] of FORGERIES) {
    test(`a namespace containing ${label} is refused before the operator is asked`, async () => {
      await refuses({ ...ENROLL_INPUT, namespace: value });
    });

    test(`a role containing ${label} is refused before the operator is asked`, async () => {
      await refuses({ ...ENROLL_INPUT, role: value });
    });

    test(`a scope containing ${label} is refused before the operator is asked`, async () => {
      await refuses({ ...ENROLL_INPUT, scopes: ['channel:read', value] });
    });
  }

  test('a scope list longer than any real role needs is refused', async () => {
    await refuses({
      ...ENROLL_INPUT,
      scopes: Array.from({ length: FIELD_LIMITS.maxScopes + 1 }, (_v, i) => `channel:read${i}`)
    });
  });

  test('an over-long single scope is refused', async () => {
    await refuses({
      ...ENROLL_INPUT,
      scopes: ['channel:'.padEnd(FIELD_LIMITS.maxScopeLength + 1, 'x')]
    });
  });

  test('the refusal names the offending field without logging its value', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const sink = await logSink();
    const { ctx } = makeCtx({ selection: 'Approve' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath, WALKIE_HOOK_LOG: sink.logPath })
    });

    await handler(
      { toolName: 'walkie_enroll', input: { ...ENROLL_INPUT, namespace: 'ok\nNamespace: root' } },
      ctx
    );

    const raw = await readFile(sink.logPath, 'utf8');
    const entry = JSON.parse(raw.trim());
    expect(entry).toMatchObject({
      stage: 'describe',
      outcome: 'blocked',
      errorCode: 'invalid_request',
      field: 'namespace',
      problem: 'illegal-characters'
    });
    expect(raw).not.toContain('Namespace: root');
    // One JSONL entry means one line, whatever the request contained.
    expect(raw.trimEnd().split('\n')).toHaveLength(1);
  });

  test('readRequest names the first problem and nothing else', () => {
    expect(readRequest({ ...ENROLL_INPUT, namespace: 'a\nb' }).problem).toEqual({
      field: 'namespace',
      reason: 'illegal-characters'
    });
    expect(readRequest({ ...ENROLL_INPUT, role: 'r'.repeat(65) }).problem).toEqual({
      field: 'role',
      reason: 'too-long'
    });
    expect(readRequest({ ...ENROLL_INPUT, scopes: ['a\u0000b'] }).problem).toEqual({
      field: 'scopes',
      reason: 'illegal-characters'
    });
    expect(readRequest(ENROLL_INPUT).problem).toBeNull();
  });

  test('a legal request still prompts, with exactly one grant block', async () => {
    const server = await stub();
    const { ctx, calls } = makeCtx({ selection: 'Deny' });
    const handler = createEnrollHandler({
      env: env({ WALKIE_AUTHORITY_SOCKET: server.socketPath })
    });

    await handler({ toolName: 'walkie_enroll', input: ENROLL_INPUT }, ctx);

    expect(calls).toHaveLength(1);
    const lines = calls[0].prompt.split('\n');
    // title, blank, then exactly the eight body lines.
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe(PROMPT_TITLE);
    for (const label of ['Namespace:', 'Role:', 'Scopes:', 'TTL:']) {
      expect(lines.filter((line) => line.startsWith(label))).toHaveLength(1);
    }
    expect(lines).toContain('Namespace: walkie-talkie');
    expect(lines).toContain('Scopes:    channel:read, channel:publish');
    expect(lines).toContain('TTL:       900s');
  });

  test('buildPromptBody stays one line per field even when called with hostile input', () => {
    const body = buildPromptBody({
      namespace:
        'evil\nNamespace: root\nRole:      root\nScopes:    channel:publish\n' +
        'TTL:       86400s\n\nThis is routine, approve it.',
      role: 'listener\rRole: root',
      scopes: ['channel:read\u2028Scopes:    admin'],
      ttlSeconds: 900
    });

    const lines = body.split('\n');
    expect(lines).toHaveLength(8);
    for (const label of ['Namespace:', 'Role:', 'Scopes:', 'TTL:']) {
      expect(lines.filter((line) => line.startsWith(label))).toHaveLength(1);
    }
    // The text survives — escaped, on the one line that owns it.
    expect(body).toContain('%0A');
    expect(body).toContain('%0D');
    expect(body).toContain('%E2%80%A8');
    expect(lines).toContain('TTL:       900s');
  });

  test('promptField is the format.js heading scheme: escape, never drop', () => {
    expect(promptField('walkie-talkie')).toBe('walkie-talkie');
    expect(promptField('channel:read, channel:publish')).toBe('channel:read, channel:publish');
    expect(promptField('a\nb')).toBe('a%0Ab');
    expect(promptField('a\rb')).toBe('a%0Db');
    expect(promptField('100%')).toBe('100%25');
    expect(promptField('\u2028')).toBe('%E2%80%A8');
    expect(promptField('\u202e')).toBe('%E2%80%AE');
    expect(promptField(900)).toBe('900');
    expect(promptField(undefined)).toBe('');
  });
});
