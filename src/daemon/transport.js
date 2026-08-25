/**
 * The listening surface of `collabcast-svc`.
 *
 * There is exactly one service process per namespace and its primary transport is a Unix domain
 * socket. That is the whole authorization story for "which namespace is this": the socket path IS
 * the namespace claim, and the kernel enforces who may connect via the mode of the directory
 * holding it. Nothing here reads a port file, a registry, or an environment variable to decide
 * who it is talking to.
 *
 * Optional loopback TCP exists for tooling that cannot speak AF_UNIX. It is off by default and it
 * binds an explicit literal host. v0.2 called `app.listen(0)` with no host, which binds every
 * interface — the live v0.2 daemon was observed listening on `*:54030`, i.e. reachable from the
 * LAN with no authentication at all. `bindTcp` below refuses to call the one-argument form.
 */

import { chmodSync, statSync, unlinkSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { CollabcastError } from '../identity/errors.js';
import { LOOPBACK_HOSTS, SOCKET_DIR_MODE } from '../config/schema.js';
import {
  claimSocketAddress,
  probeSocketState,
  releaseSocketAddress,
  socketAddressState,
  unlinkSocketAddress
} from '../authority/socket-claim.js';
import {
  MAX_SOCKET_PATH_BYTES,
  authorityRuntimeDir,
  authoritySocketPath,
  ensureRuntimeDir
} from '../authority/paths.js';

export const COLLABCAST_SOCKET_FILENAME = 'collabcast.sock';
export const PID_FILENAME = 'collabcast.pid';

/** A listening socket is a credential: owner-only, always. */
export const SOCKET_FILE_MODE = 0o600;

/** How long to wait for a connect() while deciding whether a socket file is stale. */
const PROBE_TIMEOUT_MS = 500;

/** How long to wait for a bind() before calling it a failure. */
const BIND_TIMEOUT_MS = 5000;

function fail(code, message, detail) {
  throw new CollabcastError(code, message, detail);
}

/**
 * Rejects a socket path the kernel would refuse to bind. AF_UNIX `sun_path` is a fixed-size
 * field and `bind()` answers ENAMETOOLONG rather than truncating. The ceiling itself lives in
 * src/authority/paths.js so both sockets share one number.
 *
 * @param {string} socketPath
 * @returns {string}
 */
export function assertBindableSocketPath(socketPath) {
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    fail('config_invalid', 'the transport socket path is too long for a unix domain socket', {
      bytes,
      maxBytes: MAX_SOCKET_PATH_BYTES
    });
  }
  return socketPath;
}

/**
 * Every runtime path the service owns.
 *
 * Both sockets — the HTTP transport socket and the authority enrollment socket — resolve through
 * `authorityRuntimeDir`, so they can never drift into separate directories with separate
 * permissions. Precedence is that resolver's: explicit `runtimeRoot`, then `COLLABCAST_RUNTIME_ROOT`,
 * then `<canonicalRoot>/.collabcast/run`.
 *
 * @param {{canonicalRoot?:string, config?:object, runtimeRoot?:string,
 *   env?:Record<string,string|undefined>}} opts
 * @returns {{runtimeRoot:string, socketPath:string, authoritySocketPath:string, pidPath:string}}
 */
export function resolveTransportPaths({ canonicalRoot, config, runtimeRoot, env } = {}) {
  const root = authorityRuntimeDir(canonicalRoot, runtimeRoot, env);
  const configured = config?.transport?.socketPath ?? null;
  return {
    runtimeRoot: root,
    socketPath: configured || join(root, COLLABCAST_SOCKET_FILENAME),
    authoritySocketPath: authoritySocketPath(root),
    pidPath: join(root, PID_FILENAME)
  };
}

/**
 * Creates the directory holding a socket and clamps it to owner-only, re-applying the mode on
 * every call so a directory loosened out of band is tightened again before we bind in it.
 *
 * @param {string} socketPath
 * @returns {string} the directory
 */
export function ensureSocketDir(socketPath) {
  const dir = ensureRuntimeDir(dirname(socketPath));
  const mode = statSync(dir).mode & 0o777;
  if (mode !== SOCKET_DIR_MODE) {
    fail('config_invalid', 'the directory holding the transport socket must be owner-only', {
      required: SOCKET_DIR_MODE.toString(8),
      found: mode.toString(8)
    });
  }
  return dir;
}

/**
 * Did a `connect()` to `socketPath` succeed just now?
 *
 * This answers "is something accepting connections right now", which is what
 * `src/daemon/lifecycle.js` needs when it waits for a daemon to stop answering. It is
 * NOT a liveness test: `false` covers an abandoned inode, a live listener whose accept
 * queue is full, and a machine too busy to answer inside the window. Deciding whether
 * an address may be unlinked needs `socketAddressState`, which distinguishes those.
 *
 * @param {string} socketPath
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<boolean>}
 */
export function probeSocket(socketPath, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ path: socketPath });
    const finish = (live) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Makes `socketPath` available to bind, or refuses.
 *
 * Unlinking unconditionally is how two daemons end up fighting over one namespace: the
 * second one deletes the first one's socket and the first one's clients silently stop
 * being served. So only an address proven free is reclaimed, and "proven" means a
 * shutdown claim naming a dead pid — not a refused connect, which a live listener with a
 * full accept queue also produces, and not a timeout, which a busy machine produces.
 * See src/authority/socket-claim.js for why connect-probing cannot decide this.
 *
 * A path occupied by something that is not a socket is never removed at all — that would
 * make this a file-deletion primitive.
 *
 * @param {string} socketPath
 * @param {{probe?:typeof probeSocketState}} [opts] the probe is injectable so the
 *   refuse-on-anything-but-a-hard-refusal rule is testable without a 128-connection
 *   accept-queue storm.
 * @returns {Promise<boolean>} true when a stale socket was reclaimed
 */
export async function reclaimSocketPath(socketPath, { probe = probeSocketState } = {}) {
  const state = await socketAddressState(socketPath, { probe, timeoutMs: PROBE_TIMEOUT_MS });
  if (state === 'free') return false;
  if (state === 'not-a-socket') {
    fail('conflict', 'the transport socket path is occupied by something that is not a socket');
  }
  if (state === 'occupied') {
    fail(
      'conflict',
      'another collabcast service is already listening for this namespace; stop it before starting a new one'
    );
  }
  if (state === 'unclaimed') {
    fail(
      'conflict',
      'the transport socket exists but no owning process can be identified, so it cannot be ' +
        'proven dead; remove it by hand if no service is using it',
      { socketPath }
    );
  }
  try {
    unlinkSocketAddress(socketPath);
  } catch (err) {
    fail('conflict', 'a stale transport socket could not be removed', { reason: err.code });
  }
  return true;
}

/**
 * Resolves once `server` is listening, or rejects with a CollabcastError.
 * @param {import('node:http').Server} server
 * @param {() => void} bind
 */
function awaitListening(server, bind) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new CollabcastError('internal', 'the transport did not begin listening in time'));
    }, BIND_TIMEOUT_MS);
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      if (err) reject(err);
      else resolve();
    };
    function onError(err) {
      const code =
        err.code === 'EADDRINUSE' || err.code === 'EACCES' || err.code === 'EEXIST'
          ? 'conflict'
          : 'internal';
      done(new CollabcastError(code, 'the transport could not bind', { reason: err.code }));
    }
    function onListening() {
      done(null);
    }
    server.once('error', onError);
    server.once('listening', onListening);
    bind();
  });
}

/**
 * Binds a loopback TCP listener with the host as an explicit literal.
 *
 * The host is re-checked here even though config validation already checked it: `listen` must
 * never be reachable through a hand-built config object, and a one-argument `listen(port)` binds
 * every interface.
 *
 * @param {import('node:http').Server} server
 * @param {{host:string, port:number}} opts
 */
async function bindTcp(server, { host, port }) {
  if (typeof host !== 'string' || host.length === 0) {
    fail('config_invalid', 'a tcp listener requires an explicit loopback host');
  }
  if (!LOOPBACK_HOSTS.includes(host)) {
    fail('config_invalid', 'a tcp listener may only bind a loopback host', {
      allowed: LOOPBACK_HOSTS
    });
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail('config_invalid', 'a tcp listener requires an integer port in 0..65535');
  }
  // Two arguments, always: the host is what keeps this off every other interface.
  await awaitListening(server, () => server.listen(port, host));
}

/**
 * Starts listening for `app`.
 *
 * @param {import('express').Express} app
 * @param {{config?:object, canonicalRoot?:string, runtimeRoot?:string, socketPath?:string}} opts
 * @returns {Promise<{close:() => Promise<void>, addresses:{socket:string|null,
 *   tcp:{host:string, port:number}|null}, socketPath:string|null, runtimeRoot:string}>}
 */
export async function listen(app, opts = {}) {
  if (typeof app !== 'function') fail('internal', 'listen requires a request handler');
  const paths = resolveTransportPaths(opts);
  const transport = opts.config?.transport ?? {};
  const wantsSocket = transport.unixSocket !== false;
  const tcp = transport.tcp ?? {};
  const wantsTcp = tcp.enabled === true;

  if (!wantsSocket && !wantsTcp) {
    fail('config_invalid', 'no transport is enabled: set transport.unixSocket or transport.tcp');
  }

  const socketPath = wantsSocket ? (opts.socketPath ?? paths.socketPath) : null;
  const servers = [];
  let boundSocket = null;
  let tcpAddress = null;

  try {
    if (socketPath) {
      assertBindableSocketPath(socketPath);
      ensureSocketDir(socketPath);
      await reclaimSocketPath(socketPath);
      const unixServer = createHttpServer(app);
      await awaitListening(unixServer, () => unixServer.listen(socketPath));
      // The bind honours umask, so the mode is only correct once we say so.
      chmodSync(socketPath, SOCKET_FILE_MODE);
      // Now that the address is ours, record who holds it. A later start reclaims this
      // address only by finding this pid gone, so a SIGKILL leaves the claim behind and
      // the next start can prove the owner died.
      claimSocketAddress(socketPath);
      servers.push(unixServer);
      boundSocket = socketPath;
    }

    if (wantsTcp) {
      const tcpServer = createHttpServer(app);
      await bindTcp(tcpServer, { host: tcp.host, port: tcp.port ?? 0 });
      const addr = tcpServer.address();
      tcpAddress = { host: addr.address, port: addr.port };
      servers.push(tcpServer);
    }
  } catch (err) {
    await closeAll(servers, boundSocket);
    throw err;
  }

  let closed = false;
  return {
    runtimeRoot: paths.runtimeRoot,
    socketPath: boundSocket,
    addresses: { socket: boundSocket, tcp: tcpAddress },
    async close() {
      if (closed) return;
      closed = true;
      await closeAll(servers, boundSocket);
    }
  };
}

/**
 * @param {import('node:http').Server[]} servers
 * @param {string|null} socketPath
 */
async function closeAll(servers, socketPath) {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
          server.closeAllConnections?.();
        })
    )
  );
  if (socketPath) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Already gone: another shutdown path or an operator removed it.
    }
    releaseSocketAddress(socketPath);
  }
}
