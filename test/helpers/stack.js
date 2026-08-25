// A real, running collabcast stack in one call.
//
// v0.2's integration tests each hand-rolled their own boot: `spawnDaemon(wtDir)` plus a
// `createTmpProject()` whose `config.json` was `{ operator, projectName, permits: [] }`. None of
// that exists any more — the service resolves its namespace from the host identity map, loads a
// schema-3 config, and refuses to answer any route without a capability. So the boot sequence is
// now long enough that duplicating it per test file guarantees drift, and short enough to express
// once:
//
//   registered namespace (identity map + config)  ->  channel.md  ->  store
//     ->  HTTP app + Unix-socket listener  ->  authority enrollment socket
//     ->  principals, minted through the real approval path
//
// Two properties this fixture is careful about:
//
//   - Capabilities are issued the way production issues them. `root` goes through
//     `handleEnrollRequest` -> `exchangeEnrollmentCode`, i.e. an operator approval row and a
//     one-use code; `goal_hub` / `listener` go through a real `POST /delegate` over the socket
//     with the root's bearer. A test that shortcuts to `issueCapability` proves nothing about
//     issuance, and would keep passing if the delegation fence broke.
//   - Nothing escapes the temp tree. Every path is run through `assertDisposable`, the runtime
//     root is per-stack (so two stacks in one worker cannot share a socket), and `stop()` is
//     idempotent so an `afterEach` and a failed `beforeEach` can both call it.
//
// AF_UNIX addresses cap near 104 bytes, so the base prefix stays tiny: the longest path this
// fixture creates is `<base>/r/authority.sock`.

import http from 'node:http';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { assertDisposable, isolatedEnv } from './isolation.js';
import { createRegisteredNamespace } from './registered-namespace.js';
import { spawnDaemon, stopDaemon } from './spawn-daemon.js';
import { loadConfig } from '../../src/config/load.js';
import { storeDir } from '../../src/config/schema.js';
import { paths as channelPaths } from '../../src/core/channel.js';
import { openStore } from '../../src/store/db.js';
import { createPrincipal } from '../../src/store/principals.js';
import { issueCapability } from '../../src/store/capabilities.js';
import { getCursors } from '../../src/store/cursors.js';
import { createEvents } from '../../src/daemon/events.js';
import { createServer } from '../../src/daemon/server.js';
import { buildRouters } from '../../src/daemon/routes/index.js';
import { listen } from '../../src/daemon/transport.js';
import {
  DEFAULT_ENROLL_TTL_SECONDS,
  ROLE_SCOPES,
  authoritySocketPath,
  exchangeEnrollmentCode,
  generateSecret,
  handleEnrollRequest,
  loadSecret,
  startAuthority
} from '../../src/authority/index.js';

const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'templates',
  'channel.md'
);

/** Roles `POST /delegate` will mint. Mirrors DELEGABLE_ROLES in the route. */
const DELEGABLE = Object.freeze(['goal_hub', 'listener']);

/**
 * One request/response round trip over a Unix socket, resolving for every status.
 *
 * Deliberately NOT `createApiClient`: that throws a `CollabcastError` on non-2xx and drops the
 * status, and half the assertions in this slice are about the status and the error envelope.
 *
 * @param {object} opts
 * @param {string} opts.socketPath
 * @param {string} opts.method
 * @param {string} opts.path
 * @param {string|null} [opts.token]
 * @param {object} [opts.body]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{status:number, body:any, text:string}>}
 */
export function socketRequest({
  socketPath,
  method,
  path,
  token = null,
  body,
  headers = {},
  timeoutMs = 8000
}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const outgoing = { accept: 'application/json' };
  if (payload) {
    outgoing['content-type'] = 'application/json';
    outgoing['content-length'] = String(payload.byteLength);
  }
  if (token) outgoing.authorization = `Bearer ${token}`;
  Object.assign(outgoing, headers);

  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers: outgoing }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (text !== '') {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, text });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out: ${method} ${path}`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Normalise the `roles` argument. A plain string names a role and is keyed by it; an object may
 * rename the handle and narrow the scopes, which is how a test asks for a capability that is
 * deliberately missing a scope.
 *
 * @param {Array<string|{name?:string, role:string, scopes?:string[], ttlSeconds?:number}>} roles
 */
function normaliseRoles(roles) {
  return roles.map((entry) => {
    const spec = typeof entry === 'string' ? { role: entry } : { ...entry };
    if (typeof spec.role !== 'string' || spec.role.length === 0) {
      throw new Error('createStack: every role spec needs a role');
    }
    spec.name = spec.name ?? spec.role;
    return spec;
  });
}

/**
 * Boot a complete namespace: identity map, config, store, HTTP service on a Unix socket, the
 * authority enrollment socket, and one capability per requested role.
 *
 * @param {object} [opts]
 * @param {'managed'|'standalone'} [opts.mode]
 * @param {string} [opts.namespace]
 * @param {string} [opts.operator] operator name written into the channel header
 * @param {Array<string|{name?:string, role:string, scopes?:string[], ttlSeconds?:number}>} [opts.roles]
 * @param {boolean} [opts.spawn] run the service as a real `collabcast-svc` child process instead of
 *   composing it in-process. Slower, but it is the only thing that proves `daemon-entry.js`
 *   boots from nothing but its cwd.
 * @param {boolean} [opts.autoCleanup] register `stop()` with `onTestFinished`
 */
export async function createStack({
  mode = 'standalone',
  namespace = 'collabcast-stack',
  operator = 'Stack Operator',
  roles = ['root'],
  spawn = false,
  autoCleanup = true
} = {}) {
  const specs = normaliseRoles(roles);
  const ns = createRegisteredNamespace({ namespace, mode, autoCleanup: false });
  assertDisposable(ns.base, 'stack base');

  /** @type {Array<() => Promise<void>|void>} */
  const closers = [];
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    // Reverse order: the listener must stop accepting before the store it queries is closed.
    while (closers.length > 0) {
      const close = closers.pop();
      try {
        await close();
      } catch {
        // A teardown step that has already run must not mask the rest.
      }
    }
    assertDisposable(ns.base, 'stack base');
    rmSync(ns.base, { recursive: true, force: true });
  }
  if (autoCleanup) {
    try {
      onTestFinished(() => stop());
    } catch {
      // Outside a test context; the caller owns teardown.
    }
  }

  try {
    // `createRegisteredNamespace` seeds a one-line channel.md, which has no
    // `WALKIE:HEADER_END` and so cannot be parsed. Write the shipped template instead: the
    // parser this stack exercises is the real one.
    const paths = channelPaths(ns.canonicalRoot);
    assertDisposable(paths.channel, 'stack channel');
    mkdirSync(paths.sessionsDir, { recursive: true });
    writeFileSync(
      paths.channel,
      readFileSync(TEMPLATE_PATH, 'utf8')
        .replace('PROJECT_NAME', namespace)
        .replace('OPERATOR_NAME', operator)
        .replace('CREATED_AT', new Date().toISOString()),
      'utf8'
    );

    // The real loader, so a config this fixture writes badly fails here rather than surviving
    // into a test that then asserts on nonsense.
    const config = loadConfig({ canonicalRoot: ns.canonicalRoot, expectNamespace: namespace });

    const storePath = join(storeDir(ns.canonicalRoot), 'collabcast.db');
    assertDisposable(storePath, 'stack store');
    const store = openStore({ path: storePath, namespace });
    closers.push(() => store.close());

    // One emitter shared by the routers, the server and `/events`. Handing the routers a
    // different emitter from the one `/events` subscribes to is a silent no-op. In spawned
    // mode the emitter that matters lives in the child; this one stays local and unused, and
    // `/events` is served by the child's own.
    const events = createEvents();
    let socketPath;
    /** @type {null|Awaited<ReturnType<typeof spawnDaemon>>} */
    let daemon = null;

    if (spawn) {
      // The real product boot: no arguments, namespace from the identity map, config from the
      // project. Nothing else in the suite proves `daemon-entry.js` can actually come up.
      daemon = await spawnDaemon({
        cwd: ns.canonicalRoot,
        env: isolatedEnv({
          COLLABCAST_IDENTITIES: ns.identitiesPath,
          COLLABCAST_RUNTIME_ROOT: ns.runtimeRoot,
          COLLABCAST_CAPABILITY: undefined,
          COLLABCAST_NAMESPACE: undefined
        }),
        socketPath: ns.socketPath,
        namespace
      });
      closers.push(() => stopDaemon(daemon));
      socketPath = daemon.socketPath;
    } else {
      const deps = { store, config, namespace, channelPath: paths.channel, events };
      const { publicRouters, routers } = buildRouters(deps);
      const { app } = createServer({ store, config, namespace, publicRouters, routers, events });
      const listener = await listen(app, {
        config,
        canonicalRoot: ns.canonicalRoot,
        env: ns.env
      });
      closers.push(() => listener.close());
      socketPath = listener.socketPath;
    }
    assertDisposable(socketPath, 'stack transport socket');

    // Who owns the authority depends on who owns the daemon. A spawned `collabcast-svc` binds
    // `<runtimeRoot>/authority.sock` and mints the hook secret itself — that is its composition
    // root's job — so here the fixture ADOPTS the child's artifacts.
    //
    // Do not "simplify" this back into an unconditional `startAuthority`. This fixture binding
    // its own authority socket is precisely what hid the production omission for 854 tests: a
    // fixture that constructs the subject cannot detect the subject not being constructed. The
    // composition root is covered by `test/daemon/daemon-entry.test.js`, which deliberately does
    // not use this file.
    let hookSecret;
    let authoritySocket;
    /** @type {number|null} the child's socket inode; a rebind here would change it */
    let adoptedInode = null;
    if (daemon) {
      // `env: {}` so this reads the file the child wrote, never an ambient COLLABCAST_HOOK_SECRET.
      const minted = loadSecret({ runtimeRoot: ns.runtimeRoot, env: {} });
      if (!minted) {
        throw new Error('createStack: the spawned collabcast-svc did not mint a hook secret');
      }
      hookSecret = minted.secret;
      authoritySocket = authoritySocketPath(ns.runtimeRoot);
      const adopted = lstatSync(authoritySocket);
      if (!adopted.isSocket()) {
        throw new Error(`createStack: ${authoritySocket} is not a socket the child bound`);
      }
      adoptedInode = adopted.ino;
    } else {
      hookSecret = generateSecret();
      const authority = await startAuthority({
        store,
        config,
        runtimeRoot: ns.runtimeRoot,
        secret: hookSecret
      });
      closers.push(() => authority.close());
      authoritySocket = authority.socketPath;
    }
    assertDisposable(authoritySocket, 'stack authority socket');

    /**
     * @param {string} method
     * @param {string} path
     * @param {{token?:string|null, body?:object, headers?:Record<string,string>}} [opts]
     */
    const request = (method, path, opts = {}) =>
      socketRequest({ socketPath, method, path, ...opts });

    /** @type {Record<string, {role:string, principalId:string, capabilityId:string, token:string, scopes:string[], expiresAt:string}>} */
    const principals = {};
    /** @type {Record<string, string>} */
    const tokens = {};

    /** The one operator-approved issuance path: approval row -> one-use code -> capability. */
    const enrollRoot = (spec) => {
      const scopes = spec.scopes ?? [...ROLE_SCOPES.root];
      const ttlSeconds = spec.ttlSeconds ?? DEFAULT_ENROLL_TTL_SECONDS;
      const { code } = handleEnrollRequest(
        store,
        { namespace, role: 'root', scopes, ttlSeconds },
        { config }
      );
      const issued = exchangeEnrollmentCode(store, code);
      return {
        role: issued.role,
        principalId: issued.principalId,
        capabilityId: issued.capabilityId,
        token: issued.token,
        scopes: issued.scopes,
        expiresAt: issued.expiresAt
      };
    };

    /**
     * Delegation, over the wire, with the root's bearer — exactly what an operator does.
     *
     * The default grant is the role's allowlist INTERSECTED with what the root actually holds,
     * not the allowlist itself. `issueCapability` refuses to widen a parent, and `ROLE_SCOPES`
     * gives `listener` two scopes (`listener:consume`, `listener:receipt`) that `root` does not
     * hold — they are reserved for the P1 durable listener and no route enforces them yet. So
     * the full listener allowlist is unreachable by delegation by design, and defaulting to it
     * would make this fixture demand a widening the store is right to refuse.
     */
    const delegate = async (spec) => {
      const root = principals.root;
      if (!root) {
        throw new Error(`createStack: delegating ${spec.role} needs a root; list 'root' first`);
      }
      const held = new Set(root.scopes);
      const scopes = spec.scopes ?? ROLE_SCOPES[spec.role].filter((scope) => held.has(scope));
      const res = await request('POST', '/delegate', {
        token: root.token,
        body: { role: spec.role, scopes, ttlSeconds: spec.ttlSeconds ?? 900 }
      });
      if (res.status !== 201) {
        throw new Error(
          `createStack: delegating ${spec.role} failed with ${res.status}: ${res.text}`
        );
      }
      return {
        role: res.body.role,
        principalId: res.body.principalId,
        capabilityId: res.body.capabilityId,
        token: res.body.token,
        scopes: res.body.scopes,
        expiresAt: res.body.expiresAt
      };
    };

    /**
     * The operator principal. There is no enrollment or delegation path to `operator` — the role
     * is deliberately unreachable from an agent-initiated dialog — so it is minted directly with
     * the `operator_cli` attestation the schema reserves for exactly this.
     */
    const mintOperator = (spec) => {
      const principal = createPrincipal(store, { role: 'operator', displayAlias: null });
      const scopes = spec.scopes ?? [
        'channel:read',
        'channel:publish',
        'channel:ack',
        'self:alias',
        'self:cursor'
      ];
      const { capabilityId, token } = issueCapability(store, {
        principalId: principal.id,
        scopes,
        ttlSeconds: spec.ttlSeconds ?? 900,
        attestationKind: 'operator_cli',
        attestationRef: `operator:${principal.id}`
      });
      return {
        role: 'operator',
        principalId: principal.id,
        capabilityId,
        token,
        scopes: [...scopes].sort(),
        expiresAt: null
      };
    };

    for (const spec of specs) {
      let minted;
      if (spec.role === 'root') minted = enrollRoot(spec);
      else if (spec.role === 'operator') minted = mintOperator(spec);
      else if (DELEGABLE.includes(spec.role)) minted = await delegate(spec);
      else throw new Error(`createStack: no issuance path for role ${spec.role}`);
      principals[spec.name] = minted;
      tokens[spec.name] = minted.token;
    }

    // The adoption has to still hold: an inode change here means something in this fixture
    // rebound the address after the child bound it, which is the regression the branch above
    // exists to prevent — and it would silently re-hide the composition-root defect.
    if (adoptedInode !== null && lstatSync(authoritySocket).ino !== adoptedInode) {
      throw new Error(
        'createStack: the authority socket was rebound; the fixture must adopt the spawned ' +
          "collabcast-svc's socket, never bind its own"
      );
    }

    return {
      namespace,
      mode,
      base: ns.base,
      canonicalRoot: ns.canonicalRoot,
      runtimeRoot: ns.runtimeRoot,
      identitiesPath: ns.identitiesPath,
      channelPath: paths.channel,
      socketPath,
      daemon,
      authoritySocketPath: authoritySocket,
      hookSecret,
      config,
      store,
      events,
      principals,
      tokens,
      request,

      /** Raw env for a child process in this namespace (CLI or MCP). */
      childEnv(extra = {}) {
        return isolatedEnv({
          COLLABCAST_IDENTITIES: ns.identitiesPath,
          COLLABCAST_RUNTIME_ROOT: ns.runtimeRoot,
          COLLABCAST_PROJECT_ROOT: ns.canonicalRoot,
          COLLABCAST_CAPABILITY: undefined,
          COLLABCAST_NAMESPACE: undefined,
          ...extra
        });
      },

      /** Child env carrying one principal's capability as `COLLABCAST_CAPABILITY`. */
      capabilityEnv(name, extra = {}) {
        const principal = principals[name];
        if (!principal) throw new Error(`createStack: no principal named ${name}`);
        return this.childEnv({ COLLABCAST_CAPABILITY: principal.token, ...extra });
      },

      /** Write `<runtimeRoot>/operator.cred` for a minted principal (0600). */
      writeCredential(name) {
        const principal = principals[name];
        if (!principal) throw new Error(`createStack: no principal named ${name}`);
        return ns.writeOperatorCredential(principal.token);
      },

      /** Direct cursor read, so a test can prove a read did NOT move one. */
      cursors(principalId) {
        return getCursors(store, principalId);
      },

      stop
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
