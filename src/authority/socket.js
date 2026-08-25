/**
 * The operator-hook enrollment socket.
 *
 * A second, deliberately tiny Unix socket that speaks one verb. It is separate from the
 * HTTP transport because its authentication model is different: HTTP callers present a
 * capability token, and this caller cannot — it is the OMP hook, running in the
 * operator's process, asking for the *first* capability to exist. Keeping that bootstrap
 * on its own socket with its own secret means the HTTP surface has exactly one auth path
 * and no exceptions carved into it.
 *
 * Protocol: connect, write one JSON object followed by one `\n`, read one JSON object
 * followed by one `\n`, done. No framing beyond that, no keep-alive, no second request.
 * Hard limits (8 KiB, one newline, 5 s idle) exist because the peer is a client we do
 * not control and an unbounded read on a socket is a memory-exhaustion primitive.
 *
 * Refusal policy: a bad secret and an unknown namespace produce a byte-identical reply,
 * so the socket cannot be used to confirm a stolen secret or enumerate namespaces. The
 * audit row records which it really was. Neither the secret nor the issued code is ever
 * logged or audited — `redactDetail` is applied to every log line as a second line of
 * defence behind simply never passing them.
 */

import net from 'node:net';
import { chmodSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { WalkieError } from '../identity/errors.js';
import { audit, redactDetail } from '../store/index.js';
import { compareSecret, loadSecret } from './secret.js';
import { DENIED_MESSAGE, OPAQUE_CODES, requireCodeTtlSeconds } from './policy.js';
import { handleEnrollRequest } from './enroll.js';
import {
  claimSocketAddress,
  probeSocketState,
  releaseSocketAddress,
  socketAddressState,
  unlinkSocketAddress
} from './socket-claim.js';
import {
  assertBindablePath,
  authoritySocketPath,
  ensureRuntimeDir,
  RUNTIME_FILE_MODE
} from './paths.js';

/** The only operation this socket accepts. */
export const ENROLL_OP = 'enroll.request';

/** A request larger than this is a client bug or an attack; either way it is refused. */
export const MAX_REQUEST_BYTES = 8 * 1024;

/** A connection that has not produced a complete line by then is dropped. */
export const IDLE_TIMEOUT_MS = 5000;

/**
 * Backlog of 8: this socket serves one local hook, not a fleet.
 *
 * Exported because a saturated accept queue is the case that used to make a live
 * listener look dead, so a test needs the number to fill it.
 */
export const LISTEN_BACKLOG = 8;

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [detail]
 */
function envelope(code, message, detail) {
  const error = { code, message };
  if (detail !== undefined) error.detail = detail;
  return { error };
}

/**
 * Renders a thrown value as a wire reply. Anything that is not a WalkieError becomes a
 * bare `internal`: driver and filesystem messages carry paths and bound parameters.
 *
 * @param {unknown} err
 */
export function replyFor(err) {
  if (err instanceof WalkieError) {
    if (OPAQUE_CODES.includes(err.code)) return envelope('forbidden', DENIED_MESSAGE);
    return err.toEnvelope();
  }
  return envelope('internal', 'internal error');
}

/**
 * Did a `connect()` to `path` succeed just now?
 *
 * Exported for callers asking "is an authority answering". It is NOT a liveness test:
 * `false` covers an abandoned inode, a live listener whose accept queue is full, and a
 * machine too busy to answer inside the window. Whether an address may be unlinked is
 * decided by `socketAddressState`, which tells those apart.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export function probeSocket(path) {
  return new Promise((resolve) => {
    const probe = net.createConnection({ path });
    const done = (live) => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(1000, () => done(false));
  });
}

/**
 * Clears the address, refusing to disturb a live listener.
 *
 * A stale socket file left by a killed process must be removed before `bind()` will
 * succeed, but unlinking a live socket silently steals a running authority's address.
 * Connecting cannot tell those apart — a full accept queue refuses exactly as an
 * abandoned inode does — so the decision rests on the owner claim written at bind
 * time. Only a claim naming a dead pid authorises the unlink; see
 * src/authority/socket-claim.js.
 *
 * @param {string} path
 * @param {{probe?:typeof probeSocketState}} [opts]
 */
export async function clearStaleSocket(path, { probe = probeSocketState } = {}) {
  const state = await socketAddressState(path, { probe });
  if (state === 'free') return;
  if (state === 'not-a-socket') {
    throw new WalkieError(
      'config_invalid',
      'the authority socket address is occupied by a regular file'
    );
  }
  if (state === 'occupied') {
    throw new WalkieError('conflict', 'another authority is already listening for this namespace');
  }
  if (state === 'unclaimed') {
    throw new WalkieError(
      'conflict',
      'the authority socket exists but no owning process can be identified, so it cannot be ' +
        'proven dead; remove it by hand if no authority is using it',
      { socketPath: path }
    );
  }
  try {
    unlinkSocketAddress(path);
  } catch (err) {
    throw new WalkieError('config_invalid', 'the stale authority socket could not be removed', {
      reason: err?.code ?? 'unknown'
    });
  }
}

/**
 * Extracts the request fields we act on. Everything else in the payload is ignored:
 * this socket reads authority from the secret and the namespace, never from a caller
 * -supplied principal, alias, or token.
 *
 * @param {unknown} parsed
 * @returns {{op:string, namespace:unknown, role:unknown, scopes:unknown,
 *            ttlSeconds:unknown, hookSecret:unknown}}
 */
export function readRequestLine(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WalkieError('invalid_request', 'the request must be a single JSON object');
  }
  const request = /** @type {Record<string, unknown>} */ (parsed);
  if (request.op !== ENROLL_OP) {
    throw new WalkieError('invalid_request', 'unsupported operation', { expected: ENROLL_OP });
  }
  return {
    op: ENROLL_OP,
    namespace: request.namespace,
    role: request.role,
    scopes: request.scopes,
    ttlSeconds: request.ttlSeconds,
    hookSecret: request.hookSecret
  };
}

/**
 * Wraps a log sink so every entry passes through `redactDetail` first, whatever the
 * call site passed. Nothing here is load-bearing: a sink that throws must not turn a
 * denial into a crash, and an absent sink is the normal case.
 *
 * @param {((entry:object) => void)|undefined} log
 * @returns {(entry:object) => void}
 */
function makeEmitter(log) {
  if (typeof log !== 'function') return () => {};
  return (entry) => {
    try {
      log(/** @type {object} */ (redactDetail(entry)));
    } catch {
      /* logging is never load-bearing inside an auth path */
    }
  };
}

/**
 * Builds the request handler. Exposed separately from the listener so the decision
 * logic can be exercised without a socket.
 *
 * Audit versus log: a *decision* — an issuance or a refusal of an authenticated,
 * well-formed request — is audited, because it is authority history. Malformed and
 * unauthenticated garbage is logged only: an unauthenticated peer must not be able to
 * grow the audit table at will, and a bad secret is the one exception because a
 * failed authentication attempt against the authority is exactly what an operator
 * needs to see.
 *
 * @param {{store:object, config:{namespace:string}, secret:string,
 *          codeTtlSeconds?:number, log?:(entry:object) => void}} deps
 * @returns {(parsed:unknown) => object} the reply object
 */
export function createEnrollHandler({ store, config, secret, codeTtlSeconds, log }) {
  if (!store || typeof store.tx !== 'function') {
    throw new WalkieError('internal', 'the authority requires a store');
  }
  if (typeof config?.namespace !== 'string' || config.namespace.length === 0) {
    throw new WalkieError('namespace_unresolved', 'the authority requires a namespace');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new WalkieError('config_invalid', 'the authority has no hook secret to verify against');
  }
  const codeTtl = requireCodeTtlSeconds(codeTtlSeconds);

  const emit = makeEmitter(log);

  /**
   * @param {string} reason the true reason, for the audit row only
   * @param {object} [detail]
   */
  const deny = (reason, detail) => {
    audit(store, {
      action: 'enroll.reject',
      outcome: 'denied',
      detail: { reason, ...(detail || {}) }
    });
    emit({ event: 'enroll.reject', outcome: 'denied', reason });
    return envelope('forbidden', DENIED_MESSAGE);
  };

  return function handle(parsed) {
    let request;
    try {
      request = readRequestLine(parsed);
    } catch (err) {
      emit({ event: 'enroll.request', outcome: 'rejected', reason: err?.code ?? 'internal' });
      return replyFor(err);
    }

    // The secret is checked before anything else is inspected and before anything is
    // written, so an unauthenticated caller cannot make us touch the database at all
    // beyond its own denial record.
    if (!compareSecret(request.hookSecret, secret)) {
      return deny('bad_secret');
    }

    try {
      const issued = handleEnrollRequest(
        store,
        {
          namespace: request.namespace,
          role: request.role,
          scopes: request.scopes,
          ttlSeconds: request.ttlSeconds
        },
        { config, codeTtlSeconds: codeTtl }
      );
      emit({
        event: 'enroll.request',
        outcome: 'issued',
        approvalId: issued.approvalId,
        role: issued.role,
        scopes: issued.scopes,
        ttlSeconds: issued.ttlSeconds
      });
      // The code crosses the wire here and is never written anywhere else.
      return { code: issued.code };
    } catch (err) {
      if (err instanceof WalkieError && OPAQUE_CODES.includes(err.code)) {
        return deny(err.code === 'wrong_namespace' ? 'unknown_namespace' : 'unauthenticated');
      }
      const code = err instanceof WalkieError ? err.code : 'internal';
      audit(store, {
        action: 'enroll.reject',
        outcome: 'denied',
        detail: { reason: code, ...(err instanceof WalkieError ? err.detail || {} : {}) }
      });
      emit({ event: 'enroll.request', outcome: 'denied', reason: code });
      return replyFor(err);
    }
  };
}

/**
 * Reads exactly one newline-terminated line from a socket, enforcing the byte cap.
 *
 * Bytes are counted, not characters: a multi-byte body must not be able to buy extra
 * headroom by looking short as a string.
 *
 * @param {import('node:net').Socket} socket
 * @param {number} idleTimeoutMs
 * @param {(line:string|null, err:WalkieError|null) => void} done
 */
function readOneLine(socket, idleTimeoutMs, done) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let settled = false;

  const settle = (line, err) => {
    if (settled) return;
    settled = true;
    socket.removeListener('data', onData);
    done(line, err);
  };

  const onData = (chunk) => {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      settle(null, new WalkieError('invalid_request', 'the request exceeded the size limit', {
        maxBytes: MAX_REQUEST_BYTES
      }));
      return;
    }
    chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) return;
    if (newline !== buffer.length - 1) {
      // One request per connection: trailing bytes mean a second request, or framing
      // confusion. Either way we refuse rather than guess.
      settle(null, new WalkieError('invalid_request', 'the request must be a single JSON line'));
      return;
    }
    settle(buffer.subarray(0, newline).toString('utf8'), null);
  };

  socket.on('data', onData);
  socket.setTimeout(idleTimeoutMs, () => {
    settle(null, new WalkieError('invalid_request', 'the request did not arrive in time'));
  });
  socket.once('error', () => {
    settle(null, new WalkieError('invalid_request', 'the connection failed before a request arrived'));
  });
  socket.once('end', () => {
    if (!settled) {
      settle(null, new WalkieError('invalid_request', 'the connection closed mid-request'));
    }
  });
}

/**
 * Binds the enrollment socket.
 *
 * @param {{store:object, config:{namespace:string}, runtimeRoot?:string,
 *          socketPath?:string, secret?:string, secretPath?:string,
 *          env?:Record<string,string|undefined>, codeTtlSeconds?:number,
 *          idleTimeoutMs?:number, log?:(entry:object) => void}} opts
 * @returns {Promise<{socketPath:string, close:() => Promise<void>}>}
 */
export async function startAuthoritySocket({
  store,
  config,
  runtimeRoot,
  socketPath,
  secret,
  secretPath,
  env = process.env,
  codeTtlSeconds,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  log
} = {}) {
  const resolvedSecret = (() => {
    if (typeof secret === 'string' && secret.length > 0) return secret;
    const loaded = loadSecret({ runtimeRoot, path: secretPath, env });
    if (!loaded) {
      throw new WalkieError(
        'config_invalid',
        'no hook secret is configured; run the enrollment hook installer to create one'
      );
    }
    return loaded.secret;
  })();

  const emit = makeEmitter(log);
  const handle = createEnrollHandler({
    store,
    config,
    secret: resolvedSecret,
    codeTtlSeconds,
    log
  });

  if (socketPath === undefined) ensureRuntimeDir(runtimeRoot);
  const path = assertBindablePath(authoritySocketPath(runtimeRoot, socketPath));
  await clearStaleSocket(path);

  const server = net.createServer({ allowHalfOpen: false }, (connection) => {
    connection.on('error', () => {
      /* a peer that hangs up mid-exchange is not an authority failure */
    });
    readOneLine(connection, idleTimeoutMs, (line, err) => {
      let reply;
      try {
        if (err) {
          // A framing failure — oversize, unterminated, a second request — never
          // reaches the handler, so log it here or it goes unobserved entirely.
          emit({ event: 'enroll.frame', outcome: 'rejected', reason: err.code });
          reply = replyFor(err);
        } else {
          reply = handle(JSON.parse(line));
        }
      } catch (thrown) {
        // A JSON parse failure, or — never expected, but a crashed handler must still
        // answer rather than leave the hook hanging on a dead connection.
        const framed =
          thrown instanceof SyntaxError
            ? new WalkieError('invalid_request', 'the request was not valid JSON')
            : thrown;
        emit({
          event: 'enroll.frame',
          outcome: 'rejected',
          reason: framed instanceof WalkieError ? framed.code : 'internal'
        });
        reply = replyFor(framed);
      }
      // `setTimeout(0)` clears the idle timer: the exchange is over, and a pending
      // timer would otherwise keep the event loop referenced until it fires.
      connection.setTimeout(0);
      try {
        connection.end(`${JSON.stringify(reply)}\n`);
      } catch {
        connection.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('error', onError);
      reject(
        new WalkieError('config_invalid', 'the authority socket could not be bound', {
          reason: err?.code ?? 'unknown'
        })
      );
    };
    server.once('error', onError);
    server.listen({ path, backlog: LISTEN_BACKLOG }, () => {
      server.removeListener('error', onError);
      resolve(undefined);
    });
  });

  // The socket's own mode is only applied after bind, which is precisely why the
  // containing directory is 0700 — that is what closes the window, this is defence
  // in depth for a directory an operator has loosened.
  chmodSync(path, RUNTIME_FILE_MODE);
  // The address is ours: say so, so a later start can prove this pid gone before it
  // ever considers unlinking. A SIGKILL leaves this claim behind on purpose.
  claimSocketAddress(path);
  // A listener-level fault after bind is not a per-connection error. This socket is the only
  // door through which any client obtains its first capability, so a fault here can leave a
  // service that answers `/health` permanently unable to enrol anyone — the exact shape of this
  // project's worst shipped bug, a composed service whose authority never served, invisible to
  // the whole suite. Dropping these on the floor is what made that invisible.
  //
  // Recoverable by policy, deliberately not fatal: the errnos that reach this handler (EMFILE
  // and ENFILE under fd pressure, ECONNABORTED on a racing accept) are transient, and tearing
  // the daemon down would drop every live session and the HTTP transport with them. So the
  // fault is recorded rather than thrown — and it is never silent: it goes to the redacting
  // sink, and if it left the listener down, `status().serving` goes false and `/health` says so.
  /** @type {{reason:string, at:number}|null} */
  let lastFault = null;
  server.on('error', (err) => {
    lastFault = { reason: err?.code ?? 'unknown', at: Date.now() };
    emit({
      event: 'authority.socket',
      outcome: 'faulted',
      reason: lastFault.reason,
      listening: server.listening
    });
  });

  return {
    socketPath: path,
    /**
     * The live listener.
     *
     * Exposed so a supervisor can observe accept-side state directly, and so the listener-fault
     * path above can be driven in a test — a post-bind `error` is otherwise only reachable under
     * real fd exhaustion, which is exactly why it went unnoticed. Nothing is ever issued
     * through this: every decision goes through the handler built above.
     */
    server,
    /**
     * Whether this socket is still accepting, plus the last fault seen.
     *
     * `serving` reads the listener's own state rather than a flag this module keeps: a
     * transient accept-time errno leaves `listening` true and must not raise a false alarm,
     * while a listener that has actually gone down is precisely what an operator has to see.
     *
     * @returns {{serving:boolean, socketPath:string, lastFault:{reason:string, at:number}|null}}
     */
    status: () => ({ serving: server.listening, socketPath: path, lastFault }),
    async close() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      try {
        if (existsSync(path) && statSync(path).isSocket()) unlinkSync(path);
      } catch {
        /* the address is already gone */
      }
      releaseSocketAddress(path);
    }
  };
}
