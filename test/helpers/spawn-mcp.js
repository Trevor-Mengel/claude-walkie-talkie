// Launching `bin/collabcast-mcp.js` as a child process.
//
// Two v0.2 inputs are gone and must not be reintroduced here:
//
//   - `COLLABCAST_TOOL` / `COLLABCAST_ALIAS`. They were identity: the child declared "I am claude-code
//     called demo-builder" and the daemon believed it. Identity now comes from `GET /self`,
//     resolved from the bearer token, so there is nothing for an env var to assert.
//   - the auto-started daemon. `createMcpServer` no longer calls `ensureDaemon`, so a child
//     spawned against a dead socket stays up, unenrolled, and says so. The caller boots a
//     service first (see `createStack`) or is testing that refusal on purpose.
//
// What the child DOES read is `COLLABCAST_CAPABILITY`: a supervisor-injected credential, either a
// bare token or the document `POST /enroll/exchange` returns. Only its `token` field is
// authority; everything else is re-resolved from the service.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MCP_BIN = join(__dirname, '..', '..', 'bin', 'collabcast-mcp.js');

/**
 * Serialise a capability for `COLLABCAST_CAPABILITY`. A string is passed through as a bare token; an
 * object is JSON-encoded, which is the other form `parseCredential` accepts.
 *
 * @param {string|object|null|undefined} capability
 * @returns {string|undefined}
 */
export function encodeCapability(capability) {
  if (capability === null || capability === undefined) return undefined;
  return typeof capability === 'string' ? capability : JSON.stringify(capability);
}

/**
 * Spawn the MCP server child with an explicit environment.
 *
 * @param {object} opts
 * @param {Record<string,string>} opts.env a complete, isolated child environment
 * @param {string} [opts.cwd] defaults to the project root named by `COLLABCAST_PROJECT_ROOT`
 * @param {string|object} [opts.capability] injected as `COLLABCAST_CAPABILITY`
 */
export function spawnMcp({ env, cwd, capability } = {}) {
  if (!env) throw new Error('spawnMcp requires an isolated env');
  const encoded = encodeCapability(capability);
  const childEnv = { ...env };
  if (encoded === undefined) delete childEnv.COLLABCAST_CAPABILITY;
  else childEnv.COLLABCAST_CAPABILITY = encoded;

  return spawn(process.execPath, [MCP_BIN], {
    cwd: cwd ?? childEnv.COLLABCAST_PROJECT_ROOT,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}
