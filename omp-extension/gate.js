/**
 * Pure decision logic for the Walkie enrollment gate.
 *
 * This module has no dependency on OMP, on the network, or on the filesystem, so the
 * whole truth table is unit-testable in isolation. `walkie-enroll.js` is the only
 * place that talks to OMP or to the authority socket.
 *
 * Threat model note: OMP namespaces MCP-provided tools as `mcp__<serverName>_<toolName>`.
 * A gate that matches only the bare `walkie_enroll` never fires for the MCP path, which
 * fails OPEN. Matching is therefore built from an explicit allowlist of server names, and
 * anything that looks like an enrollment call but is not an exact allowlisted name is
 * BLOCKED rather than passed through.
 */

/** The unqualified Walkie enrollment tool name. */
export const ENROLL_TOOL = 'walkie_enroll';

/** MCP server names whose `walkie_enroll` is accepted when nothing is configured. */
export const DEFAULT_ALLOWED_SERVERS = ['walkie-talkie'];

/** The two selectable options, Deny first so it is the pre-selected default. */
export const DENY_OPTION = 'Deny';
export const APPROVE_OPTION = 'Approve';
export const SELECT_OPTIONS = [DENY_OPTION, APPROVE_OPTION];

/**
 * Every tool name that counts as *the* Walkie enrollment tool.
 *
 * Built by generation rather than by parsing, because MCP server names may themselves
 * contain `_`: parsing `mcp__evil_walkie_enroll` is ambiguous (server `evil` + tool
 * `walkie_enroll`, or server `evil_walkie` + tool `enroll`), while generation is exact.
 *
 * @param {string[]} [allowedServers]
 * @returns {Set<string>}
 */
export function expectedToolNames(allowedServers = DEFAULT_ALLOWED_SERVERS) {
  const names = new Set([ENROLL_TOOL]);
  const servers = Array.isArray(allowedServers) ? allowedServers : [];
  for (const server of servers) {
    if (typeof server !== 'string') continue;
    const trimmed = server.trim();
    if (trimmed === '') continue;
    names.add(`mcp__${trimmed}_${ENROLL_TOOL}`);
  }
  return names;
}

/**
 * True when a tool name looks like an enrollment call regardless of provenance.
 * Suffix match only: a name that merely *contains* `walkie_enroll` mid-string
 * (e.g. `walkie_enroll_status`) is a different tool and is left alone.
 *
 * @param {string} toolName
 */
function looksLikeEnroll(toolName) {
  return toolName === ENROLL_TOOL || toolName.endsWith(ENROLL_TOOL);
}

/**
 * @typedef {'unrelated'|'enroll'|'foreign'} ToolClass
 * `unrelated` — not an enrollment call; the gate must not interfere.
 * `enroll`    — the real enrollment tool from an allowlisted source.
 * `foreign`   — shaped like enrollment but from an unrecognised source; fail closed.
 */

/**
 * @param {unknown} toolName
 * @param {string[]} [allowedServers]
 * @returns {ToolClass}
 */
export function classifyToolName(toolName, allowedServers = DEFAULT_ALLOWED_SERVERS) {
  if (typeof toolName !== 'string' || toolName === '') return 'unrelated';
  if (expectedToolNames(allowedServers).has(toolName)) return 'enroll';
  if (looksLikeEnroll(toolName)) return 'foreign';
  return 'unrelated';
}

/**
 * @typedef {{ action: 'pass' }
 *   | { action: 'block', code: string, reason: string }
 *   | { action: 'prompt' }
 *   | { action: 'inject' }} Verdict
 */

const BLOCK_FOREIGN = {
  action: 'block',
  code: 'forbidden',
  reason:
    'walkie [forbidden]: enrollment tool offered by an unrecognised MCP server; ' +
    'add the server to the hook allowlist if this is intentional'
};

const BLOCK_NO_UI = {
  action: 'block',
  code: 'forbidden',
  reason:
    'walkie [forbidden]: enrollment needs an interactive operator confirmation; ' +
    'a non-interactive session must receive a delegated capability from the root instead'
};

const BLOCK_DENIED = {
  action: 'block',
  code: 'forbidden',
  reason: 'walkie [forbidden]: operator did not approve the enrollment request'
};

/**
 * Everything the gate needs to know before it is allowed to prompt the operator.
 * Returns `prompt` only for a genuine enrollment call in a session that has a UI.
 *
 * @param {{ toolName: unknown, allowedServers?: string[], hasUI?: unknown }} input
 * @returns {Verdict}
 */
export function gateStage({ toolName, allowedServers, hasUI }) {
  const cls = classifyToolName(toolName, allowedServers);
  if (cls === 'unrelated') return { action: 'pass' };
  if (cls === 'foreign') return { ...BLOCK_FOREIGN };
  if (!hasUI) return { ...BLOCK_NO_UI };
  return { action: 'prompt' };
}

/**
 * Reduce whatever the UI handed back to a bare string. A rich selector may answer with
 * `{ value }` / `{ label }` rather than a plain string; anything else — including
 * `undefined` for a dismissed dialog — normalises to `undefined`, i.e. a denial.
 *
 * @param {unknown} selection
 * @returns {string|undefined}
 */
export function normalizeSelection(selection) {
  if (typeof selection === 'string') return selection;
  if (selection !== null && typeof selection === 'object') {
    const record = /** @type {Record<string, unknown>} */ (selection);
    if (typeof record.value === 'string') return record.value;
    if (typeof record.label === 'string') return record.label;
  }
  return undefined;
}

/**
 * The complete truth table. `selection` is whatever `ctx.ui.select` produced; anything
 * that is not an exact `Approve` — `undefined`, `Deny`, a stray value, the sentinel a
 * caller uses for "select threw" — is a denial.
 *
 * @param {{ toolName: unknown, allowedServers?: string[], hasUI?: unknown, selection?: unknown }} input
 * @returns {{ action: 'pass'|'block'|'inject', code?: string, reason?: string }}
 */
export function decide({ toolName, allowedServers, hasUI, selection }) {
  const stage = gateStage({ toolName, allowedServers, hasUI });
  if (stage.action !== 'prompt') return stage;
  if (normalizeSelection(selection) !== APPROVE_OPTION) return { ...BLOCK_DENIED };
  return { action: 'inject' };
}
