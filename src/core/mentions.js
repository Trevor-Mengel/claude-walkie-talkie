const MENTION_RE = /(?:^|[\s,.;!?])@([a-z0-9][a-z0-9-]*)/gi;

const TOOLS = new Set(['claude-code', 'claude-cowork', 'codex', 'cursor']);
const SPECIAL = new Set(['all', 'operator']);

/**
 * @param {string} body
 * @returns {string[]} unique tokens in order of first appearance, lowercased
 */
export function parseMentions(body) {
  const seen = new Set();
  const out = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const tok = m[1].toLowerCase();
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

/**
 * @param {string[]} tokens
 * @param {Array<{alias:string, tool:string}>} activeSessions
 * @returns {{resolved:string[], unresolved:string[]}}
 */
export function resolveMentions(tokens, activeSessions) {
  const aliases = new Set(activeSessions.map((s) => s.alias));
  const resolved = [];
  const unresolved = [];
  for (const tok of tokens) {
    if (SPECIAL.has(tok)) {
      resolved.push(`@${tok}`);
    } else if (TOOLS.has(tok)) {
      resolved.push(`@tool:${tok}`);
    } else if (aliases.has(tok)) {
      resolved.push(tok);
    } else {
      unresolved.push(tok);
    }
  }
  return { resolved, unresolved };
}
