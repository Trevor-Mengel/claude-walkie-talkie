import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CollabcastError, describeValue } from './errors.js';
import { NAMESPACE_RE, isNamespace } from './namespace.js';
import { canonicalizePath, requireAbsolutePath } from './paths.js';

export const COLLABCAST_DIRNAME = '.collabcast';
export const IDENTITIES_FILENAME = 'identities.json';
export const IDENTITIES_SCHEMA_VERSION = 1;

const ENTRY_KEYS = ['canonicalRoot', 'registrations', 'paseoProjectKey'];
const ROOT_KEYS = ['schemaVersion', 'identities'];

/**
 * Resolves where the host identity map lives.
 *
 * Precedence: `COLLABCAST_IDENTITIES` (explicit file) → `$COLLABCAST_HOME/.collabcast/identities.json`
 * → `~/.collabcast/identities.json`.
 *
 * @param {{env?:Record<string,string|undefined>}} [opts]
 * @returns {{path:string, origin:'COLLABCAST_IDENTITIES'|'COLLABCAST_HOME'|'home'}}
 */
export function identitiesPath({ env = process.env } = {}) {
  if (env.COLLABCAST_IDENTITIES) {
    return { path: resolve(env.COLLABCAST_IDENTITIES), origin: 'COLLABCAST_IDENTITIES' };
  }
  const home = env.COLLABCAST_HOME ? resolve(env.COLLABCAST_HOME) : env.HOME || homedir();
  return {
    path: join(home, COLLABCAST_DIRNAME, IDENTITIES_FILENAME),
    origin: env.COLLABCAST_HOME ? 'COLLABCAST_HOME' : 'home'
  };
}

function invalid(message, detail) {
  return new CollabcastError('config_invalid', message, detail);
}

function defaultWarn(message) {
  console.warn(`collabcast: ${message}`);
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object (got ${describeValue(value)})`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalid(`unknown key ${JSON.stringify(key)} in ${label}`, { key, allowed });
    }
  }
}

/**
 * Validates and normalizes a parsed identity map.
 *
 * Guarantees on success:
 *  - `schemaVersion === 1`
 *  - every namespace key matches NAMESPACE_RE
 *  - every path is absolute, canonicalized, and deduplicated
 *  - every `canonicalRoot` also appears in its own `registrations`
 *  - no path is registered under two different namespaces
 *
 * @param {unknown} raw
 * @param {{source?:string}} [opts]
 * @returns {{schemaVersion:number, source:string, identities:Record<string,{namespace:string,
 *   canonicalRoot:string, registrations:string[], paseoProjectKey:string|null}>}}
 */
export function parseIdentities(raw, { source = '<inline>' } = {}) {
  requirePlainObject(raw, 'identity map');
  rejectUnknownKeys(raw, ROOT_KEYS, 'identity map');
  if (raw.schemaVersion !== IDENTITIES_SCHEMA_VERSION) {
    throw invalid(
      `identity map schemaVersion must be ${IDENTITIES_SCHEMA_VERSION} ` +
        `(got ${describeValue(raw.schemaVersion)})`
    );
  }
  requirePlainObject(raw.identities, 'identities');

  /** @type {Map<string,string>} canonical path → owning namespace */
  const owners = new Map();
  const identities = {};

  for (const [namespace, entryRaw] of Object.entries(raw.identities)) {
    if (!isNamespace(namespace)) {
      throw invalid(`identity key ${describeValue(namespace)} must match ${NAMESPACE_RE.source}`, {
        namespace
      });
    }
    const entry = requirePlainObject(entryRaw, `identities.${namespace}`);
    rejectUnknownKeys(entry, ENTRY_KEYS, `identities.${namespace}`);

    const canonicalRoot = requireAbsolutePath(
      entry.canonicalRoot,
      `identities.${namespace}.canonicalRoot`
    );

    if (!Array.isArray(entry.registrations) || entry.registrations.length === 0) {
      throw invalid(
        `identities.${namespace}.registrations must be a non-empty array of absolute paths`
      );
    }
    const registrations = [];
    entry.registrations.forEach((value, i) => {
      const abs = requireAbsolutePath(value, `identities.${namespace}.registrations[${i}]`);
      if (!registrations.includes(abs)) registrations.push(abs);
    });

    if (!registrations.includes(canonicalRoot)) {
      throw invalid(
        `identities.${namespace}.canonicalRoot must also be listed in ` +
          `identities.${namespace}.registrations`,
        { namespace, canonicalRoot }
      );
    }

    for (const path of registrations) {
      const previous = owners.get(path);
      if (previous !== undefined && previous !== namespace) {
        throw invalid(
          `path is registered under two namespaces: ${previous} and ${namespace} (${path})`,
          { path, namespaces: [previous, namespace] }
        );
      }
      owners.set(path, namespace);
    }

    let paseoProjectKey = null;
    if (entry.paseoProjectKey !== undefined && entry.paseoProjectKey !== null) {
      if (typeof entry.paseoProjectKey !== 'string' || entry.paseoProjectKey.length === 0) {
        throw invalid(
          `identities.${namespace}.paseoProjectKey must be a non-empty string when present ` +
            `(got ${describeValue(entry.paseoProjectKey)})`
        );
      }
      paseoProjectKey = entry.paseoProjectKey;
    }

    identities[namespace] = Object.freeze({
      namespace,
      canonicalRoot,
      registrations: Object.freeze(registrations),
      paseoProjectKey
    });
  }

  return Object.freeze({
    schemaVersion: IDENTITIES_SCHEMA_VERSION,
    source,
    identities: Object.freeze(identities)
  });
}

/**
 * Reads, mode-checks, and validates the host identity map.
 *
 * A missing or unreadable map is a host misconfiguration (`config_invalid`), not a resolution
 * failure — there is no implicit default map.
 *
 * @param {{env?:Record<string,string|undefined>, onWarn?:(msg:string)=>void}} [opts]
 */
export function loadIdentities({ env = process.env, onWarn = defaultWarn } = {}) {
  const { path, origin } = identitiesPath({ env });
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw invalid(`no collabcast identity map found (located via ${origin}): ${path}`, {
      path,
      origin
    });
  }
  if (!stat.isFile()) {
    throw invalid(`collabcast identity map is not a regular file: ${path}`, { path, origin });
  }
  // Writable and readable are different questions here, and the single 0o077 check conflated
  // them.
  //
  // This map decides which `canonicalRoot` a namespace resolves to, and therefore where the
  // config, the store and the socket live. Someone who can WRITE it repoints a namespace at a
  // tree they control and every later resolution believes them: integrity, and a refusal, since
  // a warning on stderr scrolls past while the process carries on trusting the map anyway.
  //
  // Someone who can merely READ it learns a directory path that anyone able to `ls` the checkout
  // already knows. There is no confidentiality here to protect — this file holds paths, not
  // values — so a refusal would buy nothing and would brick a boot on a map that arrived at 0644
  // from an older version, a copy, a restore, or a plain umask. That stays a warning. Contrast
  // `readSecretFile` and `readOperatorCredential`, which do refuse on the wider mask: those hold
  // secret VALUES, where readable IS the vulnerability. Same bits, different threat.
  const mode = stat.mode & 0o777;
  if ((mode & 0o022) !== 0) {
    throw invalid(
      `collabcast identity map is group/other-writable (mode 0${mode.toString(8)}): ${path} — ` +
        `anyone who can write it can repoint a namespace; run \`chmod 600 ${path}\` and retry`,
      { path, origin, mode: mode.toString(8) }
    );
  }
  if ((mode & 0o044) !== 0) {
    onWarn(
      `identity map is group/other-readable (mode 0${mode.toString(8)}); ` +
        `tighten it with \`chmod 600 ${path}\``
    );
  }

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw invalid(`collabcast identity map is unreadable: ${path} (${err.code || 'read error'})`, {
      path
    });
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw invalid(`collabcast identity map is not valid JSON: ${err.message}`, { path });
  }

  return parseIdentities(raw, { source: canonicalizePath(path) });
}
