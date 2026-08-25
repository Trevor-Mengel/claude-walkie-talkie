/**
 * The `walkie-svc` process: one per namespace.
 *
 * Everything it needs it derives from the directory it was started in — the namespace from the
 * identity map, the config from the project's `.walkie-talkie/config.json`, the store from that
 * config's namespace. Nothing is passed in as an argument that could contradict any of it, and
 * nothing is published to a shared location.
 *
 * Two v0.2 behaviours are deliberately gone:
 *
 *   - the port file. The socket path is the address, and it is the namespace claim. A port file
 *     was a second, weaker answer to "where is the daemon" that any local process could read.
 *   - `registerProject` / `deregisterProject`. That machine-global registry in `~/.walkie-talkie`
 *     broadcast every project's port and pid to every same-uid process on the box, which is a
 *     cross-project information leak with no compensating benefit now that the socket is local to
 *     the project directory.
 */

import { chmodSync, unlinkSync, writeFileSync } from 'node:fs';
import { assertChannelStateExcluded, loadConfig } from '../config/load.js';
import { storeDir } from '../config/schema.js';
import { resolveNamespace } from '../identity/resolve.js';
import { WalkieError } from '../identity/errors.js';
import { paths as channelPaths } from '../core/channel.js';
import { ensureSecret, startAuthority } from '../authority/index.js';
import { openStore } from '../store/db.js';
import { audit } from '../store/audit.js';
import { createEvents } from './events.js';
import { createServer } from './server.js';
import { buildRouters } from './routes/index.js';
import { listen, resolveTransportPaths } from './transport.js';
import { startWatcher } from './watcher.js';
import { attachNotifier } from './notify.js';
import { join } from 'node:path';

/** A pid file names a signal target, so it is owner-only like every other runtime file. */
const PID_FILE_MODE = 0o600;

/** Errno reasons an operator can act on, mapped to the thing to go and look at. */
const BIND_HINTS = Object.freeze({
  EADDRINUSE: 'another walkie-svc is already serving this namespace',
  EACCES: 'the runtime directory is not writable by this user',
  EPERM: 'the runtime directory is not writable by this user',
  ENOTDIR: 'a component of the runtime directory path is not a directory',
  ENOENT: 'the runtime directory does not exist and could not be created',
  ENAMETOOLONG: 'the socket path is longer than AF_UNIX allows'
});

/**
 * The authority socket is not optional infrastructure, it is the only door in.
 *
 * `POST /enroll/exchange` is the single route mounted ahead of the capability gate, and it needs
 * a code that only the authority socket can mint. A service that came up with an HTTP listener
 * and no authority would therefore answer `/health`, look healthy to `walkie status`, and be
 * permanently incapable of issuing a first capability. So this is a hard failure, and it names
 * the directory an operator has to fix.
 *
 * A `conflict` keeps its code: "another authority is already listening for this namespace" is a
 * duplicate daemon, not a broken configuration, and the two want different operator responses.
 *
 * @param {any} err
 * @param {string} runtimeRoot
 * @param {string} socketPath
 */
function authorityUnavailable(err, runtimeRoot, socketPath) {
  const reason = err?.detail?.reason ?? err?.code ?? 'unknown';
  const hint = BIND_HINTS[reason];
  return new WalkieError(
    err?.code === 'conflict' ? 'conflict' : 'config_invalid',
    `the authority enrollment socket could not be started in ${runtimeRoot}; without it no ` +
      'client can ever be enrolled, so the service refuses to serve',
    {
      runtimeRoot,
      socketPath,
      reason,
      cause: err?.message ?? String(err),
      ...(hint ? { likelyCause: hint } : {})
    }
  );
}

/**
 * The default observability sink: one JSON line per event on stdout, which is where a
 * supervisor already looks. Injectable so a test can read what an operator would read.
 *
 * @param {object} entry
 */
function writeLine(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/**
 * Boots the service. Exported so a supervisor (or a test) can start one in-process rather than
 * relying on the module's side effects.
 *
 * Construction order is load-bearing, and teardown is its exact reverse:
 *
 *     store -> hook secret -> authority socket -> HTTP transport -> pid file -> watcher
 *
 * The store must be open before anything can be issued, and the secret must exist before the
 * authority accepts a connection. The authority is bound before the HTTP transport so that the
 * readiness signal every client already waits on — `/health` answering — implies enrollment is
 * possible. A surface that answers while the only door in is shut is the exact failure this
 * ordering exists to make unrepresentable.
 *
 * @param {{cwd?:string, env?:Record<string,string|undefined>, writePidFile?:boolean,
 *   log?:(entry:object) => void}} [opts]
 */
export async function startService({
  cwd = process.cwd(),
  env = process.env,
  writePidFile = true,
  log = writeLine
} = {}) {
  /** @param {object} entry */
  const emit = (entry) => {
    try {
      log(entry);
    } catch {
      // Observability is never load-bearing: a broken sink must not take the service down.
    }
  };

  const identity = resolveNamespace({ cwd, env });
  const { namespace, canonicalRoot } = identity;

  const config = loadConfig({ canonicalRoot, expectNamespace: namespace });
  const store = openStore({
    path: join(storeDir(canonicalRoot), 'walkie.db'),
    namespace
  });

  /**
   * Everything built so far, in construction order. One list serves both shutdown and a failed
   * boot, so there is no second teardown path that can forget a step.
   * @type {Array<{label:string, undo:() => unknown}>}
   */
  const built = [{ label: 'store', undo: () => store.close() }];

  /**
   * Reverses construction, running every remaining step even when one throws.
   * @returns {Promise<unknown|null>} the first failure, or null
   */
  async function unwind() {
    let failure = null;
    while (built.length > 0) {
      const step = /** @type {{label:string, undo:() => unknown}} */ (built.pop());
      try {
        await step.undo();
      } catch (err) {
        failure ??= err;
      }
    }
    return failure;
  }

  try {
    const events = createEvents();
    const channelPath = channelPaths(canonicalRoot).channel;
    assertChannelStateExcluded({
      channelPath,
      sessionsDir: channelPaths(canonicalRoot).sessionsDir,
      repoRoot: canonicalRoot
    });
    const deps = { store, config, namespace, channelPath, events };
    const { publicRouters, routers } = buildRouters(deps);

    // Bound before the authority exists, read only per request: `/health` must report the
    // authority's CURRENT state, not the state it had at composition time. A listener that dies
    // after boot leaves a service that is running and unenrollable, which is the same condition
    // the ordering below refuses at startup.
    /** @type {{status:() => {serving:boolean}}|null} */
    let authorityHandle = null;
    const authorityStatus = () => authorityHandle?.status() ?? null;

    const { app } = createServer({
      store,
      config,
      namespace,
      publicRouters,
      routers,
      events,
      authorityStatus
    });

    const transportPaths = resolveTransportPaths({ canonicalRoot, config, env });
    const { runtimeRoot } = transportPaths;

    // Only the path and the provenance are bound here, never the secret itself: the authority
    // re-reads it, so this composition root cannot leak a value it never holds.
    const { path: hookSecretPath, source: hookSecretSource } = ensureSecret({ runtimeRoot, env });

    let authority;
    try {
      authority = await startAuthority({ store, config, runtimeRoot, env, log: emit });
    } catch (err) {
      throw authorityUnavailable(err, runtimeRoot, transportPaths.authoritySocketPath);
    }
    authorityHandle = authority;
    built.push({ label: 'authority', undo: () => authority.close() });

    const listener = await listen(app, { config, canonicalRoot, env });
    built.push({ label: 'transport', undo: () => listener.close() });

    let pidPath = null;
    if (writePidFile) {
      pidPath = transportPaths.pidPath;
      writeFileSync(pidPath, `${process.pid}\n`, { mode: PID_FILE_MODE });
      chmodSync(pidPath, PID_FILE_MODE);
      built.push({
        label: 'pid',
        undo: () => {
          try {
            unlinkSync(/** @type {string} */ (pidPath));
          } catch {
            // Already removed.
          }
        }
      });
    }

    const stopWatcher = await startWatcher({ wtDir: channelPaths(canonicalRoot).wtDir, events });
    built.push({
      label: 'watcher',
      undo: async () => {
        try {
          await stopWatcher();
        } catch {
          // The watcher is best-effort; a failure here must not block the shutdown.
        }
      }
    });
    // `emit` is the notifier's only way to report a failed spawn: `notifier.notify`
    // signals that through its callback, long after any caller could catch it.
    attachNotifier({ events, projectName: namespace, log: emit });

    audit(store, {
      action: 'service.start',
      outcome: 'allowed',
      detail: { mode: config.mode, tcp: listener.addresses.tcp !== null }
    });

    // The two artifacts the OMP enrollment hook needs. `WALKIE_AUTHORITY_SOCKET` is
    // `authoritySocket`; `WALKIE_HOOK_SECRET` is the CONTENTS of `hookSecretPath`, which is
    // precisely why only the path is published here.
    emit({
      event: 'service.ready',
      namespace,
      runtimeRoot,
      transportSocket: listener.addresses.socket,
      tcp: listener.addresses.tcp,
      authoritySocket: authority.socketPath,
      hookSecretPath,
      hookSecretSource
    });

    let stopped = false;
    async function stop() {
      if (stopped) return;
      stopped = true;
      try {
        audit(store, { action: 'service.stop', outcome: 'allowed' });
      } catch {
        // The store may already be shutting down; the socket being gone is the real signal.
      }
      const failure = await unwind();
      if (failure) throw failure;
    }

    return {
      namespace,
      config,
      store,
      events,
      listener,
      authority,
      addresses: listener.addresses,
      runtimeRoot,
      authoritySocketPath: authority.socketPath,
      hookSecretPath,
      stop
    };
  } catch (err) {
    // Fail closed. A half-built service must never leave a listening HTTP socket behind: that
    // is exactly the healthy-looking-but-unenrollable state this ordering exists to prevent.
    await unwind();
    throw err;
  }
}

/**
 * True when this module is the process entry point rather than an import.
 * @param {string} url
 */
function isEntryPoint(url) {
  const arg = process.argv[1];
  if (!arg) return false;
  return url.endsWith(arg) || url.endsWith(arg.replace(/\\/g, '/'));
}

if (isEntryPoint(import.meta.url)) {
  let service;
  try {
    service = await startService();
  } catch (err) {
    // The supervisor reads stderr; the code is the actionable part.
    process.stderr.write(`walkie-svc failed to start: ${err.code ?? 'internal'}: ${err.message}\n`);
    process.exit(1);
  }

  const shutdown = () => {
    service
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
