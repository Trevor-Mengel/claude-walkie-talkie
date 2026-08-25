/**
 * Where the authority keeps its runtime credentials and its operator socket.
 *
 * Both live in one directory clamped to 0700, because the *directory* is the real
 * access gate: a Unix socket's own mode is applied after `listen()` returns, so a
 * strict parent directory is what closes the window. The files inside are 0600 too,
 * belt and braces.
 *
 * Every resolver accepts an explicit override and returns it untouched, so an
 * operator-supplied path (env var, config, CLI flag) flows through one code path
 * instead of being re-derived per caller.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { WalkieError } from '../identity/errors.js';
import { walkieDir } from '../config/schema.js';

/** `<canonicalRoot>/.walkie-talkie/run` */
export const RUNTIME_DIRNAME = 'run';
export const SOCKET_FILENAME = 'authority.sock';
export const SECRET_FILENAME = 'hook.secret';

export const RUNTIME_DIR_MODE = 0o700;
export const RUNTIME_FILE_MODE = 0o600;

/** Env var naming an out-of-tree runtime directory (used by the test isolation harness). */
export const RUNTIME_ROOT_ENV = 'WALKIE_RUNTIME_ROOT';

/**
 * AF_UNIX `sun_path` is a fixed-size field — 104 bytes on Darwin/BSD, 108 on Linux,
 * NUL included — and `bind()` fails with ENAMETOOLONG rather than truncating. Reject
 * an unbindable path up front with a message that says why.
 */
export const MAX_SOCKET_PATH_BYTES = process.platform === 'linux' ? 107 : 103;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireAbsolute(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WalkieError('config_invalid', `${label} must be a non-empty absolute path`);
  }
  if (!isAbsolute(value)) {
    throw new WalkieError('config_invalid', `${label} must be an absolute path`);
  }
  return value;
}

/**
 * The authority's runtime directory: the one place both this socket and the HTTP
 * transport socket live, so they can never drift into separate directories with
 * separate permissions.
 *
 * Precedence: explicit override, then `WALKIE_RUNTIME_ROOT`, then
 * `<canonicalRoot>/.walkie-talkie/run`. The env var exists because a deep checkout
 * plus the in-tree default can exceed the AF_UNIX path limit, and because the test
 * harness pins every runtime location to a disposable directory.
 *
 * @param {string} canonicalRoot
 * @param {string} [override] an operator-supplied directory, returned verbatim
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function authorityRuntimeDir(canonicalRoot, override, env = process.env) {
  if (override !== undefined) return requireAbsolute(override, 'authority runtime directory');
  const fromEnv = env?.[RUNTIME_ROOT_ENV];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return requireAbsolute(fromEnv, RUNTIME_ROOT_ENV);
  }
  return join(walkieDir(requireAbsolute(canonicalRoot, 'canonicalRoot')), RUNTIME_DIRNAME);
}

/**
 * The operator-hook enrollment socket. This is NOT the HTTP transport socket
 * (`walkie.sock`); it carries only `enroll.request`.
 *
 * @param {string} runtimeRoot
 * @param {string} [override]
 * @returns {string}
 */
export function authoritySocketPath(runtimeRoot, override) {
  if (override !== undefined) return requireAbsolute(override, 'authority socket path');
  return join(requireAbsolute(runtimeRoot, 'runtimeRoot'), SOCKET_FILENAME);
}

/**
 * The shared secret file the OMP hook authenticates with.
 *
 * @param {string} runtimeRoot
 * @param {string} [override]
 * @returns {string}
 */
export function hookSecretPath(runtimeRoot, override) {
  if (override !== undefined) return requireAbsolute(override, 'hook secret path');
  return join(requireAbsolute(runtimeRoot, 'runtimeRoot'), SECRET_FILENAME);
}

/**
 * Creates (and re-clamps) the runtime directory. Idempotent, and it re-applies
 * the mode on every call so a directory loosened out of band is tightened again
 * before we put a credential in it.
 *
 * @param {string} runtimeRoot
 * @returns {string} the directory
 */
export function ensureRuntimeDir(runtimeRoot) {
  const dir = requireAbsolute(runtimeRoot, 'runtimeRoot');
  mkdirSync(dir, { recursive: true, mode: RUNTIME_DIR_MODE });
  chmodSync(dir, RUNTIME_DIR_MODE);
  return dir;
}

/**
 * Rejects a socket path the kernel would refuse to bind.
 * @param {string} socketPath
 */
export function assertBindablePath(socketPath) {
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new WalkieError(
      'config_invalid',
      'the authority socket path is too long for a unix domain socket',
      { bytes, maxBytes: MAX_SOCKET_PATH_BYTES }
    );
  }
  return socketPath;
}
