import { Router } from 'express';
import { collabcastError } from '../../identity/errors.js';
import { listPrincipals, setAlias } from '../../store/principals.js';
import { audit } from '../../store/audit.js';
import { requireScope } from '../auth.js';
import { handler, readBody, toolForRole } from './support.js';

const ALIAS_FIELDS = ['alias'];

/**
 * Replaces v0.2's `src/daemon/routes/sessions.js` wholesale.
 *
 * That file exposed `POST /sessions/join` (mint an identity by asking, with no
 * attestation), `POST /sessions/:id/rename` (rename ANY session by naming it in
 * the path — including renaming an incumbent out of the way to steal its alias),
 * `POST /sessions/invite` and `GET /sessions/:id/inbox`. All four are gone.
 * Identity is now minted only by `POST /enroll/exchange` against a
 * human-approved enrolment code, and an alias only ever moves on its own
 * principal via `POST /self/alias`.
 *
 * @param {{store:object, namespace:string}} deps
 */
export function principalsRoutes({ store, namespace } = {}) {
  if (!store) throw new Error('principalsRoutes requires a store');
  const router = Router();

  /**
   * The roster. Presentation only: id, role, alias, creation time.
   *
   * Never a token, never a token hash, and never `paseoAgentId` — that field
   * names an external Paseo agent and correlating it to a collabcast principal is
   * exactly the cross-system linkage the roster must not hand out.
   */
  router.get(
    '/principals',
    requireScope('channel:read'),
    handler(async (_req, res) => {
      const principals = listPrincipals(store).map((p) => ({
        id: p.id,
        role: p.role,
        displayAlias: p.displayAlias,
        createdAt: p.createdAt
      }));
      res.json({ principals });
    })
  );

  /**
   * Who am I?
   *
   * A bearer token is opaque, so without this route a client cannot learn which
   * principal it is, what it may do, or when its capability dies — it would have
   * to cache that from an injected document, which goes stale the instant a
   * capability is renewed, narrowed or revoked. Everything here is read off the
   * live capability record, so the server stays authoritative about authority.
   *
   * Requires authentication and nothing more: a capability may always describe
   * itself. Emits no token, no hash and no `paseoAgentId`.
   */
  router.get(
    '/self',
    handler(async (req, res) => {
      const { principal, capability } = req.collabcast;
      res.json({
        principalId: principal.id,
        role: principal.role,
        displayAlias: principal.displayAlias,
        tool: toolForRole(principal.role),
        scopes: [...capability.scopes],
        capabilityId: capability.id,
        expiresAt: capability.expiresAt
      });
    })
  );

  /**
   * Renames the caller — and only the caller.
   *
   * A collision returns 409 and leaves the incumbent's alias untouched. v0.2's
   * rename route took the target session id from the path and, on collision,
   * renamed the incumbent out of the way, so an alias could be stolen by anyone
   * who asked for it.
   */
  router.post(
    '/self/alias',
    requireScope('self:alias'),
    handler(async (req, res) => {
      const principal = req.collabcast.principal;
      const alias = readBody(req.body, ALIAS_FIELDS).alias;
      if (typeof alias !== 'string' || alias.trim().length === 0) {
        throw collabcastError('invalid_request', 'alias is required');
      }

      // One transaction for the rename and the row that records it. A committed
      // rename whose audit INSERT threw would answer the client with a 500 about
      // an alias that had in fact moved — and leave no record of the move.
      //
      // The refusal row is deliberately OUTSIDE that transaction: nothing
      // changed, so it has nothing to be atomic with, and writing it inside the
      // failed transaction would roll it straight back out again. If that write
      // fails too the error propagates: an authority decision this route cannot
      // record is a fault, and the alias did not move either way.
      let updated;
      try {
        updated = store.tx((tx) => {
          const next = setAlias(tx, principal.id, alias);
          audit(tx, {
            namespace,
            actorPrincipalId: principal.id,
            action: 'self.alias',
            subject: principal.id,
            outcome: 'allowed',
            detail: { displayAlias: next.displayAlias }
          });
          return next;
        });
      } catch (err) {
        audit(store, {
          namespace,
          actorPrincipalId: principal.id,
          action: 'self.alias',
          subject: principal.id,
          outcome: 'denied',
          detail: { reason: err && err.code }
        });
        throw err;
      }

      res.json({ id: updated.id, displayAlias: updated.displayAlias });
    })
  );

  return router;
}
