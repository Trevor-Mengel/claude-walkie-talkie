import { channelRoutes } from './channel.js';
import { inboxRoutes } from './inbox.js';
import { cursorRoutes } from './cursor.js';
import { principalsRoutes } from './principals.js';
import { enrollRoutes, delegateRoutes } from './enroll.js';
import { capabilityRoutes } from './capability.js';
import { eventsRoutes } from './events.js';

export { channelRoutes } from './channel.js';
export { inboxRoutes } from './inbox.js';
export { cursorRoutes } from './cursor.js';
export { principalsRoutes } from './principals.js';
export { enrollRoutes, delegateRoutes } from './enroll.js';
export { capabilityRoutes } from './capability.js';
export { eventsRoutes } from './events.js';

/**
 * The daemon's complete route inventory, split by whether a router may be
 * reached without a capability.
 *
 * `publicRouters` mount before authentication and contain exactly one thing:
 * the enrolment exchange, which is how a caller with no credential acquires
 * one. Everything else is behind `requireCapability`.
 *
 * This barrel exists so the composition root can stay ignorant of the route
 * list — `src/daemon/server.js` and `src/daemon/daemon-entry.js` import only
 * this function, so adding or removing a route never touches the transport.
 *
 * Removed in v0.3 and deliberately absent (they answer 404):
 *   GET/POST /permits, DELETE /permits/:sessionId  — permits are store rows now
 *   POST /sessions/join                            — identity needs attestation
 *   POST /sessions/:id/rename                      — see POST /self/alias
 *   POST /sessions/invite, GET /sessions           — see GET /principals
 *   GET  /sessions/:id/inbox                       — see GET /inbox
 *
 * @param {{store:object, config:object, namespace:string, channelPath:string,
 *          events?:object}} deps
 * @returns {{publicRouters:object[], routers:object[]}}
 */
export function buildRouters(deps) {
  return {
    publicRouters: [enrollRoutes(deps)],
    routers: [
      channelRoutes(deps),
      inboxRoutes(deps),
      cursorRoutes(deps),
      principalsRoutes(deps),
      delegateRoutes(deps),
      capabilityRoutes(deps),
      eventsRoutes(deps)
    ]
  };
}
