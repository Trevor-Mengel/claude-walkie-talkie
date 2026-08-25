import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import request from 'supertest';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { openStore } from '../../src/store/db.js';
import { createPrincipal } from '../../src/store/principals.js';
import { issueCapability, revokeCapability } from '../../src/store/capabilities.js';
import { listAudit } from '../../src/store/audit.js';
import {
  AUTH_REJECT_ACTION,
  LEGACY_AUTHORITY_FIELDS,
  parseBearer,
  rejectLegacyAuthorityFields,
  requireCapability,
  requireScope,
  SCOPE_REJECT_ACTION
} from '../../src/daemon/auth.js';
import { createServer, hostnameFromHeader, renderError } from '../../src/daemon/server.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

const NAMESPACE = 'walkie-talkie';
const OTHER_NAMESPACE = 'other-project';

let base;
let store;

function config(overrides = {}) {
  return { ...DEFAULT_CONFIG, namespace: NAMESPACE, ...overrides };
}

/** A router exercising every middleware the boundary exposes. */
function probeRoutes() {
  const router = Router();
  router.get('/probe/identity', (req, res) => {
    res.json({
      principalId: req.walkie.principal.id,
      role: req.walkie.principal.role,
      alias: req.walkie.principal.displayAlias,
      namespace: req.walkie.namespace,
      capabilityId: req.walkie.capability.id,
      scopes: req.walkie.capability.scopes
    });
  });
  router.get('/probe/read', requireScope('channel:read'), (_req, res) => res.json({ ok: true }));
  router.post('/probe/publish', requireScope('channel:publish'), (_req, res) =>
    res.json({ ok: true })
  );
  router.get('/probe/boom', () => {
    throw new Error('secret /path/to/cred');
  });
  return router;
}

function publicProbeRoutes() {
  const router = Router();
  router.post('/probe/public', (_req, res) => res.status(201).json({ ok: true }));
  return router;
}

function makeApp({ namespace = NAMESPACE, ...rest } = {}) {
  return createServer({
    store,
    config: config(),
    namespace,
    publicRouters: [publicProbeRoutes()],
    routers: [probeRoutes()],
    ...rest
  }).app;
}

/** @returns {{principal:object, token:string, capabilityId:string}} */
function mint({
  role = 'goal_hub',
  alias,
  scopes = ['channel:read'],
  ttlSeconds = 3600,
  parentCapabilityId,
  target = store
} = {}) {
  const principal = createPrincipal(target, { role, displayAlias: alias });
  const { capabilityId, token } = issueCapability(target, {
    principalId: principal.id,
    scopes,
    ttlSeconds,
    attestationKind: parentCapabilityId ? 'delegation' : 'omp_hook_confirm',
    attestationRef: 'test-attestation',
    parentCapabilityId
  });
  return { principal, token, capabilityId };
}

/** Backdates a capability's expiry without going through the store API. */
function expire(capabilityId) {
  store.db
    .prepare('UPDATE capability SET expires_at = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', capabilityId);
}

function rejections() {
  return listAudit(store, { action: AUTH_REJECT_ACTION, limit: 100 });
}

beforeEach(() => {
  base = createFixtureDir('wk-auth-');
  store = openStore({ path: join(base, 'store', 'walkie.db'), namespace: NAMESPACE });
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe('parseBearer', () => {
  it('accepts a well-formed header with a case-insensitive scheme', () => {
    expect(parseBearer('Bearer abc123')).toBe('abc123');
    expect(parseBearer('bearer abc123')).toBe('abc123');
    expect(parseBearer('BEARER abc123')).toBe('abc123');
    expect(parseBearer('  Bearer   abc123  ')).toBe('abc123');
  });

  it('rejects everything else rather than guessing', () => {
    for (const value of [
      undefined,
      null,
      42,
      '',
      '   ',
      'Bearer',
      'Bearer ',
      'abc123',
      'Basic abc123',
      'Bearer abc 123',
      'Bearer abc123 extra',
      'Token abc123'
    ]) {
      expect(parseBearer(value), `expected null for ${JSON.stringify(value)}`).toBeNull();
    }
  });
});

describe('requireCapability', () => {
  it('populates req.walkie for a live capability', async () => {
    const { principal, token, capabilityId } = mint({
      alias: 'Main',
      scopes: ['channel:read', 'channel:publish']
    });
    const res = await request(makeApp())
      .get('/probe/identity')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      principalId: principal.id,
      role: 'goal_hub',
      alias: 'Main',
      namespace: NAMESPACE,
      capabilityId,
      scopes: ['channel:publish', 'channel:read']
    });
  });

  it('401s with no Authorization header', async () => {
    const res = await request(makeApp()).get('/probe/identity');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('401s for Bearer with an empty token', async () => {
    const res = await request(makeApp()).get('/probe/identity').set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('401s for a malformed scheme', async () => {
    for (const header of ['Basic abcdef', 'abcdef', 'Bearer a b']) {
      const res = await request(makeApp()).get('/probe/identity').set('Authorization', header);
      expect(res.status, header).toBe(401);
    }
  });

  it('401s for an unknown token', async () => {
    const res = await request(makeApp())
      .get('/probe/identity')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('401s for an expired capability', async () => {
    const { token, capabilityId } = mint();
    expire(capabilityId);
    const res = await request(makeApp())
      .get('/probe/identity')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('401s for a revoked capability', async () => {
    const { token, capabilityId } = mint();
    revokeCapability(store, capabilityId, 'test');
    const res = await request(makeApp())
      .get('/probe/identity')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('401s for a live capability whose ANCESTOR was revoked', async () => {
    const parent = mint({ role: 'root', scopes: ['channel:read', 'enroll:delegate'] });
    const child = createPrincipal(store, { role: 'listener', displayAlias: 'child' });
    const derived = issueCapability(store, {
      principalId: child.id,
      scopes: ['channel:read'],
      ttlSeconds: 600,
      attestationKind: 'delegation',
      attestationRef: parent.capabilityId,
      parentCapabilityId: parent.capabilityId
    });

    // Sanity: the derived capability works before the ancestor is cut.
    const before = await request(makeApp())
      .get('/probe/identity')
      .set('Authorization', `Bearer ${derived.token}`);
    expect(before.status).toBe(200);

    revokeCapability(store, parent.capabilityId, 'ancestor revoked');

    const after = await request(makeApp())
      .get('/probe/identity')
      .set('Authorization', `Bearer ${derived.token}`);
    expect(after.status).toBe(401);
  });

  it('401s for a capability whose principal was revoked', async () => {
    const { principal, token } = mint();
    store.db
      .prepare('UPDATE principal SET revoked_at = ? WHERE id = ?')
      .run('2024-01-01T00:00:00.000Z', principal.id);
    const res = await request(makeApp())
      .get('/probe/identity')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('403 wrong_namespace for a capability minted for another namespace', async () => {
    const { token } = mint();
    // Same store, but this socket claims to serve a different namespace.
    const res = await request(makeApp({ namespace: OTHER_NAMESPACE }))
      .get('/probe/identity')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('wrong_namespace');
    expect(res.body.error.detail).toEqual({ expected: OTHER_NAMESPACE });
  });

  it('never echoes the token or a filesystem path in a rejection', async () => {
    const { token } = mint();
    const revoked = mint();
    revokeCapability(store, revoked.capabilityId, 'test');

    const responses = await Promise.all([
      request(makeApp()).get('/probe/identity'),
      request(makeApp()).get('/probe/identity').set('Authorization', 'Bearer '),
      request(makeApp()).get('/probe/identity').set('Authorization', `Bearer ${revoked.token}`),
      request(makeApp({ namespace: OTHER_NAMESPACE }))
        .get('/probe/identity')
        .set('Authorization', `Bearer ${token}`)
    ]);

    for (const res of responses) {
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(token);
      expect(text).not.toContain(revoked.token);
      expect(text).not.toContain(base);
      expect(text).not.toContain(store.path);
      expect(text).not.toMatch(/\/(?:private\/)?(?:var|tmp|Users|home)\//);
      expect(text).not.toMatch(/walkie\.db/);
    }
  });

  it('audits every failure as denied and never audits a success', async () => {
    const { token } = mint();
    const app = makeApp();

    await request(app).get('/probe/identity');
    await request(app).get('/probe/identity').set('Authorization', 'Bearer nope');
    const ok = await request(app).get('/probe/identity').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);

    const rows = rejections();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.action).toBe(AUTH_REJECT_ACTION);
      expect(row.outcome).toBe('denied');
      expect(row.detail.method).toBe('GET');
      expect(JSON.stringify(row.detail)).not.toContain(token);
    }
    expect(rows.map((r) => r.detail.reason).sort()).toEqual([
      'bearer.missing_or_malformed',
      'capability.unknown_or_inactive'
    ]);
  });

  it('records the reason but no token for a namespace mismatch', async () => {
    const { token, principal, capabilityId } = mint();
    await request(makeApp({ namespace: OTHER_NAMESPACE }))
      .get('/probe/identity')
      .set('Authorization', `Bearer ${token}`);

    const [row] = rejections();
    expect(row.detail).toEqual({
      reason: 'capability.namespace_mismatch',
      method: 'GET',
      principalId: principal.id,
      capabilityId
    });
    expect(JSON.stringify(row.detail)).not.toContain(token);
  });

  it('refuses to build a gate without a store or a namespace', () => {
    expect(() => requireCapability(null, NAMESPACE)).toThrowError(/store/);
    expect(() => requireCapability(store, '')).toThrowError(/namespace/);
  });
});

describe('requireScope', () => {
  it('allows a request holding the scope', async () => {
    const { token } = mint({ scopes: ['channel:read'] });
    const res = await request(makeApp()).get('/probe/read').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('403s scope_required and names the scope in detail', async () => {
    const { token } = mint({ scopes: ['channel:read'] });
    const res = await request(makeApp())
      .post('/probe/publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hi' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('scope_required');
    expect(res.body.error.detail).toEqual({ scope: 'channel:publish' });
  });

  it('refuses to build a gate for a scope that does not exist', () => {
    expect(() => requireScope('channel:destroy')).toThrowError(/unknown scope/);
  });

  it('401s rather than 403s when it runs without authentication', async () => {
    const gate = requireScope('channel:read');
    let captured;
    gate({}, {}, (err) => {
      captured = err;
    });
    expect(captured.code).toBe('unauthenticated');
  });

  // E2d. Authentication failures audited from the first cutover commit; the
  // authorization failure right next to them recorded nothing. Guarantee 12 says
  // every authority decision writes a row, and "you are who you say but you may
  // not do that" is an authority decision — the one a probe walking the route
  // table for an over-granted scope generates, repeatedly, invisibly.
  it('records the denial, naming the scope and the mounted route', async () => {
    const { principal, token, capabilityId } = mint({ scopes: ['channel:read'] });
    const res = await request(makeApp())
      .post('/probe/publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hi' });
    expect(res.status).toBe(403);

    // Read out of SQLite, not out of the response.
    const rows = store.db
      .prepare(
        'SELECT actor_principal_id, subject, outcome, detail FROM audit ' +
          'WHERE namespace = ? AND action = ?'
      )
      .all(NAMESPACE, SCOPE_REJECT_ACTION);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('denied');
    expect(rows[0].actor_principal_id).toBe(principal.id);
    expect(rows[0].subject).toBe(capabilityId);
    expect(JSON.parse(rows[0].detail)).toEqual({
      scope: 'channel:publish',
      method: 'POST',
      route: '/probe/publish'
    });
    // The token is the one thing that must never be durable.
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it('records nothing when the scope is held', async () => {
    const { token } = mint({ scopes: ['channel:read'] });
    await request(makeApp()).get('/probe/read').set('Authorization', `Bearer ${token}`);
    expect(listAudit(store, { action: SCOPE_REJECT_ACTION })).toEqual([]);
  });

  it('records the route pattern, never the caller-supplied path', async () => {
    // `auditReject` refuses to record `req.path` because a caller can put a token
    // in a path segment and an audit row is durable. The same rule holds here, and
    // `req.route.path` is the router's own pattern rather than caller bytes.
    const { token } = mint({ scopes: ['channel:publish'] });
    const secret = 'Bearer-shaped-secret-in-a-path-segment';
    const res = await request(makeApp())
      .get(`/probe/read?leak=${secret}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);

    const rows = listAudit(store, { action: SCOPE_REJECT_ACTION });
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toEqual({ scope: 'channel:read', method: 'GET', route: '/probe/read' });
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('still refuses when it has no app behind it to audit through', () => {
    // The unit-invoked gate has no `req.app`, so it cannot write a row. It must
    // still say no: a missing audit destination is not a reason to allow.
    const gate = requireScope('channel:publish');
    let captured;
    gate(
      { method: 'POST', walkie: { principal: { id: 'prn_x' }, capability: { id: 'cap_x', scopes: ['channel:read'] } } },
      {},
      (err) => {
        captured = err;
      }
    );
    expect(captured.code).toBe('scope_required');
  });
});

describe('rejectLegacyAuthorityFields', () => {
  it('400s each banned key individually, before authentication', async () => {
    expect(LEGACY_AUTHORITY_FIELDS).toEqual([
      'fromSessionId',
      'fromAlias',
      'fromTool',
      'autonomous',
      'editedBy',
      'archivedBy',
      'sessionId',
      'invitedBy',
      'operator'
    ]);

    const { token } = mint({ scopes: ['channel:read', 'channel:publish'] });
    for (const field of LEGACY_AUTHORITY_FIELDS) {
      const res = await request(makeApp())
        .post('/probe/publish')
        .set('Authorization', `Bearer ${token}`)
        .send({ body: 'hi', [field]: 'forged' });

      expect(res.status, field).toBe(400);
      expect(res.body.error.code, field).toBe('invalid_request');
      expect(res.body.error.detail, field).toEqual({ field });
    }
  });

  it('rejects a forged field even with no credential at all', async () => {
    const res = await request(makeApp()).post('/probe/publish').send({ fromAlias: 'operator' });
    expect(res.status).toBe(400);
    expect(res.body.error.detail).toEqual({ field: 'fromAlias' });
  });

  it('lets a clean body through', async () => {
    const { token } = mint({ scopes: ['channel:publish'] });
    const res = await request(makeApp())
      .post('/probe/publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hi', type: 'broadcast', replyTo: null });
    expect(res.status).toBe(200);
  });

  it('ignores a non-object body', () => {
    const gate = rejectLegacyAuthorityFields();
    for (const body of [undefined, null, 'string', 42, ['sessionId']]) {
      let err = 'not-called';
      gate({ body }, {}, (e) => {
        err = e;
      });
      expect(err).toBeUndefined();
    }
  });
});

describe('Host and Origin guard', () => {
  it('parses a Host header, including the bracketed IPv6 form', () => {
    expect(hostnameFromHeader('127.0.0.1')).toBe('127.0.0.1');
    expect(hostnameFromHeader('127.0.0.1:8080')).toBe('127.0.0.1');
    expect(hostnameFromHeader('LOCALHOST:99')).toBe('localhost');
    expect(hostnameFromHeader('[::1]')).toBe('::1');
    expect(hostnameFromHeader('[::1]:1234')).toBe('::1');
    expect(hostnameFromHeader('evil.com')).toBe('evil.com');
    // Malformed: unbracketed IPv6, an empty host, a non-numeric port, a bare bracket.
    expect(hostnameFromHeader('::1:1234')).toBeNull();
    expect(hostnameFromHeader(':8080')).toBeNull();
    expect(hostnameFromHeader('127.0.0.1:abc')).toBeNull();
    expect(hostnameFromHeader('[]:1')).toBeNull();
    expect(hostnameFromHeader('')).toBeNull();
    expect(hostnameFromHeader(undefined)).toBeNull();
  });

  it('403s a MISSING Host header', async () => {
    // supertest always sets Host, so the middleware is driven directly.
    const { rejectCrossOrigin } = await import('../../src/daemon/server.js');
    let status;
    let body;
    rejectCrossOrigin(
      { headers: {}, method: 'GET' },
      {
        status(code) {
          status = code;
          return this;
        },
        json(payload) {
          body = payload;
        }
      },
      () => {
        status = 'next';
      }
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('403s any Origin header, including the "null" origin', async () => {
    for (const origin of ['https://evil.example.com', 'null', 'http://localhost:3000', '']) {
      const res = await request(makeApp()).get('/health').set('Origin', origin);
      expect(res.status, origin).toBe(403);
      expect(res.body.error.code, origin).toBe('forbidden');
    }
  });

  it('403s a non-loopback Host', async () => {
    const res = await request(makeApp()).get('/health').set('Host', 'evil.com');
    expect(res.status).toBe(403);
  });

  it('allows the loopback hosts, bracketed IPv6 included', async () => {
    for (const host of ['127.0.0.1', '127.0.0.1:12345', 'localhost', '[::1]:1234', '[::1]']) {
      const res = await request(makeApp()).get('/health').set('Host', host);
      expect(res.status, host).toBe(200);
    }
  });
});

describe('GET /health', () => {
  it('answers without a capability and discloses no filesystem path', async () => {
    const res = await request(makeApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.namespace).toBe(NAMESPACE);
    expect(res.body.mode).toBe(DEFAULT_CONFIG.mode);
    expect(res.body.schemaVersion).toBeTruthy();
    expect(Object.keys(res.body).sort()).toEqual(['mode', 'namespace', 'ok', 'schemaVersion']);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(base);
    expect(text).not.toMatch(/walkie-talkie\//);
  });
});

describe('public routers', () => {
  it('mount before authentication', async () => {
    const res = await request(makeApp()).post('/probe/public').send({});
    expect(res.status).toBe(201);
  });
});

describe('terminal error handler', () => {
  it('collapses a non-WalkieError to a fixed internal envelope', async () => {
    const { token } = mint();
    const res = await request(makeApp()).get('/probe/boom').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'internal', message: 'internal error' } });
    expect(JSON.stringify(res.body)).not.toContain('/path/to/cred');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('renders an unmatched route as a 404 envelope, not HTML', async () => {
    const { token } = mint();
    const res = await request(makeApp())
      .get('/permits')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'no such route' } });
  });

  it('rejects a body over the configured limit', async () => {
    const { token } = mint({ scopes: ['channel:publish'] });
    const app = createServer({
      store,
      config: {
        ...config(),
        transport: { ...DEFAULT_CONFIG.transport, maxBodyBytes: 1024 }
      },
      namespace: NAMESPACE,
      routers: [probeRoutes()]
    }).app;

    const res = await request(app)
      .post('/probe/publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'x'.repeat(4096) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('renderError', () => {
  it('maps the shared error vocabulary onto HTTP', async () => {
    const { WalkieError } = await import('../../src/identity/errors.js');
    const cases = [
      ['unauthenticated', 401],
      ['forbidden', 403],
      ['not_owner', 403],
      ['wrong_namespace', 403],
      ['scope_required', 403],
      ['permit_required', 403],
      ['permit_invalid', 403],
      ['invalid_request', 400],
      ['not_found', 404],
      ['conflict', 409],
      ['stale_fence', 409],
      ['config_invalid', 500],
      ['namespace_unresolved', 500],
      ['internal', 500]
    ];
    for (const [code, status] of cases) {
      const rendered = renderError(new WalkieError(code, 'because'));
      expect(rendered.status, code).toBe(status);
      expect(rendered.body.error.code, code).toBe(code);
    }
  });

  it('keeps a StoreError code, message and detail', async () => {
    const { storeError } = await import('../../src/store/errors.js');
    const rendered = renderError(storeError('conflict', 'alias is taken', { alias: 'Main' }));
    expect(rendered.status).toBe(409);
    expect(rendered.body).toEqual({
      error: { code: 'conflict', message: 'alias is taken', detail: { alias: 'Main' } }
    });
  });

  it('drops the message of anything outside the vocabulary', () => {
    for (const err of [
      new Error('boom /Users/someone/.walkie-talkie/store/walkie.db'),
      new TypeError('undefined is not a function'),
      'a bare string',
      null,
      undefined
    ]) {
      expect(renderError(err)).toEqual({
        status: 500,
        body: { error: { code: 'internal', message: 'internal error' } }
      });
    }
  });
});

describe('createServer preconditions', () => {
  it('fails closed without a store', () => {
    expect(() => createServer({ config: config(), namespace: NAMESPACE })).toThrowError(
      /authority store/
    );
  });

  it('requires a config and a namespace', () => {
    expect(() => createServer({ store, namespace: NAMESPACE })).toThrowError(/config/);
    expect(() => createServer({ store, config: config(), namespace: '' })).toThrowError(
      /namespace/
    );
  });
});
