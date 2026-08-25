import { collabcastError, isCollabcastError, ERROR_CODES } from '../../identity/errors.js';
import { listPrincipals } from '../../store/principals.js';
import { parseMentions } from '../../core/mentions.js';

/**
 * Shared route-layer plumbing.
 *
 * The one rule this file exists to enforce: **nothing on a write path is read
 * from the request except content.** Author identity, alias, tool, timestamp,
 * git provenance and mention targets are all derived here from
 * `req.collabcast.principal` and the server clock. v0.2 took every one of those
 * from the request body, which is why any caller could post as anyone.
 */

/**
 * Normalises a thrown value into the wire vocabulary before it reaches the
 * transport's error middleware.
 *
 * The store throws `StoreError`, not `CollabcastError`. Both carry the same
 * `{ code, message, detail }` shape and draw `code` from the same list, but a
 * class check in the transport would map every store failure to 500 — an alias
 * collision would read as a server fault. Translate once, here, at the boundary
 * between store vocabulary and wire vocabulary. Anything without a recognised
 * code is passed through untouched so it collapses to the fixed `internal`
 * body rather than leaking a driver message.
 *
 * @param {unknown} err
 * @returns {unknown}
 */
export function toCollabcast(err) {
  if (isCollabcastError(err)) return err;
  if (err && typeof err.code === 'string' && ERROR_CODES.includes(err.code)) {
    return collabcastError(err.code, err.message, err.detail);
  }
  return err;
}

/** Wraps an async express handler so every rejection is normalised. */
export function handler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => next(toCollabcast(err)));
  };
}

/**
 * Role → marker `from-tool`.
 *
 * The tool is presentation (it picks the heading emoji) and in v0.2 it was
 * caller-supplied, so `@tool:` mention routing was trivially spoofable. It is
 * now a pure function of the authenticated principal's role.
 *
 * @param {string} role
 */
export function toolForRole(role) {
  return role === 'operator' ? 'operator' : 'omp';
}

/**
 * The complete set of marker identity fields for a principal. The marker's
 * `from` field is the principal id, so ownership survives a rename — v0.2
 * stored a session-id string and an alias, so renaming an identity orphaned
 * every message it had written.
 *
 * @param {{id:string, role:string, displayAlias?:string|null}} principal
 */
export function principalIdentity(principal) {
  return {
    fromSessionId: principal.id,
    fromAlias: principal.displayAlias || principal.id,
    fromTool: toolForRole(principal.role)
  };
}

/**
 * Ownership of a message block.
 *
 * The marker's `from` field is authoritative. Pre-v0.3 blocks carry a session
 * id string there, which names no principal; such a message is owned by NOBODY
 * — not by the principal that happens to hold that alias now, and not by an
 * operator. Fail closed: an unowned message can be archived by an operator
 * (moderation) but its body can never be edited by anyone.
 *
 * @param {{id:string}} principal
 * @param {{fromSessionId?:string}} message
 */
export function ownsMessage(principal, message) {
  const author = message?.fromSessionId;
  if (typeof author !== 'string' || author.length === 0) return false;
  return author === principal.id;
}

/** Mention tokens that name a role or the whole channel rather than a principal. */
export const MENTION_ALL = '@all';
export const MENTION_OPERATOR = '@operator';

/**
 * Resolves `@alias` authoring syntax against the principal roster and returns
 * **principal ids**.
 *
 * v0.2 persisted the alias string and matched inbox delivery on it, so renaming
 * yourself to someone else's alias redirected their directed traffic to you.
 * Ids are unforgeable and survive renames, so both halves of that bug close at
 * once. `@all` and `@operator` stay symbolic: they address the channel and the
 * operator *role*, neither of which is a principal, and a role cannot be
 * claimed by picking an alias.
 *
 * Alias matching is case-insensitive because the authoring syntax is
 * lowercased by `parseMentions` — and alias uniqueness is enforced on that same
 * fold by the `principal_alias` index, so at most one live principal can answer
 * to a token. v0.3 folded here but enforced uniqueness under BINARY collation,
 * so `alice` and `Alice` could both be live and a directed `@alice` reached
 * neither. The roster is ordered oldest-first, so if a legacy row ever slips
 * past the index the incumbent still wins rather than everyone losing.
 *
 * @param {object} store
 * @param {string} body
 * @returns {{mentions:string[], unresolved:string[]}}
 */
export function resolveRosterMentions(store, body) {
  const tokens = parseMentions(body);
  if (tokens.length === 0) return { mentions: [], unresolved: [] };

  const roster = listPrincipals(store);
  /** @type {Map<string, string>} lowercased alias -> principal id */
  const byFold = new Map();
  for (const p of roster) {
    if (!p.displayAlias) continue;
    const fold = p.displayAlias.toLowerCase();
    if (!byFold.has(fold)) byFold.set(fold, p.id);
  }

  const mentions = [];
  const unresolved = [];
  for (const tok of tokens) {
    if (tok === 'all') {
      mentions.push(MENTION_ALL);
      continue;
    }
    if (tok === 'operator') {
      mentions.push(MENTION_OPERATOR);
      continue;
    }
    const id = byFold.get(tok);
    if (id) mentions.push(id);
    else unresolved.push(tok);
  }
  return { mentions: [...new Set(mentions)], unresolved };
}

/**
 * Does `message` address `principal`?
 *
 * Matched on principal id, `@all`, or `@operator` for a principal whose role
 * actually is `operator`. Never on an alias string.
 *
 * @param {{id:string, role:string}} principal
 * @param {{mentions?:string[]}} message
 */
export function addressesPrincipal(principal, message) {
  const mentions = message?.mentions ?? [];
  if (mentions.includes(principal.id)) return true;
  if (mentions.includes(MENTION_ALL)) return true;
  if (principal.role === 'operator' && mentions.includes(MENTION_OPERATOR)) return true;
  return false;
}

/**
 * Reads exactly the keys named from a request body, rejecting anything else.
 *
 * A route that destructures `req.body` silently tolerates extra keys, which is
 * how a caller could keep passing authority fields and how a typo (`replyto`)
 * fails open. Unknown keys are a client error.
 *
 * @param {unknown} body
 * @param {string[]} allowed
 * @returns {Record<string, unknown>}
 */
export function readBody(body, allowed) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw collabcastError('invalid_request', 'request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw collabcastError('invalid_request', 'unknown fields in request body', { fields: unknown });
  }
  return body;
}

/**
 * Clamps a `limit` query parameter.
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} max
 */
export function readLimit(raw, fallback, max) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw collabcastError('invalid_request', 'limit must be a positive integer');
  }
  return Math.min(n, max);
}

/** `?flag=true` and nothing else. */
export function readFlag(raw) {
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw collabcastError('invalid_request', 'boolean query parameters accept only true or false');
}
