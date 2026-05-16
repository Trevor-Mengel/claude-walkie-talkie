const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALIAS_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ALLOWED_TOOLS = new Set(['claude-code', 'claude-cowork', 'operator']);
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const BODY_FORBIDDEN_PATTERNS = [/\n## /, /<!--\s*walkie:msg/i];
const REASON_FORBIDDEN_PATTERNS = [/\n## /, /<!--\s*walkie:msg/i, /"/];
const OPERATOR_NAME_RE = /^[\p{L}\p{N} ._'-]{1,80}$/u;

export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

export function isValidAlias(value) {
  return typeof value === 'string' && ALIAS_RE.test(value);
}

export function isValidTool(value) {
  return typeof value === 'string' && ALLOWED_TOOLS.has(value);
}

export function isValidUlid(value) {
  return typeof value === 'string' && ULID_RE.test(value);
}

/**
 * Returns an error message string if any of the provided actor fields are invalid,
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

export function isValidMessageBody(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return !BODY_FORBIDDEN_PATTERNS.some((re) => re.test(value));
}

export function isValidArchiveReason(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  return !REASON_FORBIDDEN_PATTERNS.some((re) => re.test(value));
}

export function isValidOperatorName(value) {
  return typeof value === 'string' && value.length > 0 && OPERATOR_NAME_RE.test(value);
}
