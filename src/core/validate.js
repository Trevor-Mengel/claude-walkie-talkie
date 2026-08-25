const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The alias grammar — the ONE definition in the system.
 *
 * v0.3 shipped two: this module's (lowercase, hyphen only) and a looser twin
 * inside `src/store/principals.js` that admitted `.` and `_`. The store's was
 * the live one, and because `src/core/mentions.js` terminated a mention token
 * at `.`, a principal claiming the longest legal PREFIX of a dotted alias
 * silently received every mention addressed to the full alias. Both the store
 * and the mention scanner now build on the constants below, so the two can
 * never drift again.
 *
 * An alias starts and ends alphanumeric. That is not cosmetic: it lets the
 * mention scanner match greedily and then drop trailing `.`/`-`/`_`, so
 * `@ops.hub.` at the end of a sentence is the alias `ops.hub` and never the
 * prefix `ops`.
 */
export const ALIAS_EDGE_CLASS = '[A-Za-z0-9]';
export const ALIAS_BODY_CLASS = '[A-Za-z0-9._-]';
export const ALIAS_MAX_LENGTH = 64;
export const ALIAS_DESCRIPTION =
  '1-64 chars of [A-Za-z0-9._-], starting and ending alphanumeric';

const ALIAS_RE = new RegExp(
  `^${ALIAS_EDGE_CLASS}(?:${ALIAS_BODY_CLASS}{0,${ALIAS_MAX_LENGTH - 2}}${ALIAS_EDGE_CLASS})?$`
);

/**
 * Tool identity list.
 *
 * MUST stay a superset of the tool tokens `src/core/mentions.js` can resolve to
 * `@tool:<name>` — otherwise `@codex` / `@cursor` mentions resolve to a tool that
 * no session may ever claim, which is what v0.2 shipped. `omp` is first-class so
 * OMP clients stop impersonating `claude-code`.
 */
const ALLOWED_TOOLS = ['claude-code', 'claude-cowork', 'codex', 'cursor', 'omp', 'operator'];
const ALLOWED_TOOLS_SET = new Set(ALLOWED_TOOLS);

/** The only message types the marker (and the store's `msg_type` CHECK) accept. */
const MESSAGE_TYPES = ['broadcast', 'question', 'reply', 'memory-update'];
const MESSAGE_TYPES_SET = new Set(MESSAGE_TYPES);

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const OPERATOR_NAME_RE = /^[\p{L}\p{N} ._'-]{1,80}$/u;

/**
 * A message body is embedded verbatim into `channel.md`, so it must not be able
 * to forge a message boundary.
 *
 * v0.2 tested `/\n## /` against the body in isolation, so a body whose FIRST line
 * was `## x` passed the guard — and then `formatMessage` prepended a blank line,
 * materialising a real `\n## ` boundary that truncated the message. The check now
 * runs per line (so position 0 is covered), on a CR-normalised copy (so `\r\n`
 * and lone `\r` line endings cannot smuggle a heading past it), and covers
 * indented headings (up to 3 leading spaces is still an ATX heading in
 * CommonMark) and deeper levels (`### `, `#### `).
 */
const HEADING_LINE_RE = /^[ \t]{0,3}#{2,6}([ \t]|$)/;

/**
 * Any Collabcast control comment (`walkie:msg`, `walkie:body`, `walkie:body-end`, …).
 *
 * DELIBERATELY NOT RENAMED with the rest of the product. The `walkie:` prefix is the
 * on-disk marker namespace in `channel.md`, and this literal is what the unforgeability
 * argument rests on: a body may never contain the sequence a marker starts with. Renaming
 * it here without rewriting every channel file on disk would let a v0.2 body smuggle a
 * `walkie:` marker past validation. The prefix rides the v0.2 -> v0.3 importer instead,
 * so do not "finish" the rename here.
 */
const WALKIE_COMMENT_RE = /<!--\s*walkie:/i;

/** Closes the marker comment — fatal inside a marker value, harmless in a body. */
const MARKER_TERMINATOR_RE = /-->/;

/**
 * 64 KiB. One channel message is read into LLM context and rendered in a
 * terminal; 64 KiB is already ~16k tokens, far past anything a human or agent
 * writes on purpose, while still large enough for a pasted stack trace or diff.
 * The cap exists so a single post cannot balloon `channel.md` unboundedly.
 */
export const MAX_BODY_LENGTH = 65536;

/** Archive reasons are one banner line; 500 chars is generous for that. */
export const MAX_ARCHIVE_REASON_LENGTH = 500;

export function allowedTools() {
  return [...ALLOWED_TOOLS];
}

export function messageTypes() {
  return [...MESSAGE_TYPES];
}

export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

export function isValidAlias(value) {
  return typeof value === 'string' && ALIAS_RE.test(value);
}

export function isValidTool(value) {
  return typeof value === 'string' && ALLOWED_TOOLS_SET.has(value);
}

export function isValidUlid(value) {
  return typeof value === 'string' && ULID_RE.test(value);
}

/** Message type must be one of the four enum members — nothing else reaches the marker. */
export function isValidMessageType(value) {
  return typeof value === 'string' && MESSAGE_TYPES_SET.has(value);
}

/** `reply-to` is either absent (null/undefined/'') or a ULID. */
export function isValidReplyTo(value) {
  if (value === null || value === undefined || value === '') return true;
  return isValidUlid(value);
}

/**
 * Returns error message string if any of the provided actor fields are invalid,
 * else null. Caller (express route) translates the message to 400.
 */
export function validateActorFields({ fromSessionId, fromAlias, fromTool }) {
  if (fromSessionId !== undefined && !isValidSessionId(fromSessionId)) {
    return 'invalid fromSessionId format';
  }
  if (fromAlias !== undefined && fromAlias !== null && !isValidAlias(fromAlias)) {
    return 'invalid fromAlias format';
  }
  if (fromTool !== undefined && !isValidTool(fromTool)) {
    return 'invalid fromTool format';
  }
  return null;
}

function hasForbiddenMarkup(value) {
  const normalized = value.replace(/\r\n?/g, '\n');
  if (WALKIE_COMMENT_RE.test(normalized)) return true;
  return normalized.split('\n').some((line) => HEADING_LINE_RE.test(line));
}

export function isValidMessageBody(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > MAX_BODY_LENGTH) return false;
  return !hasForbiddenMarkup(value);
}

export function isValidArchiveReason(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  if (value.length > MAX_ARCHIVE_REASON_LENGTH) return false;
  // The reason is rendered inside the marker comment; `"` breaks a quoted value
  // and `-->` closes the comment outright.
  if (value.includes('"')) return false;
  if (MARKER_TERMINATOR_RE.test(value)) return false;
  return !hasForbiddenMarkup(value);
}

export function isValidOperatorName(value) {
  return typeof value === 'string' && value.length > 0 && OPERATOR_NAME_RE.test(value);
}
