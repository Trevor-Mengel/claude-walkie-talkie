import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Locating the project a client is running inside.
 *
 * `ensureDaemon` used to live here and was called on every MCP server launch, spawning a
 * detached, unsupervised daemon as a side effect of a client starting. It is gone: execution
 * belongs to the supervisor, a client only connects. Nothing in this package starts a service
 * except `collabcast start`, and that only in standalone mode.
 */

/**
 * The nearest ancestor directory holding a `.collabcast/`, or `COLLABCAST_PROJECT_ROOT` when set.
 * Namespace ownership is decided afterwards by `resolveNamespace`; this only finds the tree.
 *
 * @param {{env?:Record<string,string|undefined>, cwd?:string}} [opts]
 * @returns {string}
 */
export function findProjectRoot({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.COLLABCAST_PROJECT_ROOT) return resolve(env.COLLABCAST_PROJECT_ROOT);
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(`${dir}/.collabcast`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('no .collabcast/ found walking up from ' + cwd);
    }
    dir = parent;
  }
}
