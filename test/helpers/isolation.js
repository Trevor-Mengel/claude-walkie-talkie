// Test-suite isolation guard.
//
// v0.2's suite spawned daemons with a plain inherited environment: every
// real-daemon test wrote (and pruned) the operator's real
// ~/.walkie-talkie/registry.json and fired real desktop notifications. This
// module makes that class of accident structurally impossible.
//
// It is loaded as a Vitest `setupFiles` module, so it runs inside every test
// worker before any test body executes, and it throws unless the whole process
// is already pointed at throw-away state. `test/helpers/global-setup.js`
// creates that state once per run and exports it into `process.env`.

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'node:net';

/** Env vars that must name a disposable location before any test may run. */
export const REQUIRED_ROOT_ENV = Object.freeze([
  'WALKIE_HOME',
  'WALKIE_CONFIG',
  'WALKIE_RUNTIME_ROOT',
  'WALKIE_HISTORY_ROOT',
  // Host identity map (a file path). A2's loader falls back to
  // $WALKIE_HOME/.walkie-talkie/identities.json then ~/.walkie-talkie/identities.json,
  // so it must be pinned or a test could read the operator's real map.
  'WALKIE_IDENTITIES'
]);

/** Set by `global-setup.js` (and by this file's own tests) before importing. */
const BOOTSTRAP_FLAG = '__WALKIE_ISOLATION_BOOTSTRAP__';

const NULL_DEVICE = '/dev/null';
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every ephemeral test listener binds here, so a stranger's port can never be handed to us. */
const LOOPBACK_HOST = '127.0.0.1';

/** Marks `net.Server.prototype` so a re-import cannot wrap `listen` twice. */
const LOOPBACK_PATCH_FLAG = Symbol.for('walkie.test.loopbackBinding');

function isolationError(message) {
  const err = new Error(`walkie test isolation: ${message}`);
  err.code = 'config_invalid';
  return err;
}

/**
 * Resolve a path to its canonical form, tolerating segments that do not exist
 * yet: the deepest existing ancestor is realpath'd (macOS `/var` -> `/private/var`)
 * and the remaining segments are re-appended.
 */
function canonical(pathLike) {
  const abs = resolve(pathLike);
  let head = abs;
  const tail = [];
  while (!existsSync(head)) {
    const parsed = parse(head);
    if (parsed.dir === head || parsed.base === '') return abs;
    tail.unshift(parsed.base);
    head = parsed.dir;
  }
  try {
    const real = realpathSync(head);
    return tail.length ? join(real, ...tail) : real;
  } catch (_e) {
    return abs;
  }
}

function isUnder(child, parent) {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

// Captured at module load, i.e. before any test mutates HOME or TMPDIR.
const REAL_HOME = canonical(homedir());
const TEMP_ROOT = canonical(tmpdir());

/** Locations that hold live user state. Nothing in a test may resolve here. */
export const FORBIDDEN_ROOTS = Object.freeze([
  REAL_HOME,
  canonical(join(homedir(), '.walkie-talkie')),
  canonical(join(homedir(), '.paseo')),
  canonical('/Users/trev/Projects/development/claude-walkie-talkie'),
  canonical(PKG_ROOT)
]);

/**
 * Assert that `pathLike` names a disposable location: an absolute path under the
 * OS temp dir that is not inside any live-state root. Returns the canonical
 * path; throws otherwise.
 */
export function assertDisposable(pathLike, label = 'path') {
  if (typeof pathLike !== 'string' || pathLike.trim() === '') {
    throw isolationError(`${label} must be a non-empty absolute path`);
  }
  if (!isAbsolute(pathLike)) {
    throw isolationError(`${label} must be absolute, got the relative path "${pathLike}"`);
  }
  const target = canonical(pathLike);
  for (const forbidden of FORBIDDEN_ROOTS) {
    if (isUnder(target, forbidden)) {
      throw isolationError(
        `${label} resolves inside live user state (${forbidden}); tests may only touch disposable temp directories`
      );
    }
  }
  if (!isUnder(target, TEMP_ROOT)) {
    throw isolationError(`${label} must resolve under the OS temp dir (${TEMP_ROOT}), got ${target}`);
  }
  return target;
}

/**
 * Create one disposable tree for a test run. Every walkie state location lives
 * under a single `mkdtemp` prefix so `cleanup()` removes all of it.
 */
export function makeDisposableRoots() {
  const base = mkdtempSync(join(TEMP_ROOT, 'walkie-iso-'));
  const roots = {
    base,
    home: join(base, 'home'),
    runtime: join(base, 'runtime'),
    data: join(base, 'data'),
    history: join(base, 'history'),
    // File paths, not directories: these name documents, not trees.
    config: join(base, 'config', 'walkie.json'),
    identities: join(base, 'config', 'identities.json'),
    // Kept short on purpose: AF_UNIX paths cap out near 104 bytes on macOS.
    socket: join(base, 'd.sock')
  };
  for (const dir of [roots.home, roots.runtime, roots.data, roots.history, dirname(roots.config)]) {
    mkdirSync(dir, { recursive: true });
  }
  // Seeded so a bare import of the identity loader never explodes on a missing file.
  writeFileSync(roots.identities, `${JSON.stringify({ schemaVersion: 1, identities: {} }, null, 2)}\n`);
  for (const [key, value] of Object.entries(roots)) {
    assertDisposable(value, `disposable root "${key}"`);
  }
  return Object.freeze({
    ...roots,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

/** The complete set of isolation variables implied by a disposable tree. */
export function isolationVars(roots) {
  return {
    WALKIE_ISOLATION_ROOT: roots.base,
    WALKIE_HOME: roots.home,
    WALKIE_CONFIG: roots.config,
    WALKIE_RUNTIME_ROOT: roots.runtime,
    WALKIE_HISTORY_ROOT: roots.history,
    WALKIE_DATA_ROOT: roots.data,
    WALKIE_IDENTITIES: roots.identities,
    WALKIE_SOCKET_PATH: roots.socket,
    WALKIE_NO_NOTIFY: '1',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE
  };
}

/** Write the isolation variables into `env` (defaults to `process.env`). */
export function applyIsolationEnv(roots, env = process.env) {
  const vars = isolationVars(roots);
  Object.assign(env, vars);
  return vars;
}

/**
 * Refuse to let tests run against live state. Called automatically on import
 * (this module is a Vitest setup file); `env` is injectable for its own tests.
 */
export function installIsolation({ env = process.env } = {}) {
  const resolved = {};
  for (const key of REQUIRED_ROOT_ENV) {
    const value = env[key];
    if (!value) {
      throw isolationError(`${key} is not set; tests must run under global-setup.js`);
    }
    resolved[key] = assertDisposable(value, key);
  }
  if (!env.WALKIE_NO_NOTIFY) {
    throw isolationError('WALKIE_NO_NOTIFY is not set; tests would fire real desktop notifications');
  }
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    if (env[key] !== NULL_DEVICE) {
      throw isolationError(`${key} must be ${NULL_DEVICE}, got ${env[key] ?? '(unset)'}`);
    }
  }
  return Object.freeze({
    home: resolved.WALKIE_HOME,
    config: resolved.WALKIE_CONFIG,
    runtime: resolved.WALKIE_RUNTIME_ROOT,
    history: resolved.WALKIE_HISTORY_ROOT,
    identities: resolved.WALKIE_IDENTITIES
  });
}

/**
 * A complete `env` for `spawn`: the ambient environment plus validated
 * isolation variables. Children get `HOME` pointed at the disposable home too,
 * so even code that falls back to `os.homedir()` cannot reach live state.
 */
export function isolatedEnv(extra = {}) {
  const state = installIsolation();
  const env = {
    ...process.env,
    WALKIE_ISOLATION_ROOT: process.env.WALKIE_ISOLATION_ROOT ?? state.home,
    WALKIE_HOME: state.home,
    WALKIE_CONFIG: state.config,
    WALKIE_RUNTIME_ROOT: state.runtime,
    WALKIE_HISTORY_ROOT: state.history,
    WALKIE_IDENTITIES: state.identities,
    WALKIE_NO_NOTIFY: process.env.WALKIE_NO_NOTIFY || '1',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    HOME: state.home
  };
  if (process.env.WALKIE_DATA_ROOT) env.WALKIE_DATA_ROOT = process.env.WALKIE_DATA_ROOT;
  if (process.env.WALKIE_SOCKET_PATH) env.WALKIE_SOCKET_PATH = process.env.WALKIE_SOCKET_PATH;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }
    // An override of a state root is held to the same disposability bar.
    if (REQUIRED_ROOT_ENV.includes(key)) assertDisposable(value, key);
    env[key] = value;
  }
  // Keep the homedir() fallback pointed at whichever home the child ends up with.
  if (env.WALKIE_HOME !== state.home) env.HOME = env.WALKIE_HOME;
  return env;
}

/**
 * Force every ephemeral TCP listener this process opens onto the loopback address.
 *
 * This closes a real, measured hole in the suite's hermeticity. `supertest` starts a
 * throw-away server per request with `server.listen(0)` — no host, so the wildcard
 * address — and then connects to `127.0.0.1:<port>`. Binding the wildcard does not
 * conflict with a foreign process that holds the *same* port on `127.0.0.1` only, so the
 * kernel is free to hand out such a port; the loopback connection then resolves to the
 * more specific bind, and the request is answered by a stranger.
 *
 * It is not hypothetical and it is not rare. Measured on this machine: eleven unrelated
 * processes (browsers, desktop apps, other toolchains) hold loopback-only ports inside
 * darwin's 49152-65535 ephemeral range, a wildcard `listen(0)` landed on one of them 6
 * times in 6000 binds, and a loopback-explicit `listen(0, '127.0.0.1')` landed on one 0
 * times in 6000 — the kernel will not hand out a port already bound on the address being
 * bound. At roughly a thousand supertest binds per full run that is about one poisoned
 * request per run, scattered at random across every file that uses supertest, which is
 * exactly what the suite showed: `501` and `404` from routes that do not exist here,
 * `ECONNRESET`, `Parse Error: Expected HTTP/`, and SSE reads that never resolve.
 *
 * Binding loopback-explicitly also wins the ambiguous case: if a foreign wildcard
 * listener does hold the port, a connection to `127.0.0.1` still resolves to the more
 * specific bind, which is ours.
 *
 * The bind has to stay synchronous, because supertest reads `server.address().port`
 * immediately after `listen()`. Passing a host to `listen()` sends it through
 * `dns.lookup`, which defers the bind by a tick and leaves `address()` null — so this
 * reaches for `_listen2`, which is precisely what Node's own hostless path ends up
 * calling (`listenInCluster` in a non-cluster process is a direct `_listen2`), with the
 * address made explicit rather than left as the wildcard.
 *
 * Only a port bind with no host is rewritten. A unix-socket `listen(path)`, a
 * `listen({ path })`, and any call that already names a host are left exactly as the
 * product wrote them — `src/daemon/transport.js` passes its host explicitly on purpose,
 * and this must not paper over that.
 */
export function installLoopbackBinding() {
  const proto = Server.prototype;
  if (proto[LOOPBACK_PATCH_FLAG]) return;
  if (typeof proto._listen2 !== 'function') {
    // Refusing to run beats silently reverting to a wildcard bind: the flake this
    // prevents is a wrong answer, not an error, and it lands on an unrelated test.
    throw isolationError(
      'node:net has no synchronous loopback bind path (Server.prototype._listen2), so an ' +
        'ephemeral test listener cannot be kept off ports held by other processes'
    );
  }
  const original = proto.listen;
  proto.listen = function listen(...args) {
    const bind = loopbackBind(args);
    if (bind === null) return original.apply(this, args);
    for (const arg of args) {
      if (typeof arg === 'function') this.once('listening', arg);
    }
    // addressType 4, no fd, no flags: an ordinary IPv4 TCP listener.
    this._listen2(LOOPBACK_HOST, bind.port, 4, bind.backlog, undefined, 0);
    return this;
  };
  proto[LOOPBACK_PATCH_FLAG] = true;
}

/**
 * The port and backlog of a hostless TCP `listen`, or null when the call is anything else
 * — a unix socket, a bind that already names a host or an fd, or a shape this does not
 * recognise. Anything unrecognised falls through to Node untouched.
 *
 * @param {unknown[]} args
 * @returns {{port:number, backlog:number|undefined}|null}
 */
function loopbackBind(args) {
  const [first] = args;
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    // `listen(port[, host[, backlog]][, cb])`: only the callback may follow, or the host
    // is already set and this is none of our business.
    for (const arg of args.slice(1)) {
      if (arg !== undefined && typeof arg !== 'function') return null;
    }
    return { port: Number(first), backlog: undefined };
  }
  if (
    first === null ||
    typeof first !== 'object' ||
    typeof first.port !== 'number' ||
    first.host !== undefined ||
    first.path !== undefined ||
    first.fd !== undefined ||
    first.exclusive !== undefined ||
    first.signal !== undefined ||
    first.ipv6Only !== undefined
  ) {
    return null;
  }
  return { port: first.port, backlog: first.backlog };
}

// A setup file runs once per worker, before any test body. Both guards belong here: the
// env check refuses live user state, and the bind rewrite refuses the ambient machine.
installLoopbackBinding();
if (!globalThis[BOOTSTRAP_FLAG]) installIsolation();
