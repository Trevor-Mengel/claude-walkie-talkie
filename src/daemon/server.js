/**
 * Composes the HTTP application.
 *
 * Nothing in this file knows what the routes are: authenticated and public routers are injected,
 * so the authorization boundary and the business logic can be reasoned about (and reviewed)
 * separately. The ordering below is the contract:
 *
 *   x-powered-by off
 *   -> Origin/Host guard        (DNS-rebinding defence, matters for the optional TCP listener)
 *   -> express.json(limit)      (limit from config, not a hard-coded literal)
 *   -> rejectLegacyAuthorityFields
 *   -> GET /health              (unauthenticated, discloses no filesystem path)
 *   -> publicRouters            (bootstrap only: POST /enroll/exchange)
 *   -> requireCapability        (every route below here has req.walkie)
 *   -> routers
 *   -> 404 envelope
 *   -> terminal error handler
 */

import express from 'express';
import { createEvents } from './events.js';
import { rejectLegacyAuthorityFields, requireCapability } from './auth.js';
import { WalkieError } from '../identity/errors.js';
import { StoreError } from '../store/errors.js';
import { SCHEMA_VERSION } from '../store/db.js';

/**
 * The only Host values a local-only daemon may answer to.
 *
 * A request over the Unix socket carries whatever Host the client library invented (Node's
 * http.request defaults to `localhost`), so this set has to include the loopback names as well as
 * the loopback literals.
 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Maps the shared error vocabulary onto HTTP. Exported so a test can assert it covers every code
 * in ERROR_CODES rather than silently falling through to 500.
 */
export const STATUS_BY_CODE = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  not_owner: 403,
  wrong_namespace: 403,
  scope_required: 403,
  permit_required: 403,
  permit_invalid: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  stale_fence: 409,
  config_invalid: 500,
  // Two codes deliberately share 503. RFC 9110 names "temporary overload" as exactly what
  // 503 is for, and a client that keys only on status then retries correctly for both;
  // the JSON `code` is what distinguishes "nothing is listening" from "the writer is
  // busy". 429 was rejected: it asserts THIS client sent too many requests, when a single
  // request from one agent is shed because a DIFFERENT agent held the channel lock.
  busy: 503,
  // Nothing failed; the supervised service simply is not listening. 503 is the honest answer and
  // it tells a client to retry rather than to report a bug.
  unavailable: 503,
  namespace_unresolved: 500,
  internal: 500
});

/**
 * Seconds a client should wait before repeating the identical request. Only codes whose
 * remedy really is "the same request, shortly" appear here — `conflict` and `stale_fence`
 * need the caller to re-read state first, so advertising a retry delay for them would be
 * an instruction to hammer.
 */
const RETRY_AFTER_SECONDS = Object.freeze({ busy: 1 });

/**
 * Extracts the hostname from a Host header value.
 *
 * Returns null for anything it cannot parse, which the caller treats as a rejection. The
 * bracketed IPv6 form is the case v0.2 got wrong: it split on ':' and compared the first
 * fragment, so `[::1]:9000` became `[` and every IPv6 loopback client was rejected with a 403.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function hostnameFromHeader(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0) return null;

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end <= 1) return null;
    const rest = raw.slice(end + 1);
    // Only an optional `:port` may follow the bracketed address.
    if (rest.length > 0 && !/^:\d{1,5}$/.test(rest)) return null;
    return raw.slice(1, end).toLowerCase();
  }

  const firstColon = raw.indexOf(':');
  if (firstColon === -1) return raw.toLowerCase();
  // An unbracketed address with two colons is a malformed IPv6 Host, not a host:port pair.
  if (raw.indexOf(':', firstColon + 1) !== -1) return null;
  const host = raw.slice(0, firstColon);
  if (host.length === 0) return null;
  if (!/^\d{1,5}$/.test(raw.slice(firstColon + 1))) return null;
  return host.toLowerCase();
}

/**
 * Defence in depth against DNS-rebinding-style attacks from the operator's browser.
 *
 * Three v0.2 defects are fixed here:
 *   1. A MISSING Host header passed, because `(req.headers.host || '')` is falsy and the check was
 *      `if (host && host !== ...)`. A request with no Host is now rejected.
 *   2. `Origin: null` was explicitly whitelisted. A file:// page and a sandboxed iframe both send
 *      it, and neither is a client of this daemon. ANY Origin header is now rejected — no
 *      legitimate caller is a browser.
 *   3. `[::1]:port` was rejected. It is now accepted.
 *
 * @type {import('express').RequestHandler}
 */
export function rejectCrossOrigin(req, res, next) {
  if (req.headers.origin !== undefined) {
    res.status(403).json({
      error: {
        code: 'forbidden',
        message: 'browser-originated requests are not allowed'
      }
    });
    return;
  }
  const host = hostnameFromHeader(req.headers.host);
  if (host === null || !ALLOWED_HOSTS.has(host)) {
    res.status(403).json({
      error: {
        code: 'forbidden',
        message: 'the Host header must be a loopback address'
      }
    });
    return;
  }
  next();
}

/** @param {string} code */
export function statusForCode(code) {
  return STATUS_BY_CODE[code] ?? 500;
}

/**
 * Renders a thrown value as `{ error: { code, message, detail? } }`.
 *
 * Only errors from our own vocabulary keep their message. Anything else — a driver error, a
 * TypeError, an fs error — collapses to a fixed string, because those messages routinely contain
 * filesystem paths and bound parameter values.
 *
 * @param {unknown} err
 * @returns {{status:number, body:{error:{code:string, message:string, detail?:object}}}}
 */
export function renderError(err) {
  if (err instanceof WalkieError) {
    return { status: statusForCode(err.code), body: err.toEnvelope() };
  }
  if (err instanceof StoreError) {
    const error = { code: err.code, message: err.message };
    if (err.detail !== undefined) error.detail = err.detail;
    return { status: statusForCode(err.code), body: { error } };
  }
  // body-parser signals a rejected payload through `type`; the message is safe to omit.
  if (err && typeof err.type === 'string' && err.type.startsWith('entity.')) {
    const tooLarge = err.type === 'entity.too.large';
    return {
      status: tooLarge ? 413 : 400,
      body: {
        error: {
          code: 'invalid_request',
          message: tooLarge ? 'request body is too large' : 'request body could not be parsed'
        }
      }
    };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
}

/**
 * @param {{store:object, config:object, namespace:string, routers?:Array,
 *   publicRouters?:Array, events?:import('node:events').EventEmitter,
 *   authorityStatus?:(() => {serving:boolean}|null)}} opts
 * @returns {{app:import('express').Express, events:import('node:events').EventEmitter}}
 */
export function createServer({
  store,
  config,
  namespace,
  routers = [],
  publicRouters = [],
  events,
  authorityStatus
} = {}) {
  if (!store || typeof store.db !== 'object') {
    // Fail closed. A store-less server would mount every injected router with no authentication
    // gate at all, so this can never be an optional argument.
    throw new WalkieError('internal', 'createServer requires an open authority store');
  }
  if (!config || typeof config !== 'object') {
    throw new WalkieError('config_invalid', 'createServer requires a validated config');
  }
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new WalkieError('namespace_unresolved', 'createServer requires a namespace');
  }

  const app = express();
  const emitter = events ?? createEvents();

  app.disable('x-powered-by');
  app.locals.store = store;
  app.locals.config = config;
  app.locals.namespace = namespace;
  app.locals.events = emitter;

  app.use(rejectCrossOrigin);
  app.use(express.json({ limit: config.transport.maxBodyBytes }));
  app.use(rejectLegacyAuthorityFields());

  // Unauthenticated liveness. Deliberately discloses nothing about the filesystem: v0.2 answered
  // with `wtDir`, handing any local process the project path it needed to attack next.
  //
  // Liveness includes the authority socket when one is bound. A service with an HTTP listener and
  // a dead enrollment socket is permanently incapable of issuing a first capability, so it must
  // not answer `ok` — that is the same rule `daemon-entry` already enforces at boot, held for the
  // whole lifetime rather than only for the first instant of it. `authorityStatus` is absent for
  // an app composed without an authority (every route test), and then this reports as before.
  app.get('/health', (_req, res) => {
    const authority = authorityStatus?.() ?? null;
    if (authority && authority.serving !== true) {
      res.status(503).json({
        ok: false,
        namespace,
        mode: config.mode,
        schemaVersion: SCHEMA_VERSION,
        authority: 'faulted'
      });
      return;
    }
    res.json({ ok: true, namespace, mode: config.mode, schemaVersion: SCHEMA_VERSION });
  });

  for (const router of publicRouters) app.use(router);

  app.use(requireCapability(store, namespace));

  for (const router of routers) app.use(router);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'no such route' } });
  });

  app.use((err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const { status, body } = renderError(err);
    // A retryable outcome that does not say WHEN is still a guess. `Retry-After` is the
    // whole point of the code: it turns "your write was shed" into an instruction an agent
    // can act on without inventing a backoff.
    const retryAfter = RETRY_AFTER_SECONDS[body.error.code];
    if (retryAfter !== undefined) res.set('Retry-After', String(retryAfter));
    res.status(status).json(body);
  });

  return { app, events: emitter };
}
