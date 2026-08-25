/**
 * The one HTTP client both walkie clients use.
 *
 * Everything here is deliberately narrow:
 *
 * - The primary transport is a Unix domain socket. There is no port file any more: the socket
 *   path IS the namespace claim, and the kernel enforces the uid via the 0700 directory that
 *   holds it. Loopback TCP is only ever used when the config explicitly enabled it.
 * - Authority travels in exactly one place, the `Authorization: Bearer` header. No identity,
 *   no alias, no session id and no routing hint is ever put in a body, a query string or
 *   another header — that was the v0.2 hole this wave closes.
 * - The token is supplied by a provider callback, never stored on the client, never returned
 *   from a method, and never interpolated into an error. A caller literally cannot read it
 *   back out of this module.
 * - A `{ error: { code, message, detail? } }` envelope becomes a `WalkieError` with the same
 *   code, so callers branch on codes rather than on HTTP status strings. A response that is
 *   not an envelope never has its body echoed: it could contain anything.
 */

import http from 'node:http';
import { WalkieError, walkieError, ERROR_CODES } from '../identity/errors.js';

/** Requests are local-only; a slow local socket means something is wrong, not busy. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Connection-level errno values that mean "the service is not there". */
const UNAVAILABLE_ERRNOS = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'ECONNRESET', 'EPIPE']);

const CODE_SET = new Set(ERROR_CODES);

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

/**
 * The message a client shows when the service is not listening. It names the namespace (not
 * secret) and the remedy appropriate to the mode, and never the socket path.
 *
 * @param {{namespace:string, mode:string}} ctx
 * @returns {WalkieError}
 */
export function unavailableError({ namespace, mode }) {
  if (mode === 'managed') {
    return walkieError(
      'unavailable',
      `the walkie-svc service for namespace "${namespace}" is not accepting connections. ` +
        'In managed mode this process is supervised by Paseo and clients never start it: ' +
        'check that the Paseo-supervised walkie-svc instance for this namespace is running.',
      { namespace, mode, supervisor: 'paseo' }
    );
  }
  return walkieError(
    'unavailable',
    `the walkie-svc service for namespace "${namespace}" is not accepting connections. ` +
      'In standalone mode start it with `walkie start`.',
    { namespace, mode }
  );
}

/**
 * Turn a non-2xx response into a WalkieError. An envelope is honoured verbatim; anything else
 * yields a generic error, because an unrecognised body may hold arbitrary content.
 *
 * @param {number} status
 * @param {unknown} parsed
 * @returns {WalkieError}
 */
function errorFromResponse(status, parsed) {
  const envelope = parsed && typeof parsed === 'object' ? parsed.error : undefined;
  if (envelope && typeof envelope === 'object' && CODE_SET.has(envelope.code)) {
    const message =
      typeof envelope.message === 'string' && envelope.message !== ''
        ? envelope.message
        : `request rejected with ${envelope.code}`;
    const err = new WalkieError(envelope.code, message, envelope.detail);
    err.status = status;
    return err;
  }
  const err = walkieError(
    'internal',
    `the walkie service returned an unrecognised HTTP ${status} response`,
    { status }
  );
  err.status = status;
  return err;
}

/**
 * A 2xx whose body is PRESENT but not readable JSON.
 *
 * This used to be coerced to `{}`, which is the worst possible answer: a truncated
 * `GET /inbox` became an inbox with no `messages` — indistinguishable from an empty one and
 * surfaced to a model as an authoritative "nothing to read" — and a truncated
 * `POST /enroll/exchange` became a success carrying no token. A response we cannot read is
 * a failure, and it says so. The body itself is never echoed: it may hold anything.
 *
 * @param {number} status
 * @param {number} bytes
 * @param {{namespace:string, mode:string}} context
 * @returns {WalkieError}
 */
function unreadableBodyError(status, bytes, context) {
  const err = walkieError(
    'internal',
    `the walkie service returned an HTTP ${status} response this client could not read`,
    { namespace: context.namespace, status, bytes }
  );
  err.status = status;
  return err;
}

/** Distinguishes "the body did not parse" from "the body parsed to null". */
const UNREADABLE = Symbol('walkie:unreadable-body');

/**
 * One request/response round trip. Resolves with the parsed body on 2xx, rejects with a
 * WalkieError otherwise.
 *
 * @param {object} opts
 * @param {{socketPath?:string, host?:string, port?:number}} opts.endpoint
 * @param {string} opts.method
 * @param {string} opts.path
 * @param {object} [opts.body]
 * @param {string|null} [opts.token]
 * @param {number} [opts.timeoutMs]
 * @param {{namespace:string, mode:string}} opts.context
 */
export function request({ endpoint, method, path, body, token, timeoutMs, context }) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { accept: 'application/json' };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.byteLength);
  }
  // The only channel authority is ever allowed to travel on.
  if (token) headers.authorization = `Bearer ${token}`;

  const options = endpoint.socketPath
    ? { socketPath: endpoint.socketPath, path, method, headers }
    : { host: endpoint.host, port: endpoint.port, path, method, headers };

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value, err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        const status = res.statusCode ?? 0;
        const ok = status >= 200 && status < 300;
        let parsed = null;
        if (text !== '') {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = UNREADABLE;
          }
        }
        if (!ok) {
          // A failure body that does not parse is simply not an envelope.
          settle(undefined, errorFromResponse(status, parsed === UNREADABLE ? null : parsed));
          return;
        }
        // An absent body stays fine — a no-content route resolves `{}`. A body that is
        // there but unreadable, or one that parses to a bare `null`, describes no result.
        if (parsed === UNREADABLE || (text !== '' && parsed === null)) {
          settle(undefined, unreadableBodyError(status, raw.byteLength, context));
          return;
        }
        settle(parsed ?? {});
      });
      res.on('error', () => settle(undefined, unavailableError(context)));
    });

    req.setTimeout(timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      req.destroy();
      settle(
        undefined,
        walkieError(
          'unavailable',
          `the walkie service for namespace "${context.namespace}" did not respond in time`,
          { namespace: context.namespace, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS }
        )
      );
    });

    req.on('error', (err) => {
      if (UNAVAILABLE_ERRNOS.has(err?.code)) {
        settle(undefined, unavailableError(context));
        return;
      }
      // Never surface err.message: it embeds the socket path.
      settle(
        undefined,
        walkieError('internal', 'the walkie service connection failed', {
          namespace: context.namespace
        })
      );
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Build a typed client for the walkie HTTP API.
 *
 * @param {object} opts
 * @param {{socketPath?:string, host?:string, port?:number}} opts.endpoint
 * @param {string} opts.namespace
 * @param {string} opts.mode `managed` | `standalone`
 * @param {() => (string|null)} [opts.token] returns the bearer token, or null when unenrolled
 * @param {number} [opts.timeoutMs]
 */
export function createApiClient({ endpoint, namespace, mode, token = () => null, timeoutMs }) {
  const context = { namespace, mode };

  function call(method, path, body, { anonymous = false } = {}) {
    return request({
      endpoint,
      method,
      path,
      body,
      token: anonymous ? null : token(),
      timeoutMs,
      context
    });
  }

  return {
    namespace,
    mode,
    endpoint,

    // --- unauthenticated -------------------------------------------------------------
    health: () => call('GET', '/health', undefined, { anonymous: true }),
    enrollExchange: (enrollmentCode) =>
      call('POST', '/enroll/exchange', { enrollmentCode }, { anonymous: true }),

    // --- identity --------------------------------------------------------------------
    self: () => call('GET', '/self'),
    principals: () => call('GET', '/principals'),
    setAlias: (alias) => call('POST', '/self/alias', { alias }),

    // --- channel reads ---------------------------------------------------------------
    latest: (limit = 5, includeArchived = false) =>
      call('GET', `/channel/latest${query({ limit, include_archived: includeArchived })}`),
    since: (ulid) => call('GET', `/channel/since/${encodeURIComponent(ulid)}`),
    message: (id) => call('GET', `/channel/message/${encodeURIComponent(id)}`),
    inbox: ({ includeMemoryUpdates = false } = {}) =>
      call('GET', `/inbox${query({ include_memory_updates: includeMemoryUpdates })}`),

    // --- channel writes --------------------------------------------------------------
    // Author, alias, tool, timestamp, git metadata and mentions are all server-derived.
    post: ({ body, type, replyTo }) => {
      const payload = { body };
      if (type !== undefined) payload.type = type;
      if (replyTo !== undefined && replyTo !== null) payload.replyTo = replyTo;
      return call('POST', '/channel/message', payload);
    },
    edit: (id, { body }) => call('PATCH', `/channel/message/${encodeURIComponent(id)}`, { body }),
    archive: (id, { reason } = {}) => {
      const payload = {};
      if (reason !== undefined && reason !== null) payload.reason = reason;
      return call('POST', `/channel/message/${encodeURIComponent(id)}/archive`, payload);
    },

    // --- cursors ---------------------------------------------------------------------
    // A cursor names a message id, not an ordinal: `seq` was the v0.2 field and both
    // routes now read and answer `id`. This layer is a pass-through. The flag names WHICH
    // /inbox view was read: false moves the default mark only, true moves both, because a
    // mark is sound only over the set it was recorded against.
    markRead: (id, { includeMemoryUpdates = false } = {}) =>
      call('POST', '/cursor/read', { id, include_memory_updates: includeMemoryUpdates }),
    ack: (id, { includeMemoryUpdates = false } = {}) =>
      call('POST', '/cursor/ack', { id, include_memory_updates: includeMemoryUpdates }),

    // --- authority -------------------------------------------------------------------
    delegate: ({ role, scopes, ttlSeconds, paseoAgentId }) => {
      const payload = { role, scopes, ttlSeconds };
      if (paseoAgentId !== undefined && paseoAgentId !== null) payload.paseoAgentId = paseoAgentId;
      return call('POST', '/delegate', payload);
    },
    revokeCapability: (id) => call('DELETE', `/capability/${encodeURIComponent(id)}`)
  };
}
