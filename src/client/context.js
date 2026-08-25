/**
 * Resolving "which service do I talk to" for a client process.
 *
 * A client never guesses. It resolves the namespace that owns its cwd (Wave A), loads that
 * namespace's validated config, and derives the transport endpoint from the same helper the
 * listener binds with — so a client can only ever reach the service for the namespace that
 * genuinely owns its working directory.
 */

import { loadConfig } from '../config/load.js';
import { resolveNamespace } from '../identity/resolve.js';
import { resolveTransportPaths } from '../daemon/transport.js';

/**
 * @typedef {object} ClientContext
 * @property {string} namespace
 * @property {string} canonicalRoot
 * @property {object} config effective, validated config
 * @property {'managed'|'standalone'} mode
 * @property {string} runtimeRoot
 * @property {string} socketPath
 * @property {string} authoritySocketPath
 * @property {{socketPath?:string, host?:string, port?:number}} endpoint
 */

/**
 * Resolve everything a client needs to reach its namespace's service.
 *
 * `endpoint` prefers the Unix socket. Loopback TCP is used only when the config both disabled
 * the Unix socket and enabled TCP — a deliberately awkward combination, because TCP is the
 * weaker claim.
 *
 * @param {{cwd?:string, env?:Record<string,string|undefined>, runtimeRoot?:string}} [opts]
 * @returns {ClientContext}
 */
export function resolveClientContext({ cwd = process.cwd(), env = process.env, runtimeRoot } = {}) {
  const { namespace, canonicalRoot } = resolveNamespace({ cwd, env });
  const config = loadConfig({ canonicalRoot, expectNamespace: namespace });
  const paths = resolveTransportPaths({ canonicalRoot, config, runtimeRoot, env });

  const endpoint = config.transport.unixSocket
    ? { socketPath: paths.socketPath }
    : { host: config.transport.tcp.host, port: config.transport.tcp.port };

  return Object.freeze({
    namespace,
    canonicalRoot,
    config,
    mode: config.mode,
    runtimeRoot: paths.runtimeRoot,
    socketPath: paths.socketPath,
    authoritySocketPath: paths.authoritySocketPath,
    endpoint: Object.freeze(endpoint)
  });
}
