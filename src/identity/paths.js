import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { CollabcastError, describeValue } from './errors.js';

/**
 * Resolves a path to its physical form, symlinks included, without requiring it to exist.
 *
 * This matters because git reports physical paths (`/private/var/...` on macOS) while
 * configuration and `mkdtemp` hand out logical ones (`/var/...`). Prefix matching between the
 * two only works if both sides are canonicalized the same way.
 *
 * @param {string} p
 * @returns {string} absolute, physical where the filesystem can tell us
 */
export function canonicalizePath(p) {
  const abs = resolve(p);
  let head = abs;
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * True when `child` lies strictly below `parent`. Equal paths are not "inside".
 * Both arguments must already be canonicalized.
 * @param {string} child
 * @param {string} parent
 */
export function isInside(child, parent) {
  if (child === parent) return false;
  const base = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(base);
}

/** True when `outer` equals `inner` or contains it. Both must be canonicalized. */
export function containsOrEquals(outer, inner) {
  return outer === inner || isInside(inner, outer);
}

/**
 * @param {unknown} value
 * @param {string} label - dotted config path, used verbatim in the error message
 * @param {{code?:string}} [opts]
 * @returns {string} canonicalized absolute path
 */
export function requireAbsolutePath(value, label, opts = {}) {
  const { code = 'config_invalid' } = opts;
  if (typeof value !== 'string' || value.length === 0) {
    throw new CollabcastError(
      code,
      `${label} must be a non-empty string (got ${describeValue(value)})`
    );
  }
  if (!isAbsolute(value)) {
    throw new CollabcastError(code, `${label} must be an absolute path (got ${describeValue(value)})`);
  }
  return canonicalizePath(value);
}
