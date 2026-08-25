// Fixtures for the route slice.
//
// Every fixture is a real one: a real SQLite authority store, a real
// `channel.md` written through the hardened single-writer path, and the real
// `createServer` composition (Origin/Host guard -> json -> legacy-field gate ->
// /health -> public routers -> requireCapability -> routers -> 404 -> error
// handler). Nothing about authentication or status mapping is stubbed, because
// the properties under test ARE the authentication and the status mapping.
//
// Everything lives under one `mkdtemp` prefix and is removed afterwards; the
// isolation harness (test/helpers/isolation.js) refuses to let any of it reach
// live user state.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../src/store/db.js';
import { createPrincipal } from '../../../src/store/principals.js';
import { issueCapability } from '../../../src/store/capabilities.js';
import { validateConfig } from '../../../src/config/schema.js';
import { createServer } from '../../../src/daemon/server.js';
import { createEvents } from '../../../src/daemon/events.js';
import { buildRouters } from '../../../src/daemon/routes/index.js';
import { createFixtureDir } from '../../helpers/fixture-leaks.js';

export const NAMESPACE = 'walkie-routes';

const CHANNEL_TEMPLATE = [
  '# Walkie-Talkie Channel: walkie-routes',
  '',
  '**Operator:** Route Tests',
  '',
  '<!-- WALKIE:HEADER_END -->',
  '',
  '---',
  ''
].join('\n');

/** Widest useful grant, so a scope test has to opt *out* rather than in. */
export const ALL_SCOPES = Object.freeze([
  'channel:read',
  'channel:publish',
  'channel:ack',
  'self:alias',
  'self:cursor'
]);

const roots = [];
const stores = [];

/**
 * A complete daemon fixture.
 * @returns {{root:string, wtDir:string, channelPath:string, store:object,
 *            config:object, namespace:string, app:object, events:object}}
 */
export function createFixture({ mode = 'standalone' } = {}) {
  const root = createFixtureDir('walkie-routes-');
  roots.push(root);
  const wtDir = join(root, '.walkie-talkie');
  mkdirSync(join(wtDir, '.sessions'), { recursive: true });
  const channelPath = join(wtDir, 'channel.md');
  writeFileSync(channelPath, CHANNEL_TEMPLATE, 'utf8');

  const storePath = join(wtDir, 'store', 'walkie.db');
  const store = openStore({ path: storePath, namespace: NAMESPACE });
  stores.push(store);

  const config = validateConfig(
    { schemaVersion: 3, namespace: NAMESPACE, mode },
    { canonicalRoot: root }
  );

  // One emitter, shared by the routers and the server — exactly the wiring the
  // composition root must do. Letting `createServer` mint its own while the
  // routers hold none is a silent no-op: publishes emit nowhere and /events
  // streams nothing.
  const events = createEvents();
  const deps = { store, config, namespace: NAMESPACE, channelPath, events };
  const { publicRouters, routers } = buildRouters(deps);
  const { app } = createServer({
    store,
    config,
    namespace: NAMESPACE,
    publicRouters,
    routers,
    events
  });

  return { root, wtDir, channelPath, store, config, namespace: NAMESPACE, app, events };
}

/**
 * Mints a principal and a bearer token for it.
 *
 * @param {object} store
 * @param {{role?:string, alias?:string|null, scopes?:string[], ttlSeconds?:number,
 *          paseoAgentId?:string|null}} [opts]
 */
export function mintActor(store, opts = {}) {
  const principal = createPrincipal(store, {
    role: opts.role ?? 'goal_hub',
    displayAlias: opts.alias === undefined ? null : opts.alias,
    paseoAgentId: opts.paseoAgentId ?? null
  });
  const { capabilityId, token } = issueCapability(store, {
    principalId: principal.id,
    scopes: opts.scopes ?? [...ALL_SCOPES],
    ttlSeconds: opts.ttlSeconds ?? 3600,
    attestationKind: 'operator_cli',
    attestationRef: `test:${principal.id}`
  });
  return { principal, capabilityId, token, bearer: `Bearer ${token}` };
}

/** Direct read of a cursor row — used to prove a read did NOT write one. */
export function cursorRows(store, principalId) {
  return store.db
    .prepare(
      'SELECT kind, last_message_id, updated_at FROM cursor ' +
        'WHERE namespace = ? AND owner_principal_id = ? ORDER BY kind'
    )
    .all(NAMESPACE, principalId);
}

/**
 * Every path pattern express actually mounted, flattened out of the router
 * stack. Used to assert a route does not exist rather than merely 404s today.
 */
export function mountedRoutes(app) {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods)
          .filter((m) => layer.route.methods[m])
          .map((m) => m.toUpperCase())
          .sort();
        for (const method of methods) out.push(`${method} ${layer.route.path}`);
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(app._router.stack);
  return out.sort();
}

export function cleanupFixtures() {
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
}
