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
 * 2. `walkie start` spawned a daemon unconditionally. Under `mode: 'managed'` the service is
 *    supervised by Paseo, and a client-spawned copy would be a second writer for the namespace.
 *    `startDaemon` now refuses.
 */

import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WalkieError } from '../identity/errors.js';
import { loadConfig } from '../config/load.js';
import { resolveNamespace } from '../identity/resolve.js';
import { probeSocket, resolveTransportPaths } from './transport.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, 'daemon-entry.js');

/** How long to wait for `/health` before calling the socket unresponsive. */
const HEALTH_TIMEOUT_MS = 2000;

/** How long to wait for a spawned service to answer, and how long to wait for one to go away. */
const START_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;

function fail(code, message, detail) {
  throw new WalkieError(code, message, detail);
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
      'this namespace is managed: its walkie service is supervised by Paseo and must not be ' +
        'spawned by a client. Start the Paseo-supervised walkie-svc service for this project, ' +
        'or set "mode": "standalone" in .walkie-talkie/config.json to run it yourself.',
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
  // directory than the caller is watching. WALKIE_RUNTIME_ROOT is the mechanism the child's own
  // resolver already honours, so there is exactly one code path for this.
  const childEnv = { ...(opts.env ?? process.env) };
  if (opts.runtimeRoot !== undefined) childEnv.WALKIE_RUNTIME_ROOT = opts.runtimeRoot;

  const child = spawn(process.execPath, [ENTRY], {
    cwd: canonicalRoot,
    detached: true,
    stdio: 'ignore',
    env: childEnv
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await statusDaemon({ ...opts, canonicalRoot, namespace, config });
    if (status.running) return status;
    await sleep(POLL_INTERVAL_MS);
  }
  fail('internal', 'the walkie service did not begin answering within the startup window', {
    seconds: START_TIMEOUT_MS / 1000
  });
}

/**
 * Stops the service for this project.
 *
 * Refuses to signal anything until `/health` has confirmed the listener serves this namespace. A
 * pid file alone is not authority to send a signal — an attacker (or a stale file after a pid
 * wrap) would otherwise turn `walkie stop` into an arbitrary-process kill.
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
      'the walkie service is answering but its pid file is missing or unreadable, so it cannot ' +
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
      fail('conflict', 'the walkie service could not be signalled', { reason: err.code });
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
  fail('internal', 'the walkie service did not stop within the shutdown window', {
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
