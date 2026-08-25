/**
 * The authorization boundary.
 *
 * Every non-health route reaches its handler only after a capability token in the `Authorization`
 * header has been resolved to a live principal in this namespace. That is the entire story:
 *
 *   - identity comes from the token, never from the request body, query string, or an env var
 *   - authority comes from the capability's scopes, never from a claim the caller makes
 *   - the namespace comes from the socket the caller reached and is cross-checked against the
 *     capability, so a token minted for another project cannot be replayed here
 *
 * v0.2 took `fromSessionId` / `fromAlias` / `fromTool` / `autonomous` straight off the JSON body,
 * which meant any local process could post as any agent and self-grant permission. Those keys are
 * now a hard 400 — see `rejectLegacyAuthorityFields`.
 */

import { WalkieError } from '../identity/errors.js';
import { hasScope, verifyCapability, SCOPES } from '../store/capabilities.js';
import { audit } from '../store/audit.js';

/**
 * Body keys that used to carry identity or authority. Their presence means the caller is running
 * pre-cutover client code, and answering it politely would be answering a forged claim.
 */
export const LEGACY_AUTHORITY_FIELDS = Object.freeze([
  'fromSessionId',
  'fromAlias',
  'fromTool',
  'autonomous',
  'editedBy',
  'archivedBy',
  'sessionId',
  'invitedBy',
  'operator'
]);

const SCOPE_SET = new Set(SCOPES);

/** Audit action for a rejected authentication attempt. */
export const AUTH_REJECT_ACTION = 'auth.reject';

/** Audit action for an authenticated caller denied a scope it does not hold. */
export const SCOPE_REJECT_ACTION = 'scope.reject';

/**
 * Extracts the bearer token from an `Authorization` header value.
 *
 * Strict on purpose: exactly two whitespace-separated parts, a case-insensitive `Bearer` scheme,
 * and a non-empty credential. `Bearer` with no token, `Bearer a b`, and a bare token with no
 * scheme all resolve to null rather than being coerced into something plausible.
 *
 * @param {unknown} headerValue
 * @returns {string|null}
 */
export function parseBearer(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const parts = headerValue.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1].length > 0 ? parts[1] : null;
}

/**
 * Records a rejected authentication attempt.
 *
 * `detail` carries the reason and the HTTP method and nothing else — deliberately not the request
 * path, because a caller can put arbitrary bytes (including a token they are trying to use) into
 * a path segment, and an audit row is a durable place for a secret to end up.
 *
 * Reason strings are dotted (`bearer.missing_or_malformed`, not `missing_or_malformed_bearer`) on
 * purpose: `redactDetail` treats any 24+ character run of `[A-Za-z0-9_-]` as a possible secret and
 * replaces it, so a long snake_case reason would be written to the audit log as `[redacted]`. The
 * dot keeps the reason legible without weakening the redaction rule.
 *
 * A failed audit write is swallowed. That is not a silent failure being papered over: the request
 * is still rejected, and turning a broken audit table into a 500 would tell an unauthenticated
 * caller something about the health of the store.
 *
 * @param {object} store
 * @param {import('express').Request} req
 * @param {string} reason
 * @param {object} [extra]
 */
function auditReject(store, req, reason, extra) {
  try {
    audit(store, {
      action: AUTH_REJECT_ACTION,
      outcome: 'denied',
      detail: { reason, method: req.method, ...extra }
    });
  } catch {
    // See above: the rejection itself is the security-relevant outcome.
  }
}

/**
 * Builds the app-level authentication gate.
 *
 * @param {object} store the namespaced authority store
 * @param {string} serverNamespace the namespace this socket serves
 * @returns {import('express').RequestHandler}
 */
export function requireCapability(store, serverNamespace) {
  if (!store || typeof store.db !== 'object') {
    throw new WalkieError('internal', 'requireCapability needs an open store');
  }
  if (typeof serverNamespace !== 'string' || serverNamespace.length === 0) {
    throw new WalkieError('namespace_unresolved', 'requireCapability needs a server namespace');
  }

  return function capabilityGate(req, _res, next) {
    const token = parseBearer(req.headers.authorization);
    if (!token) {
      auditReject(store, req, 'bearer.missing_or_malformed');
      next(new WalkieError('unauthenticated', 'a capability token is required'));
      return;
    }

    let resolved = null;
    try {
      resolved = verifyCapability(store, token);
    } catch {
      // verifyCapability collapses every rejection to null; a throw here is a store-level
      // problem, and an unauthenticated caller learns nothing either way.
      resolved = null;
    }

    if (!resolved) {
      // Unknown, expired, revoked, not-yet-valid, or revoked-ancestor: one answer for all of
      // them, so the response never tells a prober which check it failed.
      auditReject(store, req, 'capability.unknown_or_inactive');
      next(new WalkieError('unauthenticated', 'a capability token is required'));
      return;
    }

    if (resolved.capability.namespace !== serverNamespace) {
      auditReject(store, req, 'capability.namespace_mismatch', {
        principalId: resolved.principal.id,
        capabilityId: resolved.capability.id
      });
      next(
        new WalkieError('wrong_namespace', 'this capability belongs to a different namespace', {
          expected: serverNamespace
        })
      );
      return;
    }

    req.walkie = {
      principal: resolved.principal,
      capability: resolved.capability,
      namespace: serverNamespace
    };
    next();
  };
}

/**
 * Route-level scope enforcement. Mount after `requireCapability`.
 *
 * Every denial is recorded. An authenticated principal reaching for authority it
 * does not hold is an authority decision like any other, and it was the one
 * decision on this surface that left nothing behind: authentication failures
 * audit (`auth.reject`), a denied alias audits, a denied capability revoke
 * audits, and a probe walking the route table for a scope it might have been
 * over-granted audited nothing at all.
 *
 * The row names the scope and the mounted route PATTERN — `/capability/:id`,
 * never `/capability/<whatever-the-caller-typed>`. That distinction is the whole
 * reason `auditReject` above refuses to record `req.path`: a caller can put a
 * token in a path segment, and an audit row is a durable place for a secret to
 * land. `req.route.path` comes from the router's own matched layer, so it holds
 * no caller bytes. The token is never recorded, here or anywhere.
 *
 * A failed audit write is NOT swallowed here — unlike `auditReject`, which
 * answers unauthenticated callers. This caller is already authenticated, so a
 * 500 leaks nothing it does not already know, and an authority decision this
 * process cannot record is a genuine fault rather than a refusal to soften.
 *
 * @param {string} scope one of store SCOPES
 * @returns {import('express').RequestHandler}
 */
export function requireScope(scope) {
  if (!SCOPE_SET.has(scope)) {
    throw new WalkieError('internal', 'requireScope was given an unknown scope', {
      scope: String(scope)
    });
  }
  return function scopeGate(req, _res, next) {
    const capability = req.walkie?.capability;
    if (!capability) {
      next(new WalkieError('unauthenticated', 'a capability token is required'));
      return;
    }
    if (!hasScope(capability, scope)) {
      // The composition root puts the store on `app.locals` (see
      // `src/daemon/server.js`), which is the only way this per-route gate can
      // reach it. A gate invoked with no express app behind it — only a unit test
      // does that — still refuses; it just has nowhere to write.
      const store = req.app?.locals?.store;
      if (store) {
        audit(store, {
          action: SCOPE_REJECT_ACTION,
          actorPrincipalId: req.walkie.principal?.id ?? null,
          subject: capability.id,
          outcome: 'denied',
          detail: { scope, method: req.method, route: req.route?.path ?? null }
        });
      }
      next(
        new WalkieError('scope_required', `this route requires the ${scope} scope`, { scope })
      );
      return;
    }
    next();
  };
}

/**
 * Rejects a request body that still carries pre-cutover identity or authority claims.
 *
 * Mounted before authentication on purpose: this is a statement about the shape of the input, not
 * about who is asking, and an old client deserves the same clear 400 whether or not it also
 * happens to hold a valid token.
 *
 * @returns {import('express').RequestHandler}
 */
export function rejectLegacyAuthorityFields() {
  return function legacyFieldGate(req, _res, next) {
    const body = req.body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const field of LEGACY_AUTHORITY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, field)) {
          next(
            new WalkieError(
              'invalid_request',
              `${field} is no longer accepted: identity and authority come from the capability ` +
                'token, never from the request body',
              { field }
            )
          );
          return;
        }
      }
    }
    next();
  };
}
