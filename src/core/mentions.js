import { ALIAS_BODY_CLASS, ALIAS_EDGE_CLASS } from './validate.js';

/**
 * A mention token is an alias, so it is scanned with the alias character set
 * (`src/core/validate.js`) rather than a narrower hand-rolled one. Matching is
 * greedy: `@ops.hub` is the single token `ops.hub`, never the prefix `ops`
 * followed by stray text, so an attacker cannot capture another principal's
 * directed traffic by claiming a prefix of its alias.
 */
const MENTION_RE = new RegExp(
  `(?:^|[\\s,.;!?])@(${ALIAS_EDGE_CLASS}${ALIAS_BODY_CLASS}*)`,
  'g'
);

/**
 * Sentence punctuation the greedy scan swallows. An alias may not end in one
 * of these, so trimming them can never shorten a real alias — it only turns
 * `@alice.` at the end of a sentence back into `alice`.
 */
const TRAILING_PUNCTUATION_RE = /[._-]+$/;

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
    const tok = m[1].replace(TRAILING_PUNCTUATION_RE, '').toLowerCase();
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
  // Tokens arrive case-folded from parseMentions, and alias uniqueness is
  // case-insensitive, so the roster side folds too rather than missing a match.
  const aliases = new Set(activeSessions.map((s) => String(s.alias).toLowerCase()));
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
