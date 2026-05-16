const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALIAS_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ALLOWED_TOOLS = new Set(['claude-code', 'claude-cowork', 'operator']);

export function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

export function isValidAlias(value) {
  return typeof value === 'string' && ALIAS_RE.test(value);
}

export function isValidTool(value) {
  return typeof value === 'string' && ALLOWED_TOOLS.has(value);
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
