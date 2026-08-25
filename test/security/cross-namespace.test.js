// One process, two namespaces, and no authority crossing between them.
//
// A namespace is the identity of a project's channel. Every credential, event,
// cursor, permit and audit row carries it, each namespace gets its own store file
// (pinned in `schema_meta`, so one file can only ever belong to one namespace),
// its own `channel.md` and its own listening socket. The property under test is
// the one that makes that partitioning worth anything: a capability minted for
// namespace A must be inert against namespace B, even though both are reachable
// from the same machine by the same local user.
//
// v0.2 had nothing to test here. Identity was a session id in a JSON body and a
// permit was a file in the project directory, so "which project am I talking to"
// was decided entirely by which port the client happened to connect to — a client
// pointed at the wrong daemon was simply a client of that daemon.
//
// There are two distinct fences, and both are asserted below:
//
//   1. In the real topology — one store per namespace — a foreign token is not
//      in this store at all, so `verifyCapability` collapses it to null and the
//      answer is an opaque 401. That opacity is deliberate: a 403 that said
//      "wrong namespace" would confirm to a prober that the token it stole is
//      live *somewhere*, and would name the namespace it reached.
//   2. `requireCapability` additionally cross-checks the resolved capability's
//      namespace against the namespace the socket serves, and answers 403
//      `wrong_namespace`. In a correctly composed server that check is
//      unreachable (fence 1 fires first); it exists for the case where a server
//      is composed over a store belonging to a different namespace — a swapped
//      socket-to-store mapping — which is exactly how it is reached here.
//
// This is the cheap in-process variant: `createServer` compositions over real
// stores, driven with supertest. The process-level variant (two daemons, two
// sockets, two spawned clients) lives in the integration slice.

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { openStore } from '../../src/store/db.js';
import { createPrincipal } from '../../src/store/principals.js';
import { issueCapability, verifyCapability } from '../../src/store/capabilities.js';
import { validateConfig } from '../../src/config/schema.js';
import { createServer } from '../../src/daemon/server.js';
import { createEvents } from '../../src/daemon/events.js';
import { buildRouters } from '../../src/daemon/routes/index.js';
import { handleEnrollRequest } from '../../src/authority/enroll.js';
import { ROLE_SCOPES } from '../../src/authority/policy.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

const SCOPES = Object.freeze([
  'channel:read',
  'channel:publish',
  'channel:ack',
  'self:alias',
  'self:cursor'
]);

const roots = [];
const stores = [];

/**
 * A complete, independent daemon for one namespace.
 *
 * `serverNamespace` defaults to the store's namespace, which is the only correct
 * composition. Passing a different value builds the misconfigured server that
 * fence 2 above exists for.
 */
function boot(namespace, { serverNamespace = namespace } = {}) {
  const root = createFixtureDir('collabcast-xns-');
  roots.push(root);
  const wtDir = join(root, '.collabcast');
  mkdirSync(join(wtDir, '.sessions'), { recursive: true });
  const channelPath = join(wtDir, 'channel.md');
  writeFileSync(
    channelPath,
    [
      `# Collabcast Channel: ${namespace}`,
      '',
      '**Operator:** Cross Namespace Tests',
      '',
      '<!-- WALKIE:HEADER_END -->',
      '',
      '---',
      ''
    ].join('\n'),
    'utf8'
  );

  const store = openStore({ path: join(wtDir, 'store', 'collabcast.db'), namespace });
  stores.push(store);
  const config = validateConfig(
    { schemaVersion: 3, namespace, mode: 'standalone' },
    { canonicalRoot: root }
  );
  const events = createEvents();
  const deps = { store, config, namespace: serverNamespace, channelPath, events };
  const { publicRouters, routers } = buildRouters(deps);
  const { app } = createServer({
    store,
    config,
    namespace: serverNamespace,
    publicRouters,
    routers,
    events
  });

  return { namespace, serverNamespace, root, channelPath, store, config, app };
}

function mint(side, { role = 'goal_hub', alias = null } = {}) {
  const principal = createPrincipal(side.store, { role, displayAlias: alias, paseoAgentId: null });
  const { capabilityId, token } = issueCapability(side.store, {
    principalId: principal.id,
    scopes: [...SCOPES],
    ttlSeconds: 3600,
    attestationKind: 'operator_cli',
    attestationRef: `test:${principal.id}`
  });
  return { principal, capabilityId, token, bearer: `Bearer ${token}` };
}

function count(store, sql, ...params) {
  return store.db.prepare(sql).get(...params).n;
}

function lastRejection(store) {
  const row = store.db
    .prepare("SELECT detail FROM audit WHERE action = 'auth.reject' ORDER BY id DESC LIMIT 1")
    .get();
  return row ? JSON.parse(row.detail) : null;
}

let alpha;
let beta;
let alphaActor;
let betaActor;

beforeAll(() => {
  alpha = boot('alpha-project');
  beta = boot('beta-project');
  alphaActor = mint(alpha, { alias: 'alpha-agent' });
  betaActor = mint(beta, { alias: 'beta-agent' });
});

afterAll(() => {
  while (stores.length > 0) {
    try {
      stores.pop().close();
    } catch {
      // already closed
    }
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

/** Every authenticated route, with a payload where one is required. */
const ROUTES = Object.freeze([
  ['get', '/channel/latest', undefined],
  ['get', '/channel/since/01J7QXP9R5K8VYZAB3CDEFGHJK', undefined],
  ['post', '/channel/message', { body: 'from the other project' }],
  ['get', '/inbox', undefined],
  ['get', '/self', undefined],
  ['get', '/principals', undefined],
  ['post', '/self/alias', { alias: 'squatter' }],
  // Valid payloads, so a 401 can only come from authentication and never from a body
  // the route would have rejected anyway.
  ['post', '/cursor/read', { id: '01J7QXP9R5K8VYZAB3CDEFGHJK' }],
  ['post', '/cursor/ack', { id: '01J7QXP9R5K8VYZAB3CDEFGHJK' }],
  ['post', '/delegate', { role: 'goal_hub', scopes: ['channel:read'], ttlSeconds: 600 }]
]);

function send(app, [method, path, payload], bearer) {
  const req = request(app)[method](path).set('Authorization', bearer);
  return payload === undefined ? req : req.send(payload);
}

describe('security: a capability is inert outside its own namespace', () => {
  test('every authenticated route refuses the foreign token, opaquely', async () => {
    for (const route of ROUTES) {
      const res = await send(beta.app, route, alphaActor.bearer);
      const where = `${route[0]} ${route[1]}`;
      expect(res.status, where).toBe(401);
      expect(res.body.error.code, where).toBe('unauthenticated');
      // Indistinguishable from a token that never existed: no detail, and
      // nothing that names either namespace.
      expect(res.body.error.detail, where).toBeUndefined();
      const rendered = JSON.stringify(res.body);
      expect(rendered, where).not.toContain(alpha.namespace);
      expect(rendered, where).not.toContain(beta.namespace);
    }

    // A garbage token gets byte-identical treatment, which is the point.
    const garbage = await request(beta.app).get('/self').set('Authorization', 'Bearer nonsense');
    const foreign = await request(beta.app).get('/self').set('Authorization', alphaActor.bearer);
    expect(foreign.status).toBe(garbage.status);
    expect(foreign.body).toEqual(garbage.body);

    // Symmetric — not an artefact of which store was opened first.
    const back = await request(alpha.app).get('/self').set('Authorization', betaActor.bearer);
    expect(back.status).toBe(401);
    expect(back.body.error.code).toBe('unauthenticated');

    // Each side still works with its own credential.
    expect((await request(alpha.app).get('/self').set('Authorization', alphaActor.bearer)).status)
      .toBe(200);
    expect((await request(beta.app).get('/self').set('Authorization', betaActor.bearer)).status)
      .toBe(200);
  });

  test('a server composed over another namespace’s store answers 403 wrong_namespace', async () => {
    // Fence 2. The store belongs to `alpha-project`; the server believes it
    // serves `beta-project` — a socket wired to the wrong store. The capability
    // resolves (it is in this store) and is then refused on the namespace it
    // carries, rather than being honoured because it happened to verify.
    const crossed = boot('alpha-project', { serverNamespace: 'beta-project' });
    const actor = mint(crossed);

    for (const route of ROUTES) {
      const res = await send(crossed.app, route, actor.bearer);
      const where = `${route[0]} ${route[1]}`;
      expect(res.status, where).toBe(403);
      expect(res.body.error.code, where).toBe('wrong_namespace');
      // The refusal names the namespace the caller REACHED, never the one the
      // token belongs to.
      expect(res.body.error.detail, where).toEqual({ expected: 'beta-project' });
    }

    expect(lastRejection(crossed.store)).toMatchObject({
      reason: 'capability.namespace_mismatch',
      principalId: actor.principal.id,
      capabilityId: actor.capabilityId
    });
  });

  test("the foreign token cannot read the other namespace's messages", async () => {
    const secret = 'alpha-only material: SECRET-ALPHA-BODY';
    const posted = await request(alpha.app)
      .post('/channel/message')
      .set('Authorization', alphaActor.bearer)
      .send({ body: secret });
    expect(posted.status).toBe(201);

    // Through beta with alpha's token: refused before any read.
    const denied = await request(beta.app)
      .get('/channel/latest')
      .set('Authorization', alphaActor.bearer);
    expect(denied.status).toBe(401);
    expect(JSON.stringify(denied.body)).not.toContain('SECRET-ALPHA-BODY');

    const deniedById = await request(beta.app)
      .get(`/channel/message/${posted.body.id}`)
      .set('Authorization', alphaActor.bearer);
    expect(deniedById.status).toBe(401);

    // Through beta with beta's own token: allowed, and empty of alpha's content.
    // Each namespace serves its own `channel.md`, so there is no path by which
    // one document reaches the other's reader.
    const allowed = await request(beta.app)
      .get('/channel/latest')
      .set('Authorization', betaActor.bearer);
    expect(allowed.status).toBe(200);
    expect(JSON.stringify(allowed.body)).not.toContain('SECRET-ALPHA-BODY');
    expect(allowed.body.messages.map((m) => m.id)).not.toContain(posted.body.id);

    // Not even by id, with the right token for the wrong project.
    const byId = await request(beta.app)
      .get(`/channel/message/${posted.body.id}`)
      .set('Authorization', betaActor.bearer);
    expect(byId.status).toBe(404);

    expect(readFileSync(beta.channelPath, 'utf8')).not.toContain('SECRET-ALPHA-BODY');
    expect(readFileSync(alpha.channelPath, 'utf8')).toContain('SECRET-ALPHA-BODY');
  });

  test('neither store holds a row belonging to the other namespace', () => {
    for (const [self, other] of [
      [alpha, beta],
      [beta, alpha]
    ]) {
      for (const table of ['principal', 'capability', 'audit', 'cursor', 'permit', 'approval']) {
        expect(
          count(
            self.store,
            `SELECT COUNT(*) AS n FROM ${table} WHERE namespace = ?`,
            other.namespace
          ),
          `${self.namespace}.${table}`
        ).toBe(0);
        // Every row that IS there belongs to this namespace.
        expect(
          count(
            self.store,
            `SELECT COUNT(*) AS n FROM ${table} WHERE namespace != ?`,
            self.namespace
          ),
          `${self.namespace}.${table}`
        ).toBe(0);
      }
    }

    // A store file is pinned to its namespace, so the two can never be merged by
    // pointing one at the other's file.
    expect(() =>
      openStore({ path: join(alpha.root, '.collabcast/store/collabcast.db'), namespace: beta.namespace })
    ).toThrow(/different namespace/i);

    // The principals are unknown to each other by id, so a leaked id is not a
    // handle on anything.
    expect(
      count(beta.store, 'SELECT COUNT(*) AS n FROM principal WHERE id = ?', alphaActor.principal.id)
    ).toBe(0);
    expect(
      count(alpha.store, 'SELECT COUNT(*) AS n FROM principal WHERE id = ?', betaActor.principal.id)
    ).toBe(0);

    // And the token itself resolves to nothing in the other store: the HTTP
    // refusal is not the only thing standing in the way.
    expect(verifyCapability(beta.store, alphaActor.token)).toBeNull();
    expect(verifyCapability(alpha.store, betaActor.token)).toBeNull();
  });

  test('the refusal is audited in the namespace that refused it, and nowhere else', async () => {
    const before = count(
      alpha.store,
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'auth.reject'"
    );
    await request(beta.app).get('/self').set('Authorization', alphaActor.bearer);

    // Beta cannot say more than "unknown or inactive" — it has no way to know
    // the token is live in alpha, and the audit row must not imply otherwise.
    const rejected = lastRejection(beta.store);
    expect(rejected, 'beta records the rejection').not.toBeNull();
    expect(rejected.reason).toBe('capability.unknown_or_inactive');
    expect(rejected.method).toBe('GET');
    // The token must never be written to a durable row, in any form.
    expect(JSON.stringify(rejected)).not.toContain(alphaActor.token);
    expect(rejected.principalId).toBeUndefined();

    // Alpha never saw the request, so its trail must not grow.
    expect(count(alpha.store, "SELECT COUNT(*) AS n FROM audit WHERE action = 'auth.reject'")).toBe(
      before
    );
  });

  test('an enrollment code minted in one namespace cannot be exchanged in the other', async () => {
    // `/enroll/exchange` is the one route mounted before authentication, so it is
    // the only place a caller with no capability can ask for one. The code is a
    // row in the minting namespace's store, and nothing more.
    const issued = handleEnrollRequest(
      alpha.store,
      {
        namespace: alpha.namespace,
        role: 'root',
        scopes: [...ROLE_SCOPES.root],
        ttlSeconds: 600
      },
      { config: alpha.config }
    );

    const foreign = await request(beta.app)
      .post('/enroll/exchange')
      .send({ enrollmentCode: issued.code });
    expect(foreign.status).toBe(403);
    expect(foreign.body.token).toBeUndefined();
    expect(foreign.body.error.code).toBe('permit_invalid');

    // Beta minted nothing from it.
    expect(count(beta.store, 'SELECT COUNT(*) AS n FROM capability')).toBe(1);
    expect(count(beta.store, 'SELECT COUNT(*) AS n FROM approval')).toBe(0);

    // The code is still good where it was minted — the refusal above is about
    // the namespace, not about the code being spent by the attempt.
    const home = await request(alpha.app)
      .post('/enroll/exchange')
      .send({ enrollmentCode: issued.code });
    expect(home.status).toBe(201);
    expect(typeof home.body.token).toBe('string');
    expect(home.body.role).toBe('root');

    // And the capability it produced is itself confined to alpha.
    const minted = `Bearer ${home.body.token}`;
    const crossed = await request(beta.app).get('/self').set('Authorization', minted);
    expect(crossed.status).toBe(401);
    const athome = await request(alpha.app).get('/self').set('Authorization', minted);
    expect(athome.status).toBe(200);
    expect(athome.body.namespace ?? alpha.namespace).toBe(alpha.namespace);
  });
});
