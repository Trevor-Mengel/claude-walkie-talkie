/**
 * Wiring for the MCP server's side of the transport.
 *
 * What changed from v0.2: there is no `server.port` file and no `http://127.0.0.1:<port>` base
 * URL. The client resolves the namespace that owns its working directory, reads that
 * namespace's config, and connects to that namespace's Unix socket. It cannot reach another
 * namespace's service, and it never starts one.
 *
 * The bearer token lives in `tokenBox`, written only by the capability holder and read only by
 * the HTTP client. Nothing here returns it.
 */

import { createApiClient } from '../client/api.js';
import { resolveClientContext } from '../client/context.js';
import { openEventStream } from '../client/events.js';
import { createCapabilityHolder } from './capability.js';

/**
 * Wrap every API method so a single `unauthenticated` answer invalidates the whole process's
 * authority state. Without this, one route rejecting the bearer while others still accept a
 * cached identity is exactly the v0.2 split-brain.
 *
 * @template T
 * @param {T} api
 * @param {() => void} onUnauthenticated
 * @returns {T}
 */
function guardApi(api, onUnauthenticated) {
  const guarded = {};
  for (const [key, value] of Object.entries(api)) {
    if (typeof value !== 'function') {
      guarded[key] = value;
      continue;
    }
    guarded[key] = async (...args) => {
      try {
        return await value(...args);
      } catch (err) {
        if (err?.code === 'unauthenticated') onUnauthenticated();
        throw err;
      }
    };
  }
  return /** @type {T} */ (guarded);
}

/**
 * Build the client stack for one MCP server process.
 *
 * @param {string} cwd a directory inside the namespace's registered root
 * @param {{env?:Record<string,string|undefined>, runtimeRoot?:string}} [opts]
 */
export function clientForRoot(cwd, { env = process.env, runtimeRoot } = {}) {
  const context = resolveClientContext({ cwd, env, runtimeRoot });
  const tokenBox = { value: null };
  const raw = createApiClient({
    endpoint: context.endpoint,
    namespace: context.namespace,
    mode: context.mode,
    token: () => tokenBox.value
  });

  /** @type {ReturnType<typeof createCapabilityHolder>} */
  let capability;
  const api = guardApi(raw, () => capability?.noteUnauthenticated());
  capability = createCapabilityHolder({
    api: raw,
    tokenBox,
    namespace: context.namespace,
    env
  });

  return {
    context,
    api,
    capability,
    /**
     * Subscribe to the channel feed with this session's credential.
     * @param {(name:string, data:unknown)=>void} onEvent
     * @param {(err:Error)=>void} [onError]
     */
    events: (onEvent, onError) =>
      openEventStream({
        endpoint: context.endpoint,
        token: tokenBox.value,
        context: { namespace: context.namespace, mode: context.mode },
        onEvent,
        onError
      })
  };
}
