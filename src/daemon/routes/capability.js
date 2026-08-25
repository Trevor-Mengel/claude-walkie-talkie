import { Router } from 'express';
import { walkieError } from '../../identity/errors.js';
import { getCapability, revokeCapability } from '../../store/capabilities.js';
import { audit } from '../../store/audit.js';
import { handler } from './support.js';

/**
 * Revocation.
 *
 * Two callers may revoke a capability: an operator (incident response) and the
 * capability's own principal (a client cleaning up its own credential on exit).
 * No scope gates this — revocation only ever removes authority, so a narrowly
 * scoped client must still be able to hand its own credential back. What is
 * gated is *whose* capability: anything else is `forbidden`.
 *
 * `revokeCapability` cascades over the derivation closure, so revoking a root
 * capability also kills everything it delegated. That is the point: a leaked
 * parent cannot be contained by revoking it alone.
 *
 * @param {{store:object, namespace:string}} deps
 */
export function capabilityRoutes({ store, namespace } = {}) {
  if (!store) throw new Error('capabilityRoutes requires a store');
  const router = Router();

  router.delete(
    '/capability/:id',
    handler(async (req, res) => {
      const principal = req.walkie.principal;
      const id = req.params.id;
      const target = getCapability(store, id);
      // A capability that does not exist and one belonging to another namespace
      // are the same answer: `not_found`, so revocation cannot be used to probe
      // which capability ids are live.
      if (!target) throw walkieError('not_found', 'capability not found', { id });

      const isSelf = target.principalId === principal.id;
      const isOperator = principal.role === 'operator';
      if (!isSelf && !isOperator) {
        audit(store, {
          namespace,
          actorPrincipalId: principal.id,
          action: 'capability.revoke',
          subject: id,
          outcome: 'denied',
          detail: { reason: 'not_owner' }
        });
        throw walkieError('forbidden', 'only an operator or the holder may revoke a capability', {
          id
        });
      }

      // One transaction. The revocation and the row that records it are the same
      // fact: committing the revocation while the audit INSERT throws would
      // render a 500 — telling the client the revocation failed — over a
      // capability that is already dead, with no evidence anywhere of who killed
      // it. Either both land or neither does.
      store.tx((tx) => {
        revokeCapability(tx, id, isSelf ? 'self-revoked' : 'operator-revoked');
        audit(tx, {
          namespace,
          actorPrincipalId: principal.id,
          action: 'capability.revoke',
          subject: id,
          outcome: 'revoked',
          detail: { self: isSelf }
        });
      });
      res.json({ ok: true });
    })
  );

  return router;
}
