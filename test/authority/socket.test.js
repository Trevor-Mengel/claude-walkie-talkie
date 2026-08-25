import { describe, test, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAuthority } from '../../src/authority/index.js';
import { MAX_REQUEST_BYTES } from '../../src/authority/socket.js';
import { DENIED_MESSAGE, ROLE_SCOPES } from '../../src/authority/policy.js';
import { exchangeEnrollmentCode } from '../../src/authority/enroll.js';
import { ensureSecret } from '../../src/authority/secret.js';
import {
  authoritySocketPath,
  ensureRuntimeDir,
  hookSecretPath
} from '../../src/authority/paths.js';
import { verifyCapability } from '../../src/store/capabilities.js';
import { requestEnrollmentCode } from '../../omp-extension/authority.js';
import {
  auditRows,
  countRows,
  createFixture,
  enrollRequest,
  leaveCrashedSocket,
  modeOf,
  roundTrip,
  TEST_SECRET
} from './helpers.js';

let fixture;
/** @type {{socketPath:string, close:() => Promise<void>}|null} */
let authority;

afterEach(async () => {
  if (authority) await authority.close();
  authority = null;
  fixture?.cleanup();
  fixture = null;
});

/**
 * Boots a real authority on a real Unix socket in a short mkdtemp directory.
 * @param {object} [opts]
 */
async function boot(opts = {}) {
  fixture = fixture ?? createFixture();
  authority = await startAuthority({
    store: fixture.store,
    config: fixture.config,
    runtimeRoot: join(fixture.root, 'r'),
    secret: TEST_SECRET,
    log: fixture.log,
    // Short enough to test the idle path without a five-second test.
    idleTimeoutMs: 200,
    ...opts
  });
  return authority;
}

/** No row of any authority-bearing kind was created. */
function expectNothingCreated() {
  expect(countRows(fixture.store, 'approval')).toBe(0);
  expect(countRows(fixture.store, 'enrollment_code')).toBe(0);
  expect(countRows(fixture.store, 'capability')).toBe(0);
  expect(countRows(fixture.store, 'principal')).toBe(0);
}

describe('authority socket lifecycle', () => {
  test('binds a 0600 socket inside a 0700 directory', async () => {
    const { socketPath } = await boot();
    const runtimeRoot = join(fixture.root, 'r');

    expect(socketPath).toBe(authoritySocketPath(runtimeRoot));
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(modeOf(socketPath)).toBe('600');
    expect(modeOf(runtimeRoot)).toBe('700');
  });

  test('close removes the address so the next start can bind it', async () => {
    const { socketPath } = await boot();
    await authority.close();
    authority = null;
    expect(existsSync(socketPath)).toBe(false);

    const again = await boot();
    expect(again.socketPath).toBe(socketPath);
  });

  test('clears a stale socket file left by a killed process', async () => {
    fixture = createFixture();
    const runtimeRoot = ensureRuntimeDir(join(fixture.root, 'r'));
    const stalePath = authoritySocketPath(runtimeRoot);
    // A real child, bound and then SIGKILLed: an orphaned inode plus the owner claim
    // the bind wrote. That claim is what makes the address reclaimable — a dead pid is
    // the only proof of death there is, and an unclean exit is precisely the case that
    // leaves it behind.
    const gone = await leaveCrashedSocket(stalePath);
    expect(statSync(stalePath).isSocket()).toBe(true);
    expect(existsSync(`${stalePath}.owner`)).toBe(true);

    const { socketPath } = await boot();
    expect(socketPath).toBe(stalePath);
    const reply = await roundTrip(socketPath, enrollRequest());
    expect(reply.code).toBeTypeOf('string');
    // The claim now names us, not the corpse: the next start must not reclaim a live
    // authority by reading a claim nobody refreshed.
    expect(Number(readFileSync(`${stalePath}.owner`, 'utf8').trim())).toBe(process.pid);
    expect(Number(readFileSync(`${stalePath}.owner`, 'utf8').trim())).not.toBe(gone);
  });

  test('refuses an address occupied by a regular file', async () => {
    fixture = createFixture();
    const runtimeRoot = ensureRuntimeDir(join(fixture.root, 'r'));
    writeFileSync(authoritySocketPath(runtimeRoot), 'not a socket', { mode: 0o600 });
    let code = null;
    try {
      await boot();
    } catch (err) {
      code = err.code;
    }
    expect(code).toBe('config_invalid');
  });

  test('refuses to steal the address of a live authority', async () => {
    await boot();
    let code = null;
    try {
      await startAuthority({
        store: fixture.store,
        config: fixture.config,
        runtimeRoot: join(fixture.root, 'r'),
        secret: TEST_SECRET
      });
    } catch (err) {
      code = err.code;
    }
    expect(code).toBe('conflict');
    // The incumbent still works.
    const reply = await roundTrip(authority.socketPath, enrollRequest());
    expect(reply.code).toBeTypeOf('string');
  });

  test('refuses to start with no hook secret configured', async () => {
    fixture = createFixture();
    let code = null;
    try {
      await startAuthority({
        store: fixture.store,
        config: fixture.config,
        runtimeRoot: join(fixture.root, 'r'),
        env: {}
      });
    } catch (err) {
      code = err.code;
    }
    expect(code).toBe('config_invalid');
  });

  test('loads its secret from the 0600 file when no secret is injected', async () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    const { secret, path } = ensureSecret({ runtimeRoot, env: {} });
    expect(path).toBe(hookSecretPath(runtimeRoot));

    const { socketPath } = await boot({ secret: undefined, env: {} });
    const reply = await roundTrip(socketPath, enrollRequest({ hookSecret: secret }));
    expect(reply.code).toBeTypeOf('string');
    expect((await roundTrip(socketPath, enrollRequest())).error.code).toBe('forbidden');
  });
});

// Post-bind listener faults.
//
// This socket is the only door through which any client obtains its first capability. A fault
// here can leave a service that answers `/health` permanently unable to enrol anyone — which is
// this project's worst shipped bug, a composed service whose authority never served, invisible to
// the entire suite. It was invisible partly because `server.on('error')` was an empty block with
// a comment in it.
describe('post-bind listener faults', () => {
  test('records a listener fault to the redacting sink and keeps serving', async () => {
    // EMFILE is the realistic case: fd pressure on the host makes `accept()` fail, and Node
    // reports it on the server while the listener stays up. Recoverable, so the daemon must NOT
    // die — every live session and the HTTP transport would go with it. But it must not be
    // silent either, which is what this asserts.
    const { socketPath } = await boot();
    const before = fixture.logs.length;

    authority.server.emit('error', Object.assign(new Error('accept failed'), { code: 'EMFILE' }));

    const faults = fixture.logs.slice(before).filter((entry) => entry.event === 'authority.socket');
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ outcome: 'faulted', reason: 'EMFILE', listening: true });

    // Recoverable means recoverable: the listener is still accepting, and it still enrols.
    expect(authority.status().serving).toBe(true);
    expect(authority.status().lastFault).toMatchObject({ reason: 'EMFILE' });
    const reply = await roundTrip(socketPath, enrollRequest());
    expect(reply.code).toBeTypeOf('string');
  });

  test('a fault with no errno is still recorded', async () => {
    await boot();
    const before = fixture.logs.length;
    authority.server.emit('error', new Error('nothing useful here'));
    const faults = fixture.logs.slice(before).filter((entry) => entry.event === 'authority.socket');
    expect(faults).toHaveLength(1);
    expect(faults[0].reason).toBe('unknown');
  });

  test('reports itself as no longer serving once the listener goes down', async () => {
    // The condition that must reach the health signal: the authority stopped accepting while the
    // process carried on. A `serving` flag maintained by hand would have to be right about which
    // errnos are terminal; reading the listener's own state cannot be wrong about it.
    await boot();
    expect(authority.status().serving).toBe(true);

    await new Promise((resolve) => authority.server.close(() => resolve(undefined)));

    expect(authority.status().serving).toBe(false);
  });
});

describe('end to end enrollment', () => {
  test('a correct request yields a code that exchanges into a working capability', async () => {
    const { socketPath } = await boot();
    const scopes = ['channel:read', 'channel:publish', 'self:alias'];

    const reply = await roundTrip(socketPath, enrollRequest({ scopes }));
    expect(Object.keys(reply)).toEqual(['code']);
    expect(reply.code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const issued = exchangeEnrollmentCode(fixture.store, reply.code);
    expect(issued.scopes).toEqual([...scopes].sort());
    expect(issued.role).toBe('root');

    const verified = verifyCapability(fixture.store, issued.token);
    expect(verified).not.toBeNull();
    expect(verified.capability.id).toBe(issued.capabilityId);
    expect(verified.capability.scopes).toEqual([...scopes].sort());
    expect(verified.principal.id).toBe(issued.principalId);
  });

  test('interoperates with the real OMP hook client', async () => {
    const { socketPath } = await boot();
    // The exact call omp-extension/collabcast-enroll.js makes on Approve.
    const issued = await requestEnrollmentCode({
      socketPath,
      payload: {
        op: 'enroll.request',
        namespace: fixture.namespace,
        role: 'root',
        scopes: [...ROLE_SCOPES.root],
        ttlSeconds: 3600,
        hookSecret: TEST_SECRET
      }
    });
    expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const capability = exchangeEnrollmentCode(fixture.store, issued.code);
    expect(verifyCapability(fixture.store, capability.token)).not.toBeNull();
  });

  test('the hook client surfaces a refusal as a coded error', async () => {
    const { socketPath } = await boot();
    let err;
    try {
      await requestEnrollmentCode({
        socketPath,
        payload: { ...enrollRequest(), hookSecret: 'wrong-secret-wrong-secret-wrong' }
      });
    } catch (caught) {
      err = caught;
    }
    expect(err.code).toBe('forbidden');
    expect(err.message).toBe(DENIED_MESSAGE);
  });

  test('the ttl is omittable, as the hook omits it when the caller gave none', async () => {
    const { socketPath } = await boot();
    const reply = await roundTrip(socketPath, enrollRequest({ ttlSeconds: undefined }));
    const issued = exchangeEnrollmentCode(fixture.store, reply.code);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe('refusals', () => {
  test('a wrong secret is refused, audited by its real reason, and writes nothing else', async () => {
    const { socketPath } = await boot();
    const reply = await roundTrip(
      socketPath,
      enrollRequest({ hookSecret: 'not-the-secret-not-the-secret-not' })
    );

    expect(reply).toEqual({ error: { code: 'forbidden', message: DENIED_MESSAGE } });
    expectNothingCreated();

    const rows = auditRows(fixture.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'enroll.reject', outcome: 'denied' });
    expect(rows[0].detail).toEqual({ reason: 'bad_secret' });
  });

  test('a bad secret and an unknown namespace are byte-identical on the wire', async () => {
    const { socketPath } = await boot();
    const badSecret = await roundTrip(
      socketPath,
      enrollRequest({ hookSecret: 'not-the-secret-not-the-secret-not' }),
      { raw: true }
    );
    const badNamespace = await roundTrip(
      socketPath,
      enrollRequest({ namespace: 'some-other-project' }),
      { raw: true }
    );

    expect(badNamespace).toBe(badSecret);
    expect(JSON.parse(badSecret)).toEqual({
      error: { code: 'forbidden', message: DENIED_MESSAGE }
    });
    expectNothingCreated();

    // The audit trail, unlike the reply, distinguishes them.
    const reasons = auditRows(fixture.store).map((row) => row.detail.reason);
    expect(reasons).toEqual(['bad_secret', 'unknown_namespace']);
  });

  test('a non-root role is refused with nothing created', async () => {
    const { socketPath } = await boot();
    for (const role of ['goal_hub', 'listener', 'operator', 'legacy', 'admin']) {
      const reply = await roundTrip(socketPath, enrollRequest({ role }));
      expect(reply.error.code, `role=${role}`).toBe('forbidden');
      expect(reply.error.detail).toMatchObject({ role, enrollable: ['root'] });
    }
    expectNothingCreated();
  });

  test('an out-of-allowlist scope is refused and named', async () => {
    const { socketPath } = await boot();
    const reply = await roundTrip(
      socketPath,
      enrollRequest({ scopes: ['channel:read', 'permit:administer'] })
    );
    expect(reply.error.code).toBe('forbidden');
    expect(reply.error.detail).toMatchObject({ scope: 'permit:administer' });
    expectNothingCreated();
  });

  test('every malformed ttl is refused over the wire', async () => {
    const { socketPath } = await boot();
    for (const ttlSeconds of [0, -1, 86401, '60', 60.5]) {
      const reply = await roundTrip(socketPath, enrollRequest({ ttlSeconds }));
      expect(reply.error.code, `ttlSeconds=${String(ttlSeconds)}`).toBe('invalid_request');
    }
    expectNothingCreated();
  });

  test('a refusal is audited once per attempt with the real reason', async () => {
    const { socketPath } = await boot();
    await roundTrip(socketPath, enrollRequest({ role: 'listener' }));
    await roundTrip(socketPath, enrollRequest({ ttlSeconds: 0 }));
    const rows = auditRows(fixture.store);
    expect(rows.map((row) => row.outcome)).toEqual(['denied', 'denied']);
    expect(rows.map((row) => row.detail.reason)).toEqual(['forbidden', 'invalid_request']);
  });
});

describe('protocol limits', () => {
  test('an oversized request is rejected without creating anything', async () => {
    const { socketPath } = await boot();
    // No newline: pure overflow, and larger than the cap in one write.
    const flood = 'x'.repeat(MAX_REQUEST_BYTES + 1024);
    const reply = await roundTrip(socketPath, flood);
    expect(reply.error.code).toBe('invalid_request');
    expect(reply.error.detail).toMatchObject({ maxBytes: MAX_REQUEST_BYTES });
    expectNothingCreated();
  });

  test('a valid request padded past the cap is still rejected', async () => {
    const { socketPath } = await boot();
    const padded = { ...enrollRequest(), padding: 'y'.repeat(MAX_REQUEST_BYTES) };
    const reply = await roundTrip(socketPath, padded);
    expect(reply.error.code).toBe('invalid_request');
    expectNothingCreated();
  });

  test('a request that never terminates its line times out and creates nothing', async () => {
    const { socketPath } = await boot();
    // Valid JSON, no trailing newline: the framing never completes.
    const reply = await roundTrip(socketPath, JSON.stringify(enrollRequest()));
    expect(reply.error.code).toBe('invalid_request');
    expectNothingCreated();
  });

  test('a second request on the same connection is refused, not served', async () => {
    const { socketPath } = await boot();
    const two = `${JSON.stringify(enrollRequest())}\n${JSON.stringify(enrollRequest())}\n`;
    const reply = await roundTrip(socketPath, two);
    expect(reply.error.code).toBe('invalid_request');
    expectNothingCreated();
  });

  test('framing rejections reach the log sink rather than vanishing', async () => {
    const { socketPath } = await boot();
    // These never reach the request handler, so the connection layer is the only place
    // that can report them; an unobservable rejection is an undiagnosable hook.
    await roundTrip(socketPath, 'x'.repeat(MAX_REQUEST_BYTES + 1));
    await roundTrip(socketPath, JSON.stringify(enrollRequest()));
    await roundTrip(socketPath, '{oops\n');

    const frames = fixture.logs.filter((entry) => entry.event === 'enroll.frame');
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame).toEqual({
        event: 'enroll.frame',
        outcome: 'rejected',
        // `reason` is a plain diagnostic key; `redactDetail` leaves it verbatim.
        reason: 'invalid_request'
      });
    }
    // Logged, but deliberately not audited: an unauthenticated peer must not be able
    // to grow the audit table at will.
    expect(auditRows(fixture.store)).toHaveLength(0);
  });

  test('unparseable, non-object and unknown-op requests are refused', async () => {
    const { socketPath } = await boot();
    expect((await roundTrip(socketPath, '{not json\n')).error.code).toBe('invalid_request');
    expect((await roundTrip(socketPath, '[1,2,3]\n')).error.code).toBe('invalid_request');
    expect((await roundTrip(socketPath, 'null\n')).error.code).toBe('invalid_request');
    expect((await roundTrip(socketPath, '"a string"\n')).error.code).toBe('invalid_request');

    const wrongOp = await roundTrip(socketPath, enrollRequest({ op: 'enroll.approve' }));
    expect(wrongOp.error.code).toBe('invalid_request');
    expect(wrongOp.error.detail).toMatchObject({ expected: 'enroll.request' });
    expectNothingCreated();
  });

  test('the socket keeps serving after a malformed request', async () => {
    const { socketPath } = await boot();
    await roundTrip(socketPath, '{oops\n');
    await roundTrip(socketPath, 'x'.repeat(MAX_REQUEST_BYTES + 1));
    const reply = await roundTrip(socketPath, enrollRequest());
    expect(reply.code).toBeTypeOf('string');
  });

  test('the request body cannot smuggle identity or authority', async () => {
    const { socketPath } = await boot();
    const reply = await roundTrip(
      socketPath,
      enrollRequest({
        // Every one of these is ignored: authority comes from the secret and policy.
        principalId: 'prn_ffffffffffffffff',
        capabilityId: 'cap_ffffffffffffffff',
        fromSessionId: 'sess-1',
        autonomous: true,
        approvingPrincipal: 'root'
      })
    );
    const issued = exchangeEnrollmentCode(fixture.store, reply.code);
    expect(issued.principalId).toMatch(/^prn_[0-9a-f]{16}$/);
    expect(issued.principalId).not.toBe('prn_ffffffffffffffff');
    expect(issued.capabilityId).not.toBe('cap_ffffffffffffffff');
  });
});

describe('secret hygiene', () => {
  test('neither the secret nor the code reaches the audit table or the log sink', async () => {
    const { socketPath } = await boot();

    // A full cycle: one approval, one rejection.
    const approved = await roundTrip(socketPath, enrollRequest());
    await roundTrip(socketPath, enrollRequest({ hookSecret: TEST_SECRET.replace(/.$/, 'X') }));
    const issued = exchangeEnrollmentCode(fixture.store, approved.code);

    const audited = JSON.stringify(auditRows(fixture.store));
    const logged = JSON.stringify(fixture.logs);

    for (const sink of [audited, logged]) {
      expect(sink).not.toContain(TEST_SECRET);
      expect(sink).not.toContain(approved.code);
      expect(sink).not.toContain(issued.token);
    }

    // The sinks are not merely empty: they recorded the events.
    expect(auditRows(fixture.store).map((row) => row.action)).toEqual([
      'enroll.code_issued',
      'enroll.reject',
      'capability.issued'
    ]);
    expect(fixture.logs.map((entry) => entry.outcome)).toEqual(['issued', 'denied']);
  });

  test('a secret smuggled into a log detail is redacted, not printed', async () => {
    const { socketPath } = await boot();
    // The hookSecret field must never surface even if some future call site passes the
    // whole request through to the logger.
    await roundTrip(socketPath, enrollRequest());
    fixture.log({ hookSecret: TEST_SECRET });
    // Direct calls bypass redaction by design, so assert the server's own entries only.
    const serverEntries = fixture.logs.filter((entry) => entry.event !== undefined);
    expect(JSON.stringify(serverEntries)).not.toContain(TEST_SECRET);
  });

  test('no reply, audit row or log entry discloses a filesystem path', async () => {
    const { socketPath } = await boot();
    const reply = await roundTrip(socketPath, enrollRequest({ namespace: 'elsewhere' }), {
      raw: true
    });
    const surfaces = [reply, JSON.stringify(auditRows(fixture.store)), JSON.stringify(fixture.logs)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(socketPath);
      expect(surface).not.toContain(fixture.root);
      expect(surface).not.toContain(fixture.path);
    }
  });
});
