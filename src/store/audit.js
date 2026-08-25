import { isId } from '../core/ids.js';
import { fail } from './errors.js';
import { now } from './clock.js';

export const REDACTED = '[redacted]';

/**
 * Words that make a key secret-bearing wherever they appear in it. `authorizationHeader`
 * and `hookSecretPath` are both about a secret even though neither ends in one.
 */
const ALWAYS_SECRET_WORDS = new Set([
  'password',
  'passwd',
  'passphrase',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'secret',
  'secrets'
]);

/**
 * Words that make a key secret-bearing only as its HEAD NOUN — the last word, the thing
 * the value *is*. `token` is a secret; `tokenCount` is an integer. `code` is an enrollment
 * code; `errorCode` is a vocabulary term.
 *
 * Each entry maps the noun to the qualifier words that make it safe. A qualifier match is
 * checked against *every* preceding word, so `httpStatusCode` is kept by `status`.
 */
const HEAD_SECRET_WORDS = new Map([
  ['token', new Set()],
  ['tokens', new Set()],
  ['capability', new Set()],
  ['jwt', new Set()],
  ['nonce', new Set()],
  ['signature', new Set()],
  ['signatures', new Set()],
  [
    'code',
    new Set([
      'error',
      'status',
      'exit',
      'http',
      'reason',
      'response',
      'country',
      'currency',
      'language',
      'postal',
      'zip',
      'area',
      'region',
      'mime'
    ])
  ],
  ['codes', new Set(['error', 'status', 'exit', 'http', 'reason', 'response'])],
  [
    'key',
    new Set([
      'cache',
      'sort',
      'map',
      'index',
      'primary',
      'foreign',
      'partition',
      'object',
      'row',
      'group',
      'config'
    ])
  ],
  ['keys', new Set(['cache', 'sort', 'map', 'index', 'primary', 'foreign', 'partition'])]
]);

/**
 * Anything that looks like one of our base64url secrets or any other long opaque blob.
 *
 * The 24-character floor is load-bearing and deliberately sits in the gap between the two
 * shapes we care about: a collabcast secret is 32 bytes base64url == 43 characters, while every
 * store id (`prn_`, `cap_`, `apr_`, `pmt_` + 16 hex) is exactly 20 characters. Ids therefore
 * stay legible in audit rows and secrets do not. Changing the id format past 23 characters
 * would silently start redacting ids, so the boundary is pinned by a test.
 *
 * A MESSAGE id does not fit in that gap: it is a 26-character uppercase Crockford ULID, so
 * it trips this regex. `redact` exempts it below via `isId`, because a message id is public
 * by construction — it is in `channel.md`, in every inbox response, and in the `subject`
 * column of audit rows where nothing redacts it. Redacting it buys nothing and costs the
 * audit trail: a cursor row reading `{requested: '[redacted]', id: '[redacted]'}` cannot
 * tell an operator how far a principal acked, which is the only thing that row exists to
 * say.
 *
 * That exemption cannot leak a secret. Every secret this system mints is 32 bytes base64url
 * == exactly 43 characters — `newSecret` in `./digest.js`, the hook secret in
 * `../authority/secret.js`, the enrollment code — and 43 is not 26. The alphabet is a
 * second, independent fence: Crockford base32 excludes lowercase, `I`, `L`, `O`, `U`, `_`
 * and `-`.
 */
const SECRET_VALUE_RE = /^[A-Za-z0-9_-]{24,}$/;

const MAX_DEPTH = 6;
const MAX_STRING = 512;

/**
 * Splits an identifier into lowercase words across separators, camelCase humps and
 * acronym runs: `AUTHORIZATION_HEADER` -> [authorization, header], `codeTtlSeconds` ->
 * [code, ttl, seconds].
 *
 * @param {string} key
 * @returns {string[]}
 */
function segmentKey(key) {
  const words = [];
  for (const chunk of String(key).split(/[^A-Za-z0-9]+/)) {
    if (chunk.length === 0) continue;
    const parts = chunk.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g);
    if (parts) for (const part of parts) words.push(part.toLowerCase());
    else words.push(chunk.toLowerCase());
  }
  return words;
}

/**
 * True when the key names a value that must never be persisted.
 *
 * Two tiers, checked in order:
 *  1. any word in ALWAYS_SECRET_WORDS anywhere in the key;
 *  2. the last word is in HEAD_SECRET_WORDS and no earlier word is one of that noun's
 *     safe qualifiers.
 *
 * The old rule was a bare substring match, which ate `errorCode`, `statusCode`,
 * `exitCode`, `codeTtlSeconds` and `tokenCount`.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  const words = segmentKey(key);
  if (words.length === 0) return false;
  for (const word of words) {
    if (ALWAYS_SECRET_WORDS.has(word)) return true;
  }
  const safeQualifiers = HEAD_SECRET_WORDS.get(words[words.length - 1]);
  if (safeQualifiers === undefined) return false;
  for (let i = 0; i < words.length - 1; i += 1) {
    if (safeQualifiers.has(words[i])) return false;
  }
  return true;
}

/**
 * Recursively strips secrets from an audit detail payload.
 *
 * - secret-bearing keys (see `isSecretKey`) keep their key and get the value
 *   `'[redacted]'`. They are never dropped: an audit row that quietly loses a field is
 *   indistinguishable from one that was never written, and that failure mode has already
 *   cost us two fields.
 * - string values shaped like a base64url secret become `'[redacted]'`
 * - byte buffers collapse to a short, non-secret-shaped fingerprint
 *
 * Exported so every other layer redacts identically.
 *
 * @param {unknown} detail
 * @returns {unknown}
 */
export function redactDetail(detail) {
  return redact(detail, 0, new WeakSet());
}

function redact(value, depth, seen) {
  if (value === null || value === undefined) return value ?? null;

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return `<blob:${buf.length}:${buf.subarray(0, 8).toString('hex')}>`;
  }

  const type = typeof value;
  if (type === 'string') {
    // A message id trips SECRET_VALUE_RE's 24-character floor at 26 characters. It is not
    // opaque material: see SECRET_VALUE_RE for why exempting it cannot leak a secret, and
    // why redacting it would make a cursor audit row unable to say what it is for.
    if (isId(value)) return value;
    if (SECRET_VALUE_RE.test(value)) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return value.toString();
  if (type === 'function' || type === 'symbol') return '[unserialisable]';

  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));

  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1, seen) };
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}

/**
 * Appends one audit row. Accepts a raw better-sqlite3 handle, a store, or a
 * transaction context — inside a transaction the audit row commits or rolls
 * back with the act it describes.
 *
 * @param {object} db
 * @param {{namespace?:string, actorPrincipalId?:string|null, action:string,
 *          subject?:string|null, outcome:string, detail?:unknown, at?:string}} entry
 * @returns {number} the audit row id
 */
export function audit(db, entry = {}) {
  const handle = db && db.db ? db.db : db;
  if (!handle || typeof handle.prepare !== 'function') {
    fail('internal', 'audit requires a database handle');
  }
  const namespace = entry.namespace ?? (db && db.namespace);
  if (typeof namespace !== 'string' || namespace.length === 0) {
    fail('namespace_unresolved', 'audit requires a namespace');
  }
  if (typeof entry.action !== 'string' || entry.action.length === 0) {
    fail('invalid_request', 'audit action is required');
  }
  if (typeof entry.outcome !== 'string' || entry.outcome.length === 0) {
    fail('invalid_request', 'audit outcome is required');
  }

  const detail = entry.detail === undefined ? null : JSON.stringify(redactDetail(entry.detail));
  const res = handle
    .prepare(
      'INSERT INTO audit (namespace, at, actor_principal_id, action, subject, outcome, detail) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      namespace,
      entry.at || now(),
      entry.actorPrincipalId ?? null,
      entry.action,
      entry.subject ?? null,
      entry.outcome,
      detail
    );
  return Number(res.lastInsertRowid);
}

/**
 * @param {object} store
 * @param {{action?:string, actorPrincipalId?:string, limit?:number}} [opts]
 */
export function listAudit(store, opts = {}) {
  const handle = store && store.db ? store.db : store;
  const namespace = opts.namespace ?? (store && store.namespace);
  const where = ['namespace = ?'];
  const params = [namespace];
  if (opts.action !== undefined) {
    where.push('action = ?');
    params.push(opts.action);
  }
  if (opts.actorPrincipalId !== undefined) {
    where.push('actor_principal_id = ?');
    params.push(opts.actorPrincipalId);
  }
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 100;
  return handle
    .prepare(
      'SELECT id, namespace, at, actor_principal_id, action, subject, outcome, detail ' +
        `FROM audit WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`
    )
    .all(...params, limit)
    .map((row) => ({
      id: row.id,
      namespace: row.namespace,
      at: row.at,
      actorPrincipalId: row.actor_principal_id,
      action: row.action,
      subject: row.subject,
      outcome: row.outcome,
      detail: row.detail === null ? null : JSON.parse(row.detail)
    }));
}
