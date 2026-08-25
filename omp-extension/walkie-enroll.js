/**
 * OMP hook: operator-approval gate for Walkie enrollment.
 *
 * Nothing enrolls itself. When an agent calls the Walkie enrollment tool, this hook
 * interrupts the call, shows the operator exactly what is being requested, and — only on
 * an explicit `Approve` — fetches a one-use enrollment code from the local authority and
 * injects it into the tool's raw execution arguments. The model can neither author nor
 * observe that value.
 *
 * Design invariants (each one is a bug that has bitten this gate before):
 *
 *  1. OMP namespaces MCP tools as `mcp__<serverName>_<toolName>`. Matching a bare
 *     `walkie_enroll` silently never fires for the MCP path — a fail-OPEN gate. Matching
 *     is therefore allowlist-generated in `gate.js`, and an enrollment-shaped name from an
 *     unrecognised server is BLOCKED rather than passed.
 *  2. `ctx.ui.confirm` renders Yes/No with **Yes pre-selected**, so a stray ENTER
 *     approves. This hook uses `ctx.ui.select` with `Deny` first and default instead.
 *  3. Every failure mode — no UI, denial, a dismissed dialog, a throwing `select`, a dead
 *     socket, a timeout, a malformed reply — blocks. There is no path where an error
 *     results in the tool running.
 *  4. The shared secret and the enrollment code never reach the model or the log: no
 *     `pi.sendMessage`, no stdout, no `reason` interpolation, and log entries go through
 *     `redact()`.
 *
 * See `omp-extension/README.md` for installation and the boundary this does and does not
 * provide.
 */

import { appendFileSync } from 'node:fs';
import {
  DEFAULT_ALLOWED_SERVERS,
  SELECT_OPTIONS,
  decide,
  gateStage,
  normalizeSelection
} from './gate.js';
import { DEFAULT_TIMEOUT_MS, requestEnrollmentCode } from './authority.js';
import { redact } from './redact.js';

/** Dialog title shown to the operator. */
export const PROMPT_TITLE = 'Walkie enrollment';

const BLOCK_UNDESCRIBABLE = {
  code: 'invalid_request',
  reason:
    'walkie [invalid_request]: enrollment request did not state a namespace, role and ' +
    'scopes, so it cannot be shown to the operator for approval'
};

const BLOCK_UNCONFIGURED = {
  code: 'config_invalid',
  reason:
    'walkie [config_invalid]: the enrollment hook is not configured for this session; ' +
    'the operator must set the authority socket and hook secret'
};

const BLOCK_AUTHORITY = {
  code: 'internal',
  reason: 'walkie [internal]: the walkie authority did not issue an enrollment code'
};

const BLOCK_UNRENDERABLE = {
  code: 'invalid_request',
  reason:
    'walkie [invalid_request]: the enrollment request contained a namespace, role or scope ' +
    'that cannot be shown to the operator as one line, so it was refused without asking'
};

/**
 * What a real request looks like. `namespace` is `[a-z][a-z0-9-]{0,63}` upstream, roles are
 * single words and scopes are `area:verb`, so these caps are far above anything legitimate
 * and far below "enough text to scroll the real grant off an operator's dialog".
 */
export const FIELD_LIMITS = Object.freeze({
  maxFieldLength: 64,
  maxScopes: 12,
  maxScopeLength: 48
});

/**
 * The operator dialog is the ONE surface this design asks a human to trust, and its body is
 * multi-line. A field that can carry a line break can therefore forge a COMPLETE second
 * grant block above the real one — its own `Namespace`/`Role`/`Scopes`/`TTL` plus whatever
 * reassuring prose it likes — pushing the real `root`, six-scope, 86400s grant below the
 * fold of a terminal dialog. `assertEnrollable` means such a request can never be granted
 * (the namespace has to match byte-for-byte and role and scopes are enum-checked), so this
 * is not capability widening: it is arbitrary attacker-authored text under a trusted title,
 * which is enough to get a human to approve the wrong thing or to follow an instruction
 * rendered as if we had written it.
 *
 * So the dialog is made structurally unforgeable, in two layers:
 *
 *   1. `readRequest` refuses a field carrying any of these characters, or one longer than a
 *      real one can be. The operator is never asked and the authority is never contacted.
 *   2. `promptField` escapes whatever is left, so `buildPromptBody` cannot emit a line it
 *      did not author even when called directly with hostile input.
 *
 * The escape is the scheme `src/core/format.js` uses for heading text — percent-encoded
 * UTF-8 bytes over a surface-specific unsafe set — not a third convention. The set is
 * "anything that can end a line or reorder one":
 *   - C0 / DEL             `\n` and `\r` above all: one field is one line
 *   - U+0085, U+2028/2029  NEL and LINE/PARAGRAPH SEPARATOR break lines in some renderers
 *   - bidi controls        RLO/LRO and friends visually reverse a rendered line
 *   - `%`                  escaped only in the rendering, so the encoding is invertible
 */
const LINE_BREAKING =
  '\\u0000-\\u001f\\u007f\\u0085\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069';
const FIELD_ILLEGAL_RE = new RegExp(`[${LINE_BREAKING}]`);
const PROMPT_UNSAFE_RE = new RegExp(`[%${LINE_BREAKING}]`, 'g');

/**
 * Render one prompt field. @see PROMPT_UNSAFE_RE for why, and `src/core/format.js`'s
 * `headingText` for the identical escape.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function promptField(value) {
  return String(value ?? '').replace(PROMPT_UNSAFE_RE, (ch) => {
    let out = '';
    for (const byte of Buffer.from(ch, 'utf8')) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return out;
  });
}

/**
 * The first structural reason this request can never be shown to the operator, or `null`.
 * Values are deliberately NOT returned in the problem: nothing about an illegal field is
 * worth carrying further than the decision to refuse it.
 *
 * @param {{namespace:string, role:string, scopes:string[]}} request
 * @returns {{field:string, reason:string}|null}
 */
function firstProblem({ namespace, role, scopes }) {
  for (const [field, value] of [
    ['namespace', namespace],
    ['role', role]
  ]) {
    if (FIELD_ILLEGAL_RE.test(value)) return { field, reason: 'illegal-characters' };
    if (value.length > FIELD_LIMITS.maxFieldLength) return { field, reason: 'too-long' };
  }
  if (scopes.length > FIELD_LIMITS.maxScopes) return { field: 'scopes', reason: 'too-many' };
  for (const scope of scopes) {
    if (FIELD_ILLEGAL_RE.test(scope)) return { field: 'scopes', reason: 'illegal-characters' };
    if (scope.length > FIELD_LIMITS.maxScopeLength) return { field: 'scopes', reason: 'too-long' };
  }
  return null;
}

/**
 * @param {string|undefined} raw comma- or space-separated server names
 * @returns {string[]}
 */
function parseServers(raw) {
  if (typeof raw !== 'string') return [...DEFAULT_ALLOWED_SERVERS];
  const parsed = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_SERVERS];
}

/**
 * @param {string|undefined} raw
 * @returns {number}
 */
function parseTimeout(raw) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Resolve hook configuration from the environment the operator installed it with.
 * @param {Record<string, string|undefined>} [env]
 */
export function readConfig(env = process.env) {
  return {
    allowedServers: parseServers(env.WALKIE_MCP_SERVERS),
    socketPath: env.WALKIE_AUTHORITY_SOCKET,
    hookSecret: env.WALKIE_HOOK_SECRET,
    timeoutMs: parseTimeout(env.WALKIE_HOOK_TIMEOUT_MS),
    logPath: env.WALKIE_HOOK_LOG
  };
}

/**
 * Append one redacted JSONL entry. Best-effort: a log that cannot be written must never
 * turn into a thrown error inside a security gate.
 *
 * @param {string|undefined} logPath
 * @param {Record<string, unknown>} entry
 */
export function writeLog(logPath, entry) {
  if (typeof logPath !== 'string' || logPath === '') return;
  try {
    const safe = redact({ at: new Date().toISOString(), ...entry });
    appendFileSync(logPath, `${JSON.stringify(safe)}\n`, 'utf8');
  } catch {
    /* logging is never load-bearing */
  }
}

/**
 * Pull the fields the operator has to see out of the tool's arguments.
 *
 * `problem` is the structural reason this request can never be rendered as one line per
 * field (or `null`). It is decided HERE, before anything is shown or contacted, because
 * the caller's next act is to put these values in front of a human.
 *
 * @param {Record<string, unknown>} input
 * @returns {{namespace:string, role:string, scopes:string[], ttlSeconds?:number,
 *   problem:{field:string, reason:string}|null}}
 */
export function readRequest(input) {
  const source = input && typeof input === 'object' ? input : {};
  const namespace = typeof source.namespace === 'string' ? source.namespace.trim() : '';
  const role = typeof source.role === 'string' ? source.role.trim() : '';
  const rawScopes = source.scopes;
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.filter((scope) => typeof scope === 'string' && scope.trim() !== '')
    : typeof rawScopes === 'string'
      ? rawScopes
          .split(/[,\s]+/)
          .map((scope) => scope.trim())
          .filter((scope) => scope !== '')
      : [];
  const rawTtl = Number(source.ttlSeconds);
  const ttlSeconds = Number.isInteger(rawTtl) && rawTtl > 0 ? rawTtl : undefined;
  const problem = firstProblem({ namespace, role, scopes });
  return { namespace, role, scopes, ttlSeconds, problem };
}

/**
 * The exact text the operator reads before approving. It names the namespace, the role,
 * every requested scope and the TTL, because an approval prompt that does not say what is
 * being granted is theatre.
 *
 * Every field goes through `promptField`, so the body is always exactly these eight lines
 * and one grant block — see `PROMPT_UNSAFE_RE`. `ttlSeconds` is a validated integer by the
 * time it gets here and is rendered through the same path anyway: one convention, no
 * exceptions to audit.
 *
 * @param {{ namespace: string, role: string, scopes: string[], ttlSeconds?: number }} request
 */
export function buildPromptBody(request) {
  const scopes = (request.scopes ?? []).map(promptField).join(', ');
  const ttl =
    request.ttlSeconds === undefined
      ? 'authority default'
      : `${promptField(request.ttlSeconds)}s`;
  return [
    'An agent is asking to enroll on the walkie channel.',
    '',
    `Namespace: ${promptField(request.namespace)}`,
    `Role:      ${promptField(request.role)}`,
    `Scopes:    ${scopes}`,
    `TTL:       ${ttl}`,
    '',
    'Approve only if you asked for this agent to join.'
  ].join('\n');
}

/**
 * Build the `tool_call` handler. Dependencies are injected so the gate is testable
 * without OMP and, where wanted, without a socket.
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {typeof requestEnrollmentCode} [options.enroll]
 */
export function createEnrollHandler({ env, enroll = requestEnrollmentCode } = {}) {
  /**
   * @param {{ toolName?: unknown, input?: Record<string, unknown> }} event
   * @param {{ hasUI?: unknown, ui?: { select?: Function } }} ctx
   */
  return async function onToolCall(event, ctx) {
    const config = readConfig(env);
    const toolName = event?.toolName;
    const stage = gateStage({
      toolName,
      allowedServers: config.allowedServers,
      hasUI: ctx?.hasUI
    });

    if (stage.action === 'pass') return undefined;
    if (stage.action === 'block') {
      writeLog(config.logPath, {
        stage: 'gate',
        toolName,
        outcome: 'blocked',
        errorCode: stage.code
      });
      return { block: true, reason: stage.reason };
    }

    const input = event?.input && typeof event.input === 'object' ? event.input : {};
    const request = readRequest(input);
    // Refused BEFORE the prompt is built: an unrenderable field's only purpose is to be
    // read by the human, so nothing is shown and the authority is never contacted. The
    // field's value is not logged either — the decision is the record.
    if (request.problem !== null) {
      writeLog(config.logPath, {
        stage: 'describe',
        toolName,
        outcome: 'blocked',
        errorCode: BLOCK_UNRENDERABLE.code,
        field: request.problem.field,
        problem: request.problem.reason
      });
      return { block: true, reason: BLOCK_UNRENDERABLE.reason };
    }

    if (request.namespace === '' || request.role === '' || request.scopes.length === 0) {
      writeLog(config.logPath, {
        stage: 'describe',
        toolName,
        outcome: 'blocked',
        errorCode: BLOCK_UNDESCRIBABLE.code
      });
      return { block: true, reason: BLOCK_UNDESCRIBABLE.reason };
    }

    let selection;
    try {
      const prompt = `${PROMPT_TITLE}\n\n${buildPromptBody(request)}`;
      selection = await ctx.ui.select(prompt, [...SELECT_OPTIONS]);
    } catch {
      selection = undefined;
    }

    const verdict = decide({
      toolName,
      allowedServers: config.allowedServers,
      hasUI: true,
      selection
    });
    if (verdict.action !== 'inject') {
      writeLog(config.logPath, {
        stage: 'prompt',
        toolName,
        namespace: request.namespace,
        role: request.role,
        scopes: request.scopes,
        ttlSeconds: request.ttlSeconds,
        selection: normalizeSelection(selection) ?? null,
        outcome: 'blocked',
        errorCode: verdict.code
      });
      return { block: true, reason: verdict.reason };
    }

    if (
      typeof config.socketPath !== 'string' ||
      config.socketPath === '' ||
      typeof config.hookSecret !== 'string' ||
      config.hookSecret === ''
    ) {
      writeLog(config.logPath, {
        stage: 'config',
        toolName,
        outcome: 'blocked',
        errorCode: BLOCK_UNCONFIGURED.code
      });
      return { block: true, reason: BLOCK_UNCONFIGURED.reason };
    }

    let issued;
    try {
      issued = await enroll({
        socketPath: config.socketPath,
        timeoutMs: config.timeoutMs,
        payload: {
          op: 'enroll.request',
          namespace: request.namespace,
          role: request.role,
          scopes: request.scopes,
          ttlSeconds: request.ttlSeconds,
          hookSecret: config.hookSecret
        }
      });
    } catch (err) {
      writeLog(config.logPath, {
        stage: 'authority',
        toolName,
        namespace: request.namespace,
        role: request.role,
        outcome: 'blocked',
        errorCode: typeof err?.code === 'string' ? err.code : 'internal'
      });
      return { block: true, reason: BLOCK_AUTHORITY.reason };
    }

    writeLog(config.logPath, {
      stage: 'authority',
      toolName,
      namespace: request.namespace,
      role: request.role,
      scopes: request.scopes,
      ttlSeconds: request.ttlSeconds,
      outcome: 'approved',
      injected: true
    });

    return { input: { ...input, enrollmentCode: issued.code } };
  };
}

/**
 * OMP hook factory.
 * @param {{ on: Function }} pi
 */
export default function hook(pi) {
  if (!pi || typeof pi.on !== 'function') {
    throw new Error('walkie-enroll: hook API does not expose on()');
  }
  pi.on('tool_call', createEnrollHandler());
}
