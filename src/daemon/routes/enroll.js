import { Router } from 'express';
import { collabcastError } from '../../identity/errors.js';
import { exchangeEnrollmentCode } from '../../authority/enroll.js';
import { scopesForRole } from '../../authority/policy.js';
import { createPrincipal } from '../../store/principals.js';
import { getCapability, issueCapability } from '../../store/capabilities.js';
import { audit } from '../../store/audit.js';
import { requireScope } from '../auth.js';
import { handler, readBody } from './support.js';

const EXCHANGE_FIELDS = ['enrollmentCode'];
const DELEGATE_FIELDS = ['role', 'scopes', 'ttlSeconds', 'paseoAgentId'];

/** A root capability may only hand down a working identity, never another root. */
const DELEGABLE_ROLES = Object.freeze(['goal_hub', 'listener']);

/**
 * Roles whose capability may act as a delegation PARENT.
 *
 * `root` is the agent path: enrolled through an approval dialog, then handing down narrower
 * identities. `operator` is the human path: `collabcast enroll --recovery` is documented as
 * minting a capability directly from the operator credential, and it reaches this same route —
 * so while this list said `root` alone, the only break-glass command in the product answered
 * `forbidden` to the only credential it is supposed to use.
 *
 * Widening stops here. Every narrowing rule still holds: `issueCapability` refuses a child that
 * outlives or out-scopes its parent, and `DELEGABLE_ROLES` above means neither parent can mint
 * another root or another operator.
 */
const DELEGATING_ROLES = Object.freeze(['root', 'operator']);

/**
 * Bootstrap. **Mounted before authentication** — this route is how a client that
 * holds no capability gets one, so requiring a capability here would be circular.
 *
 * Authority comes from the enrolment code, which exists only because a human
 * confirmed an OMP hook dialog. The code is one-use and short-lived, and every
 * way it can fail collapses to the same opaque refusal so a caller cannot probe
 * which codes exist. All of that lives in `src/authority/enroll.js`; this route
 * is purely the HTTP skin.
 *
 * The token appears in this response body and nowhere else — never in a log, never in
 * an audit detail (`redactDetail` replaces any `*Token`-keyed value with '[redacted]').
 *
 * @param {{store:object}} deps
 */
export function enrollRoutes({ store } = {}) {
  if (!store) throw new Error('enrollRoutes requires a store');
  const router = Router();

  router.post(
    '/enroll/exchange',
    handler(async (req, res) => {
      const fields = readBody(req.body, EXCHANGE_FIELDS);
      const result = exchangeEnrollmentCode(store, fields.enrollmentCode);
      res.status(201).json({
        token: result.token,
        capabilityId: result.capabilityId,
        principalId: result.principalId,
        role: result.role,
        scopes: result.scopes,
        expiresAt: result.expiresAt
      });
    })
  );

  return router;
}

/**
 * Delegation: a root or operator capability mints a narrower one for a new principal.
 *
 * Every narrowing rule is enforced by `issueCapability` against the parent row
 * — scopes may only shrink, expiry may only shorten — so a widened request is
 * refused by the store, not by a check a route could forget. On top of that the
 * requested role must be delegable and its scopes must fit the role's
 * allowlist, so a `listener` cannot be handed `channel:publish` even if the
 * parent holds it.
 *
 * @param {{store:object, namespace:string}} deps
 */
export function delegateRoutes({ store, namespace } = {}) {
  if (!store) throw new Error('delegateRoutes requires a store');
  const router = Router();

  router.post(
    '/delegate',
    requireScope('enroll:delegate'),
    handler(async (req, res) => {
      const { principal: parentPrincipal, capability: parentCapability } = req.collabcast;
      // The scope is the authority; the role check is a second, independent
      // fence so a mis-issued capability cannot delegate on its own.
      if (!DELEGATING_ROLES.includes(parentPrincipal.role)) {
        throw collabcastError('forbidden', 'only a root or operator principal may delegate', {
          role: parentPrincipal.role
        });
      }

      const fields = readBody(req.body, DELEGATE_FIELDS);
      const role = fields.role;
      if (!DELEGABLE_ROLES.includes(role)) {
        throw collabcastError('invalid_request', 'role must be goal_hub or listener', {
          role: String(role)
        });
      }
      if (!Array.isArray(fields.scopes) || fields.scopes.length === 0) {
        throw collabcastError('invalid_request', 'scopes must be a non-empty array');
      }
      const ttlSeconds = fields.ttlSeconds;
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
        throw collabcastError('invalid_request', 'ttlSeconds must be a positive integer');
      }
      const paseoAgentId =
        fields.paseoAgentId === undefined || fields.paseoAgentId === null
          ? null
          : fields.paseoAgentId;
      if (paseoAgentId !== null && typeof paseoAgentId !== 'string') {
        throw collabcastError('invalid_request', 'paseoAgentId must be a string');
      }

      const scopes = [...new Set(fields.scopes)];
      const allowed = new Set(scopesForRole(role));
      const outside = scopes.filter((scope) => !allowed.has(scope));
      if (outside.length > 0) {
        throw collabcastError('forbidden', 'scopes exceed the role allowlist', { scopes: outside });
      }

      const issued = store.tx((tx) => {
        const child = createPrincipal(tx, { role, displayAlias: null, paseoAgentId });
        const { capabilityId, token } = issueCapability(tx, {
          principalId: child.id,
          scopes,
          ttlSeconds,
          attestationKind: 'delegation',
          attestationRef: parentCapability.id,
          parentCapabilityId: parentCapability.id
        });
        const capability = getCapability(tx, capabilityId);
        audit(tx, {
          namespace,
          actorPrincipalId: parentPrincipal.id,
          action: 'capability.delegated',
          subject: capabilityId,
          outcome: 'issued',
          detail: {
            role,
            scopes: capability.scopes,
            principalId: child.id,
            parentCapabilityId: parentCapability.id
          }
        });
        return { token, capability, child };
      });

      res.status(201).json({
        token: issued.token,
        capabilityId: issued.capability.id,
        principalId: issued.child.id,
        role: issued.child.role,
        scopes: issued.capability.scopes,
        expiresAt: issued.capability.expiresAt
      });
    })
  );

  return router;
}
