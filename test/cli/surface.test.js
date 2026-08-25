// The operator CLI, driven as a real subprocess.
//
// Three things are under test: the commands that no longer exist, the commands that replaced
// them, and the failure contract — v0.2 neither awaited nor caught `program.parseAsync`, so a
// failing command printed a raw stack trace and its exit code was whatever Node felt like.

import { describe, test, expect, afterEach } from 'vitest';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegisteredNamespace } from '../helpers/registered-namespace.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'walkie.js');
const TOKEN = 'QqQ9xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE';

const SELF = {
  principalId: 'prn_op',
  role: 'operator',
  displayAlias: 'trev',
  scopes: ['channel:read', 'channel:publish', 'channel:ack', 'self:alias', 'self:cursor'],
  capabilityId: 'cap_op',
  expiresAt: '2030-06-01T12:00:00.000Z'
};

/** @type {Array<() => Promise<void>>} */
const teardown = [];
afterEach(async () => {
  while (teardown.length) await teardown.pop()();
});

/** Run the CLI and resolve with its outcome, never throwing on a non-zero exit. */
function walkie(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, env, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, stdout, stderr });
      }
    );
  });
}

function stubService(socketPath, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const record = { method: req.method, url: req.url, headers: req.headers, body: raw };
      seen.push(record);
      const { status = 200, json = {} } = handler(record) ?? {};
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      teardown.push(() => new Promise((done) => server.close(() => done())));
      resolve({ seen });
    });
  });
}

describe('command surface', () => {
  test('the permit model is gone from the CLI entirely', async () => {
    const help = await walkie(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).not.toMatch(/\bpermit\b/);
    expect(help.stdout).not.toMatch(/^\s*remove\b/m);

    for (const gone of ['permit', 'remove', 'invite', 'alias']) {
      const result = await walkie([gone, 'someone']);
      expect(result.code, `${gone} should not exist`).not.toBe(0);
      expect(result.stderr).toMatch(/unknown command/i);
      expect(result.stderr).not.toMatch(/^\s+at /m);
    }
  });

  test('the replacements are advertised', async () => {
    const { stdout, code } = await walkie(['--help']);
    expect(code).toBe(0);
    for (const command of ['whoami', 'enroll', 'revoke', 'ack', 'sessions', 'rename', 'talk']) {
      expect(stdout).toContain(command);
    }
  });

  test('--version still prints semver', async () => {
    const { stdout, code } = await walkie(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('talk no longer offers --as, so an operator cannot post under another alias', async () => {
    const { stdout } = await walkie(['help', 'talk']);
    expect(stdout).not.toContain('--as');
    const ns = createRegisteredNamespace();
    const attempt = await walkie(['talk', '--as', 'someone-else', 'hi'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });
    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toMatch(/unknown option/i);
  });
});

describe('failure contract', () => {
  test('a missing operator credential exits 2 with one clean line', async () => {
    const ns = createRegisteredNamespace();
    const { code, stderr, stdout } = await walkie(['whoami'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });

    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^walkie \[unauthenticated]: /);
    expect(stderr.trim().split('\n')).toHaveLength(1);
    expect(stderr).not.toMatch(/^\s+at /m);
    expect(stderr).not.toContain('node:internal');
  });

  test('an unreachable service exits 3 and names the supervisor', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential(TOKEN);
    const { code, stderr } = await walkie(['whoami'], { cwd: ns.canonicalRoot, env: ns.env });

    expect(code).toBe(3);
    expect(stderr).toMatch(/^walkie \[unavailable]: /);
    expect(stderr).toMatch(/Paseo/);
    expect(stderr).not.toContain(ns.socketPath);
    expect(stderr).not.toMatch(/^\s+at /m);
  });

  test('an unregistered directory is refused, not silently defaulted', async () => {
    const ns = createRegisteredNamespace();
    const { code, stderr } = await walkie(['sessions'], {
      cwd: ns.canonicalRoot,
      // A registered project, but the identity map does not know it.
      env: { ...ns.env, WALKIE_IDENTITIES: join(ns.base, 'nope.json') }
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^walkie \[config_invalid]: /);
  });
});

describe('managed mode refuses lifecycle commands', () => {
  test('start, stop and status all defer to Paseo', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    for (const command of ['start', 'stop', 'status']) {
      const { code, stderr } = await walkie([command], { cwd: ns.canonicalRoot, env: ns.env });
      expect(code, `${command} in managed mode`).toBe(2);
      expect(stderr).toMatch(/^walkie \[forbidden]: /);
      expect(stderr).toMatch(/managed/);
      expect(stderr).not.toMatch(/^\s+at /m);
    }
  });

  test('standalone mode does not refuse status', async () => {
    const ns = createRegisteredNamespace({ mode: 'standalone' });
    const { code, stdout } = await walkie(['status'], { cwd: ns.canonicalRoot, env: ns.env });
    expect(code).toBe(0);
    expect(stdout).toMatch(/not answering/);
    expect(stdout).toMatch(/walkie start/);
  });
});

describe('whoami', () => {
  test('renders the namespace, principal, role, scopes and expiry from the service', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential(TOKEN);
    const service = await stubService(ns.socketPath, () => ({ status: 200, json: SELF }));

    const { code, stdout, stderr } = await walkie(['whoami'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });

    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain(`namespace:  ${ns.namespace} (managed)`);
    expect(stdout).toContain('principal:  prn_op  @trev');
    expect(stdout).toContain('role:       operator');
    expect(stdout).toContain('scopes:     channel:read, channel:publish');
    expect(stdout).toContain('capability: cap_op');
    expect(stdout).toContain('expires:    2030-06-01T12:00:00.000Z');
    expect(stdout).not.toContain(TOKEN);

    expect(service.seen).toHaveLength(1);
    expect(service.seen[0].url).toBe('/self');
    expect(service.seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('reports drift instead of trusting a stale credential document', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential({
      token: TOKEN,
      role: 'listener',
      scopes: ['channel:read'],
      expiresAt: '2020-01-01T00:00:00.000Z'
    });
    await stubService(ns.socketPath, () => ({ status: 200, json: SELF }));

    const { code, stdout } = await walkie(['whoami'], { cwd: ns.canonicalRoot, env: ns.env });

    expect(code).toBe(0);
    expect(stdout).toContain('role:       operator');
    expect(stdout).toMatch(/disagrees with the service on expiresAt, role, scopes/);
    expect(stdout).toMatch(/service is authoritative/);
  });

  test('--json is machine-readable and still tokenless', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential(TOKEN);
    await stubService(ns.socketPath, () => ({ status: 200, json: SELF }));

    const { code, stdout } = await walkie(['whoami', '--json'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      namespace: ns.namespace,
      mode: 'managed',
      principalId: 'prn_op',
      role: 'operator',
      capabilityId: 'cap_op',
      credentialDrift: []
    });
    expect(stdout).not.toContain(TOKEN);
  });
});

describe('enroll --recovery', () => {
  test('refuses without --recovery and explains the ordinary path', async () => {
    const ns = createRegisteredNamespace();
    ns.writeOperatorCredential(TOKEN);
    const { code, stderr } = await walkie(['enroll'], { cwd: ns.canonicalRoot, env: ns.env });
    expect(code).toBe(1);
    expect(stderr).toMatch(/refusing to enroll without --recovery/);
    expect(stderr).toMatch(/walkie_enroll/);
    expect(stderr).toMatch(/approval hook/);
  });

  test('mints a delegated capability and prints the token exactly once', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential(TOKEN);
    const minted = 'MmM9xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE';
    const service = await stubService(ns.socketPath, () => ({
      status: 201,
      json: {
        token: minted,
        capabilityId: 'cap_new',
        principalId: 'prn_new',
        role: 'listener',
        scopes: ['channel:read', 'self:cursor'],
        expiresAt: '2030-01-01T00:00:00.000Z'
      }
    }));

    const { code, stdout } = await walkie(['enroll', '--recovery'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });

    expect(code).toBe(0);
    expect(stdout).toContain('cap_new');
    expect(stdout).toContain(minted);
    expect(stdout.split(minted)).toHaveLength(2);
    expect(stdout).toMatch(/shown once/);
    expect(stdout).toMatch(/WALKIE_CAPABILITY/);
    // The operator's own token is never echoed while using it.
    expect(stdout).not.toContain(TOKEN);

    const [request] = service.seen;
    expect(request.url).toBe('/delegate');
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // ttlSeconds is mandatory on /delegate, so the CLI must always supply one.
    expect(JSON.parse(request.body)).toEqual({
      role: 'listener',
      scopes: ['channel:read', 'self:cursor'],
      ttlSeconds: 3600
    });
  });

  test('a role that cannot be delegated is refused before any request', async () => {
    const ns = createRegisteredNamespace();
    ns.writeOperatorCredential(TOKEN);
    const { code, stderr } = await walkie(['enroll', '--recovery', '--role', 'root'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/--role must be one of goal_hub, listener/);
  });

  test('a scope outside the role allowlist is refused with the allowlist', async () => {
    const ns = createRegisteredNamespace();
    ns.writeOperatorCredential(TOKEN);
    const { code, stderr } = await walkie(
      ['enroll', '--recovery', '--role', 'listener', '--scopes', 'channel:publish'],
      { cwd: ns.canonicalRoot, env: ns.env }
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/role listener may not hold channel:publish/);
    expect(stderr).toMatch(/listener:consume/);
  });

  test('revoke sends a delete for the named capability', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential(TOKEN);
    const service = await stubService(ns.socketPath, () => ({ status: 200, json: { ok: true } }));

    const { code, stdout } = await walkie(['revoke', 'cap_new'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Revoked cap_new and everything delegated from it/);
    expect(service.seen.map((r) => `${r.method} ${r.url}`)).toEqual(['DELETE /capability/cap_new']);
  });
});

describe('operator writes state no identity', () => {
  test('talk, edit and archive send content only', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential(TOKEN);
    const service = await stubService(ns.socketPath, (req) => {
      if (req.method === 'POST' && req.url === '/channel/message') {
        return { status: 201, json: { id: '01HZZZ', warnings: [] } };
      }
      if (req.method === 'PATCH') return { status: 200, json: { id: '01HZZZ', revision: 2 } };
      return { status: 200, json: { ok: true } };
    });

    await walkie(['talk', 'hello', 'channel'], { cwd: ns.canonicalRoot, env: ns.env });
    await walkie(['edit', '01HZZZ', 'fixed', 'it'], { cwd: ns.canonicalRoot, env: ns.env });
    await walkie(['archive', '01HZZZ', '--reason', 'stale'], { cwd: ns.canonicalRoot, env: ns.env });

    const bodies = service.seen.map((r) => JSON.parse(r.body));
    expect(bodies).toEqual([
      { body: 'hello channel', type: 'broadcast' },
      { body: 'fixed it' },
      { reason: 'stale' }
    ]);
    for (const key of ['fromSessionId', 'fromAlias', 'fromTool', 'editedBy', 'archivedBy']) {
      expect(service.seen.map((r) => r.body).join()).not.toContain(key);
    }
  });

  test('ack is explicit, takes a message id and moves both cursors', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential(TOKEN);
    const ID = '01J0000000000000000000000A';
    const service = await stubService(ns.socketPath, () => ({ status: 200, json: { id: ID } }));

    const { code, stdout } = await walkie(['ack', ID], { cwd: ns.canonicalRoot, env: ns.env });
    expect(code).toBe(0);
    expect(stdout).toMatch(new RegExp(`Acknowledged through ${ID}`));
    expect(service.seen.map((r) => r.url)).toEqual(['/cursor/read', '/cursor/ack']);
    // Both carry the view flag: each `/inbox` view has its own cursor pair, so a cursor
    // write that does not name the view cannot land on the right mark.
    expect(service.seen.map((r) => JSON.parse(r.body))).toEqual([
      { id: ID, include_memory_updates: false },
      { id: ID, include_memory_updates: false }
    ]);

    const noRead = await walkie(['ack', ID, '--no-mark-read'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });
    expect(noRead.code).toBe(0);
    expect(service.seen.slice(2).map((r) => r.url)).toEqual(['/cursor/ack']);
  });

  // An ordinal is not a cursor any more, and the CLI must refuse one locally rather than
  // send it: a bare `2` reaching the service would be a 400 at best and, before ids, was
  // the value that silently acked past unread messages.
  test('ack refuses an ordinal without calling the service', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential(TOKEN);
    const service = await stubService(ns.socketPath, () => ({ status: 200, json: { id: 'x' } }));

    const { code, stderr } = await walkie(['ack', '2'], { cwd: ns.canonicalRoot, env: ns.env });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/message you processed/);
    expect(service.seen).toEqual([]);
  });

  test('reading the inbox writes no cursor', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential(TOKEN);
    const service = await stubService(ns.socketPath, () => ({
      status: 200,
      json: {
        messages: [],
        mentionedForMe: [],
        lastReadId: '01J0000000000000000000000C',
        lastAckedId: '01J0000000000000000000000A'
      }
    }));

    const { code, stdout } = await walkie(['inbox', '--format', 'json'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      messages: [],
      mentionedForMe: [],
      lastReadId: '01J0000000000000000000000C',
      lastAckedId: '01J0000000000000000000000A',
      // This stub answers without the per-view marks, so the CLI reports null rather than
      // inventing them — it never guesses where the other view's cursor stands.
      cursors: null
    });
    expect(service.seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /inbox?include_memory_updates=false'
    ]);
  });

  test('rename says the alias is not taken from its holder', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    ns.writeOperatorCredential(TOKEN);
    await stubService(ns.socketPath, () => ({
      status: 409,
      json: { error: { code: 'conflict', message: 'alias already in use', detail: { alias: 'trev' } } }
    }));

    const { code, stderr } = await walkie(['rename', 'trev'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/^walkie \[conflict]: alias already in use/);
    expect(stderr).not.toMatch(/^\s+at /m);
  });
});

describe('walkie config', () => {
  test('prints the config', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    const { code, stdout } = await walkie(['config'], { cwd: ns.canonicalRoot, env: ns.env });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      schemaVersion: 3,
      namespace: ns.namespace,
      mode: 'managed'
    });
  });

  test('a valid --set is applied with its real type, not as a string', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    const enabled = await walkie(['config', '--set', 'transport.tcp.enabled=false'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });
    expect(enabled.code).toBe(0);
    const after = JSON.parse(
      readFileSync(join(ns.walkieDir, 'config.json'), 'utf8')
    );
    expect(after.transport).toEqual({ tcp: { enabled: false } });

    const mode = await walkie(['config', '--set', 'mode=standalone'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });
    expect(mode.code).toBe(0);
    expect(JSON.parse(readFileSync(join(ns.walkieDir, 'config.json'), 'utf8')).mode).toBe(
      'standalone'
    );
  });

  test('a --set that would brick the namespace is refused and nothing is written', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    const before = readFileSync(join(ns.walkieDir, 'config.json'), 'utf8');

    for (const assignment of ['mode=frantic', 'nonsense=1', 'retention.hotDays=0']) {
      const { code, stderr } = await walkie(['config', '--set', assignment], {
        cwd: ns.canonicalRoot,
        env: ns.env
      });
      expect(code, assignment).toBe(1);
      expect(stderr).toMatch(/^walkie \[config_invalid]: /);
      expect(stderr).not.toMatch(/^\s+at /m);
    }
    expect(readFileSync(join(ns.walkieDir, 'config.json'), 'utf8')).toBe(before);
  });

  test('changing the namespace out from under the identity map is refused', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    const { code, stderr } = await walkie(['config', '--set', 'namespace=something-else'], {
      cwd: ns.canonicalRoot,
      env: ns.env
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/resolves to/);
  });
});
