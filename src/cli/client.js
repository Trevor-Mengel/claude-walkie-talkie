/**
 * The operator CLI's side of the transport.
 *
 * The operator is a principal like any other. v0.2's CLI asserted `fromSessionId: 'operator'`
 * in request bodies — a string anyone could send — and read nothing but a port file. Here the
 * CLI authenticates with a real capability read from `<runtimeRoot>/operator.cred` (0600) and
 * connects over the namespace's Unix socket.
 */

import { createApiClient } from '../client/api.js';
import { resolveClientContext } from '../client/context.js';
import { credentialDrift, readOperatorCredential } from '../client/credentials.js';
import { openEventStream } from '../client/events.js';

/**
 * Context + endpoint only, with no credential. Used by commands that either need no authority
 * (`GET /health`) or need to report on the local installation.
 *
 * @param {{cwd?:string, env?:Record<string,string|undefined>, runtimeRoot?:string}} [opts]
 */
export function contextForProject({ cwd = process.cwd(), env = process.env, runtimeRoot } = {}) {
  return resolveClientContext({ cwd, env, runtimeRoot });
}

/**
 * An authenticated client for the operator principal.
 *
 * @param {{cwd?:string, env?:Record<string,string|undefined>, runtimeRoot?:string}} [opts]
 * @returns {{context:object, api:object, claimed:Record<string,unknown>|null,
 *   events:(onEvent:Function,onError?:Function)=>Promise<{close:()=>void}>}}
 */
export function clientForProject({ cwd = process.cwd(), env = process.env, runtimeRoot } = {}) {
  const context = resolveClientContext({ cwd, env, runtimeRoot });
  const credential = readOperatorCredential(context.runtimeRoot);
  const api = createApiClient({
    endpoint: context.endpoint,
    namespace: context.namespace,
    mode: context.mode,
    token: () => credential.token
  });
  return {
    context,
    api,
    claimed: credential.claimed,
    events: (onEvent, onError) =>
      openEventStream({
        endpoint: context.endpoint,
        token: credential.token,
        context: { namespace: context.namespace, mode: context.mode },
        onEvent,
        onError
      })
  };
}

/**
 * `GET /self` plus a drift note. The server is authoritative about role, scopes and expiry; a
 * credential document that disagrees is stale and worth saying out loud.
 *
 * @param {{api:object, claimed:Record<string,unknown>|null, context:object}} client
 */
export async function resolveSelf({ api, claimed, context }) {
  const self = await api.self();
  const drift = credentialDrift(claimed, self);
  if (claimed?.namespace !== undefined && claimed.namespace !== context.namespace) {
    drift.push('namespace');
  }
  return { self, drift: drift.sort() };
}
