// server.js owns composition, not behaviour: which middleware runs, in what order, and how a
// thrown value becomes a response. The authorization semantics themselves live in
// test/daemon/auth.test.js and the route semantics in test/daemon/routes/**.
//
// This file replaces the v0.2 version, whose central assertion was that `GET /health` returns the
// project's `wtDir` — i.e. it asserted the information disclosure this release removes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import request from 'supertest';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { ERROR_CODES, WalkieError } from '../../src/identity/errors.js';
import { SCHEMA_VERSION, openStore } from '../../src/store/db.js';
import { createPrincipal } from '../../src/store/principals.js';
import { issueCapability } from '../../src/store/capabilities.js';
import { createEvents } from '../../src/daemon/events.js';
import { STATUS_BY_CODE, createServer, renderError, statusForCode } from '../../src/daemon/server.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

const NAMESPACE = 'walkie-talkie';

let base;
let store;

function config(transport = {}) {
  return {
    ...DEFAULT_CONFIG,
    namespace: NAMESPACE,
    transport: { ...DEFAULT_CONFIG.transport, ...transport }
  };
}

function bearer() {
  const principal = createPrincipal(store, { role: 'goal_hub' });
  const { token } = issueCapability(store, {
    principalId: principal.id,
    scopes: ['channel:read'],
    ttlSeconds: 600,
    attestationKind: 'omp_hook_confirm',
    attestationRef: 'test'
  });
  return `Bearer ${token}`;
}

/** Records whether the composition had attached an identity by the time a route ran. */
function tracer(trail) {
  const router = Router();
  router.get('/trace', (req, res) => {
    trail.push(req.walkie ? 'authenticated' : 'unauthenticated');
    res.json({ trail });
  });
  return router;
}

beforeEach(() => {
  base = createFixtureDir('wk-srv-');
  store = openStore({ path: join(base, 'store', 'walkie.db'), namespace: NAMESPACE });
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe('composition', () => {
  it('mounts publicRouters before authentication and routers after it', async () => {
    const publicTrail = [];
    const authedTrail = [];
    const publicRouter = Router();
    publicRouter.get('/public', (req, res) => {
      publicTrail.push(req.walkie === undefined ? 'no-identity' : 'identity');
      res.json({ ok: true });
    });

    const { app } = createServer({
      store,
      config: config(),
      namespace: NAMESPACE,
      publicRouters: [publicRouter],
      routers: [tracer(authedTrail)]
    });

    expect((await request(app).get('/public')).status).toBe(200);
    expect(publicTrail).toEqual(['no-identity']);

    expect((await request(app).get('/trace')).status).toBe(401);
    expect(authedTrail).toEqual([]);

    expect((await request(app).get('/trace').set('Authorization', bearer())).status).toBe(200);
    expect(authedTrail).toEqual(['authenticated']);
  });

  it('mounts routers in the order given', async () => {
    const first = Router();
    first.get('/both', (_req, res) => res.json({ who: 'first' }));
    const second = Router();
    second.get('/both', (_req, res) => res.json({ who: 'second' }));

    const { app } = createServer({
      store,
      config: config(),
      namespace: NAMESPACE,
      routers: [first, second]
    });
    const res = await request(app).get('/both').set('Authorization', bearer());
    expect(res.body).toEqual({ who: 'first' });
  });

  it('uses the injected emitter and exposes it on app.locals', () => {
    const events = createEvents();
    const built = createServer({ store, config: config(), namespace: NAMESPACE, events });
    expect(built.events).toBe(events);
    expect(built.app.locals.events).toBe(events);
  });

  it('mints one emitter when none is injected and returns that same instance', () => {
    const built = createServer({ store, config: config(), namespace: NAMESPACE });
    expect(built.events).toBeDefined();
    expect(built.app.locals.events).toBe(built.events);
  });

  it('exposes the store, config and namespace on app.locals for route factories', () => {
    const cfg = config();
    const { app } = createServer({ store, config: cfg, namespace: NAMESPACE });
    expect(app.locals.store).toBe(store);
    expect(app.locals.config).toBe(cfg);
    expect(app.locals.namespace).toBe(NAMESPACE);
  });

  it('does not advertise the server implementation', async () => {
    const { app } = createServer({ store, config: config(), namespace: NAMESPACE });
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('GET /health', () => {
  it('needs no capability and names the namespace, mode and schema only', async () => {
    const { app } = createServer({ store, config: config(), namespace: NAMESPACE });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      namespace: NAMESPACE,
      mode: DEFAULT_CONFIG.mode,
      // Assert the exported constant, never a literal. This line pinned '3' and
      // went red the moment the store schema was bumped to '4' for the
      // case-insensitive alias index — a drift failure that says nothing about
      // /health. What matters here is that /health reports THE schema version,
      // not which number that happens to be.
      schemaVersion: SCHEMA_VERSION
    });
    // The v0.2 regression: no project path, no socket path, no store path.
    expect(JSON.stringify(res.body)).not.toContain(base);
  });
});

describe('unmatched routes', () => {
  it('answer 404 with the shared envelope rather than express HTML', async () => {
    const { app } = createServer({ store, config: config(), namespace: NAMESPACE });
    const res = await request(app).get('/nope').set('Authorization', bearer());
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'no such route' } });
  });

  it('still require a capability, so route existence is not an oracle', async () => {
    const { app } = createServer({ store, config: config(), namespace: NAMESPACE });
    expect((await request(app).get('/nope')).status).toBe(401);
  });
});

describe('json body limit', () => {
  it('comes from config rather than a hard-coded literal', async () => {
    const router = Router();
    router.post('/echo', (req, res) => res.json({ size: JSON.stringify(req.body).length }));

    const tight = createServer({
      store,
      config: config({ maxBodyBytes: 1024 }),
      namespace: NAMESPACE,
      routers: [router]
    }).app;
    const roomy = createServer({
      store,
      config: config({ maxBodyBytes: 65536 }),
      namespace: NAMESPACE,
      routers: [router]
    }).app;

    const payload = { body: 'x'.repeat(8192) };
    const auth = bearer();
    expect(
      (await request(tight).post('/echo').set('Authorization', auth).send(payload)).status
    ).toBe(413);
    expect(
      (await request(roomy).post('/echo').set('Authorization', auth).send(payload)).status
    ).toBe(200);
  });

  it('renders unparseable JSON as invalid_request, not internal', async () => {
    const { app } = createServer({ store, config: config(), namespace: NAMESPACE });
    const res = await request(app)
      .post('/anything')
      .set('Authorization', bearer())
      .set('Content-Type', 'application/json')
      .send('{"body": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('terminal error handler', () => {
  it('gives every code in the shared vocabulary an explicit status', () => {
    for (const code of ERROR_CODES) {
      expect(STATUS_BY_CODE, code).toHaveProperty(code);
      expect(statusForCode(code), code).toBe(STATUS_BY_CODE[code]);
    }
    expect(Object.keys(STATUS_BY_CODE).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('renders a WalkieError thrown from a route with its own code and detail', async () => {
    const router = Router();
    router.get('/boom', () => {
      throw new WalkieError('conflict', 'already exists', { id: 'abc' });
    });
    const { app } = createServer({
      store,
      config: config(),
      namespace: NAMESPACE,
      routers: [router]
    });
    const res = await request(app).get('/boom').set('Authorization', bearer());
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: 'conflict', message: 'already exists', detail: { id: 'abc' } }
    });
  });

  // The whole point of adding `busy` was that a caller can tell "your write lost a race,
  // repeat it" apart from "your write contradicts current state, re-read first". If both
  // arrive as the same status with no timing hint, that distinction is untested prose.
  it('distinguishes a shed write from a state conflict, and says when to retry', async () => {
    const router = Router();
    router.get('/busy', () => {
      throw new WalkieError('busy', 'another process is writing the channel');
    });
    router.get('/conflict', () => {
      throw new WalkieError('conflict', 'already exists');
    });
    const { app } = createServer({
      store,
      config: config(),
      namespace: NAMESPACE,
      routers: [router]
    });
    const auth = bearer();

    const busy = await request(app).get('/busy').set('Authorization', auth);
    expect(busy.status).toBe(503);
    expect(busy.body.error.code).toBe('busy');
    // Retryable AND time-bounded: an agent should not have to invent a backoff.
    expect(busy.headers['retry-after']).toBe('1');

    const conflict = await request(app).get('/conflict').set('Authorization', auth);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('conflict');
    // A conflict needs a re-read, not a repeat, so advertising a delay would be wrong.
    expect(conflict.headers['retry-after']).toBeUndefined();

    expect(busy.status).not.toBe(conflict.status);
  });

  // `unavailable` and `busy` deliberately share 503 so a status-only client retries for
  // both; the JSON code is what separates "nothing is listening" from "the writer is busy".
  it('shares 503 between unavailable and busy without merging their codes', async () => {
    expect(statusForCode('busy')).toBe(503);
    expect(statusForCode('unavailable')).toBe(503);
    expect(renderError(new WalkieError('busy', 'shed')).body.error.code).toBe('busy');
    expect(renderError(new WalkieError('unavailable', 'gone')).body.error.code).toBe(
      'unavailable'
    );
  });

  it('renders a rejected async handler, not just a synchronous throw', async () => {
    const router = Router();
    router.get('/boom', (_req, _res, next) => {
      Promise.reject(new WalkieError('not_found', 'gone')).catch(next);
    });
    const { app } = createServer({
      store,
      config: config(),
      namespace: NAMESPACE,
      routers: [router]
    });
    const res = await request(app).get('/boom').set('Authorization', bearer());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('never appends an error envelope to a response that already started', async () => {
    const router = Router();
    router.get('/stream', (_req, res, next) => {
      res.write('partial');
      next(new WalkieError('internal', 'too late'));
    });
    const { app } = createServer({
      store,
      config: config(),
      namespace: NAMESPACE,
      routers: [router]
    });

    // Express's own final handler destroys the socket once headers are out, so the client sees an
    // abort. What matters is that nothing was written after 'partial': appending a JSON envelope
    // to a half-sent body would corrupt the stream for a well-behaved client.
    const { received, status } = await readRawResponse(app, '/stream', bearer());
    expect(status).toBe(200);
    expect(received).toContain('partial');
    expect(received).not.toContain('"error"');
    expect(received).not.toContain('too late');
  });
});

/**
 * Issues one request against a real loopback listener and returns whatever bytes arrived, even if
 * the server aborted the connection midway. supertest surfaces the abort as an error and discards
 * the partial body, which is exactly the thing under test here.
 */
async function readRawResponse(app, path, authorization) {
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'GET', headers: { authorization } },
        (res) => {
          let received = '';
          res.on('data', (chunk) => {
            received += chunk.toString('utf8');
          });
          const done = () => resolve({ received, status: res.statusCode });
          res.on('end', done);
          res.on('aborted', done);
          res.on('error', done);
        }
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// `/health` and the authority socket.
//
// `daemon-entry` already refuses to finish booting without an authority, on the stated grounds
// that a service with an HTTP listener and no enrollment socket would answer `/health`, look
// healthy to `walkie status`, and be permanently incapable of issuing a first capability. That
// rule held for the first instant of the process only: an authority whose listener went down
// afterwards left exactly the state the boot ordering exists to prevent, and `/health` kept
// saying `ok`.
describe('GET /health with an authority', () => {
  it('reports ok while the authority socket is serving', async () => {
    const { app } = createServer({
      store,
      config: config(),
      namespace: NAMESPACE,
      authorityStatus: () => ({ serving: true })
    });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      namespace: NAMESPACE,
      mode: DEFAULT_CONFIG.mode,
      schemaVersion: SCHEMA_VERSION
    });
  });

  it('reports 503 and names the authority once its socket stops serving', async () => {
    // One mutable status, read per request, because that is how the real composition root wires
    // it: the authority does not exist yet when the app is built.
    let serving = true;
    const { app } = createServer({
      store,
      config: config(),
      namespace: NAMESPACE,
      authorityStatus: () => ({ serving })
    });

    expect((await request(app).get('/health')).status).toBe(200);

    serving = false;
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      ok: false,
      namespace: NAMESPACE,
      mode: DEFAULT_CONFIG.mode,
      schemaVersion: SCHEMA_VERSION,
      authority: 'faulted'
    });
    // Still no filesystem disclosure on the degraded path — the v0.2 regression this route
    // exists to avoid does not get a second door.
    expect(JSON.stringify(res.body)).not.toContain(base);
  });

  it('is unchanged for an app composed without an authority', async () => {
    // Every route test builds an app with no authority at all. Absent `authorityStatus` must mean
    // "not this route's business", never "faulted".
    const { app } = createServer({ store, config: config(), namespace: NAMESPACE });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.authority).toBeUndefined();
  });
});
