/**
 * Starting, checking and stopping the local service.
 *
 * Two v0.2 defects drive the shape of this module.
 *
 * 1. Liveness was `process.kill(pid, 0)` against a pid read from a file. That predicate is true
 *    for ANY live process with that pid, so after a reboot or a pid wrap the daemon is reported
 *    as running when it is not — and worse, `stopDaemon` then sent SIGTERM to whatever unrelated
 *    process had inherited the number. A file in a directory is not proof of identity. So both
 *    liveness and stop are decided by talking to the socket and reading `/health`, and the pid is
 *    only ever used after the service on the other end has confirmed it serves this namespace.
 *
 * 2. `collabcast start` spawned a daemon unconditionally. Under `mode: 'managed'` the service is
 *    supervised by Paseo, and a client-spawned copy would be a second writer for the namespace.
 *    `startDaemon` now refuses.
 *
 * A third, found later: the spawn was `stdio: 'ignore'`, so every operator-facing refusal the
 * boot can produce — a wedged `hook.secret`, a revoked `operator.cred` — went to /dev/null and
 * the operator saw only a ten-second timeout with nothing to act on. The service's stderr now
 * lands in `<runtimeRoot>/service.err` and a failed start quotes it back.
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollabcastError } from '../identity/errors.js';
import { loadConfig } from '../config/load.js';
import { resolveNamespace } from '../identity/resolve.js';
import { RUNTIME_FILE_MODE, ensureRuntimeDir, serviceStderrPath } from '../authority/paths.js';
import { probeSocket, resolveTransportPaths } from './transport.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, 'daemon-entry.js');

/** How long to wait for `/health` before calling the socket unresponsive. */
const HEALTH_TIMEOUT_MS = 2000;

/** How long to wait for a spawned service to answer, and how long to wait for one to go away. */
const START_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;

/**
 * How much of a failed service's stderr to quote back. Enough for a fault line plus its remedy,
 * short enough that a runaway log cannot become the error message.
 */
const STDERR_QUOTE_LINES = 4;
const STDERR_QUOTE_BYTES = 2048;

/**
 * Opens the file the spawned service's stderr is redirected to, truncating whatever the previous
 * run left. Returns null when it cannot be opened: losing the diagnostic channel must never be
 * the reason a service fails to start.
 *
 * @param {string} runtimeRoot
 * @returns {{fd:number, path:string}|null}
 */
function openServiceStderr(runtimeRoot) {
  try {
    const path = serviceStderrPath(runtimeRoot);
    ensureRuntimeDir(runtimeRoot);
    return { fd: openSync(path, 'w', RUNTIME_FILE_MODE), path };
  } catch {
    return null;
  }
}

/**
 * The tail of what the service said before it gave up, as one line.
 *
 * @param {string|null} path
 * @returns {string} '' when there is nothing to quote
 */
function quoteServiceStderr(path) {
  if (path === null) return '';
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return '';
  return lines.slice(-STDERR_QUOTE_LINES).join(' | ').slice(0, STDERR_QUOTE_BYTES);
}

function fail(code, message, detail) {
  throw new CollabcastError(code, message, detail);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asks `/health` over a Unix socket.
 *
 * @param {string} socketPath
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, namespace:string, mode:string, schemaVersion:string}|null>}
 */
export function readHealth(socketPath, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = request(
      { socketPath, path: '/health', method: 'GET', headers: { Host: '127.0.0.1' } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            finish(null);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(body && body.ok === true && typeof body.namespace === 'string' ? body : null);
          } catch {
            finish(null);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(null);
    });
    req.on('error', () => finish(null));
    req.end();
  });
}

/**
 * Resolves the namespace, config and runtime paths for a project root.
 *
 * `runtimeRoot` is threaded through so the daemon, the client and this module cannot disagree
 * about where the socket and pid file live: every one of them resolves through
 * `resolveTransportPaths`.
 *
 * @param {{canonicalRoot?:string, cwd?:string, env?:Record<string,string|undefined>,
 *   config?:object, namespace?:string, runtimeRoot?:string}} opts
 */
function resolveTarget({
  canonicalRoot,
  cwd,
  env = process.env,
  config,
  namespace,
  runtimeRoot
} = {}) {
  let root = canonicalRoot;
  let ns = namespace;
  if (root === undefined || ns === undefined) {
    const identity = resolveNamespace({ cwd: cwd ?? root ?? process.cwd(), env });
    root = root ?? identity.canonicalRoot;
    ns = ns ?? identity.namespace;
  }
  const effective = config ?? loadConfig({ canonicalRoot: root, expectNamespace: ns });
  const paths = resolveTransportPaths({
    canonicalRoot: root,
    config: effective,
    runtimeRoot,
    env
  });
  return { canonicalRoot: root, namespace: ns, config: effective, paths, runtimeRoot };
}

/** @param {string} pidPath */
async function readPid(pidPath) {
  try {
    const text = await readFile(pidPath, 'utf8');
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Is a service serving this namespace right now?
 *
 * `running` is true only when the socket answered `/health` AND the namespace it reported matches
 * the one this project resolves to. A pid is reported only alongside that confirmation, so it is
 * never a bare number read off disk.
 *
 * @param {object} [opts] see resolveTarget
 * @returns {Promise<{running:boolean, namespace:string, socketPath:string, pid:number|null,
 *   mode?:string, schemaVersion?:string, reason?:string}>}
 */
export async function statusDaemon(opts = {}) {
  const { namespace, paths, config } = resolveTarget(opts);
  const base = { namespace, socketPath: paths.socketPath, pid: null };

  const health = await readHealth(paths.socketPath);
  if (!health) {
    return { ...base, running: false, mode: config.mode, reason: 'no_response' };
  }
  if (health.namespace !== namespace) {
    // Something is listening on our socket path but it is not us. Never report it as ours, and
    // never hand its pid to a caller that might signal it.
    return { ...base, running: false, mode: config.mode, reason: 'namespace_mismatch' };
  }
  return {
    ...base,
    running: true,
    pid: await readPid(paths.pidPath),
    mode: health.mode,
    schemaVersion: health.schemaVersion
  };
}

/**
 * Spawns the service for this project.
 *
 * Refuses under `mode: 'managed'`: that namespace's service is supervised, and a second writer
 * would fight the supervised one for the same socket and the same channel file.
 *
 * @param {object} [opts] see resolveTarget
 * @returns {Promise<object>} the status of the running service
 */
export async function startDaemon(opts = {}) {
  const target = resolveTarget(opts);
  const { config, canonicalRoot, namespace, paths } = target;

  if (config.mode === 'managed') {
    fail(
      'forbidden',
      'this namespace is managed: its collabcast service is supervised by Paseo and must not be ' +
        'spawned by a client. Start the Paseo-supervised collabcast-svc service for this project, ' +
        'or set "mode": "standalone" in .collabcast/config.json to run it yourself.',
      { mode: config.mode, namespace }
    );
  }

  const current = await statusDaemon({ ...opts, canonicalRoot, namespace, config });
  if (current.running) return current;

  if (await probeSocket(paths.socketPath)) {
    fail(
      'conflict',
      'something is already listening on this namespace socket but it does not answer as this ' +
        'namespace; remove it before starting a service here'
    );
  }

  // An explicit runtimeRoot has to reach the child, or it would resolve a different socket
  // directory than the caller is watching. COLLABCAST_RUNTIME_ROOT is the mechanism the child's own
  // resolver already honours, so there is exactly one code path for this.
  const childEnv = { ...(opts.env ?? process.env) };
  if (opts.runtimeRoot !== undefined) childEnv.COLLABCAST_RUNTIME_ROOT = opts.runtimeRoot;

  // A FILE, not a pipe. A pipe dies with this short-lived parent, and the next thing the
  // detached service wrote to stderr would raise EPIPE inside it — trading a lost diagnostic
  // for a killed daemon. A file also outlives the failed start, so `service.err` is still there
  // when the operator goes looking.
  const diagnostics = openServiceStderr(paths.runtimeRoot);
  const child = spawn(process.execPath, [ENTRY], {
    cwd: canonicalRoot,
    detached: true,
    stdio: ['ignore', 'ignore', diagnostics ? diagnostics.fd : 'ignore'],
    env: childEnv
  });
  child.unref();
  if (diagnostics) closeSync(diagnostics.fd);

  // A service that has already exited will never answer, and waiting out the full window for a
  // deterministic refusal (a wedged credential, an unbindable socket) makes a one-line fix feel
  // like a hang. `unref` detaches the handle from the event loop; it does not stop this event
  // firing while we are still polling.
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', () => {
    exited = true;
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await statusDaemon({ ...opts, canonicalRoot, namespace, config });
    if (status.running) return status;
    if (exited) break;
    await sleep(POLL_INTERVAL_MS);
  }
  // The service's own words, on the operator's terminal. The refusals this quotes deliberately
  // name a runtime path — that is the operator channel, and this is the operator.
  const reported = quoteServiceStderr(diagnostics ? diagnostics.path : null);
  const what = exited
    ? 'the collabcast service exited instead of answering'
    : 'the collabcast service did not begin answering within the startup window';
  fail('internal', reported === '' ? what : `${what}; it reported: ${reported}`, {
    seconds: START_TIMEOUT_MS / 1000,
    exited
  });
}

/**
 * Stops the service for this project.
 *
 * Refuses to signal anything until `/health` has confirmed the listener serves this namespace. A
 * pid file alone is not authority to send a signal — an attacker (or a stale file after a pid
 * wrap) would otherwise turn `collabcast stop` into an arbitrary-process kill.
 *
 * @param {object} [opts] see resolveTarget
 * @returns {Promise<{stopped:boolean, pid:number|null, reason?:string}>}
 */
export async function stopDaemon(opts = {}) {
  const { namespace, paths, config } = resolveTarget(opts);

  const health = await readHealth(paths.socketPath);
  if (!health) {
    // Nothing is answering, so there is nothing to signal. Clear our own stale pid file and stop.
    await unlink(paths.pidPath).catch(() => {});
    return { stopped: false, pid: null, reason: 'not_running' };
  }
  if (health.namespace !== namespace) {
    fail(
      'wrong_namespace',
      'refusing to stop the process on this socket: it reports a different namespace',
      { expected: namespace, found: health.namespace }
    );
  }

  const pid = await readPid(paths.pidPath);
  if (pid === null) {
    fail(
      'conflict',
      'the collabcast service is answering but its pid file is missing or unreadable, so it cannot ' +
        'be signalled safely'
    );
  }
  if (pid === process.pid) {
    fail('conflict', 'refusing to signal the current process');
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      fail('conflict', 'the collabcast service could not be signalled', { reason: err.code });
    }
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await probeSocket(paths.socketPath))) {
      await unlink(paths.pidPath).catch(() => {});
      return { stopped: true, pid, mode: config.mode };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  fail('internal', 'the collabcast service did not stop within the shutdown window', {
    seconds: STOP_TIMEOUT_MS / 1000
  });
}

/**
 * Returns the running service, starting one only in standalone mode.
 *
 * @param {object} [opts] see resolveTarget
 */
export async function ensureRunning(opts = {}) {
  const status = await statusDaemon(opts);
  if (status.running) return status;
  return startDaemon(opts);
}
