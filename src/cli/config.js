import { readFile, writeFile } from 'node:fs/promises';
import { walkieError } from '../identity/errors.js';
import { canonicalizePath } from '../identity/paths.js';
import { configPath, validateConfig } from '../config/schema.js';
import { resolveNamespace } from '../identity/resolve.js';

/**
 * Parse `--set key=value` into a value with a type.
 *
 * The config is typed now — `mode` is an enum, `transport.tcp.enabled` is a boolean,
 * `retention.hotDays` is an integer — so a CLI that only ever wrote strings could not express a
 * valid config at all. JSON literals are honoured, and anything else stays a string.
 */
export function parseAssignment(assignment) {
  const index = String(assignment).indexOf('=');
  if (index <= 0) {
    throw walkieError('invalid_request', 'use --set key=value, e.g. --set mode=standalone');
  }
  const path = assignment.slice(0, index).split('.').filter(Boolean);
  if (path.length === 0) {
    throw walkieError('invalid_request', 'the key in --set key=value may not be empty');
  }
  const raw = assignment.slice(index + 1);
  let value = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // A bare word is a string, which is what an operator means by `--set mode=standalone`.
  }
  return { path, value };
}

function assignDeep(target, path, value) {
  const next = { ...target };
  let cursor = next;
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment];
    cursor[segment] =
      existing !== null && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...existing }
        : {};
    cursor = cursor[segment];
  }
  cursor[path[path.length - 1]] = value;
  return next;
}

/**
 * Show or edit the namespace config.
 *
 * A write is validated against the schema before it lands. v0.2 wrote any key/value pair
 * verbatim, which under a validated schema would leave a config that every client refuses to
 * load — bricking the namespace from a typo.
 */
export async function configCommand(opts = {}) {
  const canonicalRoot = canonicalizePath(process.cwd());
  const path = configPath(canonicalRoot);
  const current = JSON.parse(await readFile(path, 'utf8'));

  if (!opts.set) {
    process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
    return;
  }

  const { path: keyPath, value } = parseAssignment(opts.set);
  const proposed = assignDeep(current, keyPath, value);
  // Validated with the same function the service and every client use, so `walkie config` can
  // never produce something they would reject.
  const { namespace } = resolveNamespace({ cwd: canonicalRoot });
  validateConfig(proposed, { canonicalRoot, expectNamespace: namespace });

  await writeFile(path, `${JSON.stringify(proposed, null, 2)}\n`);
  process.stdout.write(`Set ${keyPath.join('.')} = ${JSON.stringify(value)}\n`);
}
