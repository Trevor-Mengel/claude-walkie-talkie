import { collabcastError } from '../identity/errors.js';
import { DEFAULT_ENROLL_TTL_SECONDS, scopesForRole } from '../authority/policy.js';
import { clientForProject } from './client.js';

/**
 * Roles a delegated capability may hold. Mirrors the fence in
 * `src/daemon/routes/enroll.js`; the route is authoritative and re-checks, this is only so a
 * typo is caught before a round trip. `root` and `operator` are never delegated.
 */
export const DELEGABLE_ROLES = Object.freeze(['goal_hub', 'listener']);

/** A read-only listener: enough to follow the channel, not enough to write to it. */
export const DEFAULT_SCOPES = Object.freeze(['channel:read', 'self:cursor']);

const NORMAL_PATH =
  'Normal enrollment is initiated by the agent: it calls collabcast_enroll, the approval hook ' +
  'shows you what is being requested, and your approval issues a one-use code. Use ' +
  '`collabcast enroll --recovery` only when that path is unavailable — it mints a capability ' +
  'directly from your operator credential, with no approval dialog.';

function parseRole(raw) {
  const role = raw === undefined ? 'listener' : String(raw).trim();
  if (!DELEGABLE_ROLES.includes(role)) {
    throw collabcastError('invalid_request', `--role must be one of ${DELEGABLE_ROLES.join(', ')}`, {
      role
    });
  }
  return role;
}

function parseScopes(raw, role) {
  const requested =
    raw === undefined
      ? [...DEFAULT_SCOPES]
      : String(raw)
          .split(/[,\s]+/)
          .map((scope) => scope.trim())
          .filter((scope) => scope !== '');
  if (requested.length === 0) {
    throw collabcastError('invalid_request', '--scopes was given but listed no scopes');
  }
  const allowed = scopesForRole(role);
  const outside = requested.filter((scope) => !allowed.includes(scope));
  if (outside.length) {
    throw collabcastError(
      'invalid_request',
      `role ${role} may not hold ${outside.join(', ')}. It may hold: ${allowed.join(', ')}`,
      { role, rejected: outside }
    );
  }
  return [...new Set(requested)].sort();
}

function parseTtl(raw) {
  if (raw === undefined) return DEFAULT_ENROLL_TTL_SECONDS;
  const ttl = Number(raw);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw collabcastError('invalid_request', '--ttl must be a positive whole number of seconds');
  }
  return ttl;
}

/**
 * Break-glass enrollment.
 *
 * Authenticated by the operator credential file, this mints a delegated capability and prints
 * its token exactly once. It is the only place in this package that shows a token to anybody,
 * and only because handing it to a human is the entire point of a break-glass path: the
 * ordinary route is the agent asking and the operator approving in a dialog.
 */
export async function enrollCommand(opts = {}) {
  if (!opts.recovery) {
    throw collabcastError('invalid_request', `refusing to enroll without --recovery. ${NORMAL_PATH}`);
  }
  const role = parseRole(opts.role);
  const scopes = parseScopes(opts.scopes, role);
  const ttlSeconds = parseTtl(opts.ttl);

  const { api, context } = clientForProject();
  const issued = await api.delegate({
    role,
    scopes,
    ttlSeconds,
    paseoAgentId: opts.paseoAgentId
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(issued, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `${[
      `Issued a ${issued.role ?? role} capability on namespace ${context.namespace}.`,
      `  principal:  ${issued.principalId}`,
      `  capability: ${issued.capabilityId}`,
      `  scopes:     ${(issued.scopes ?? scopes).join(', ')}`,
      `  expires:    ${issued.expiresAt ?? 'never'}`,
      '',
      'Token (shown once; this command writes it nowhere):',
      `  ${issued.token}`,
      '',
      'Give it to the agent as COLLABCAST_CAPABILITY. If you must write it down, the file must be',
      `mode 0600. Revoke it with \`collabcast revoke ${issued.capabilityId}\`.`
    ].join('\n')}\n`
  );
}

/** Revoke a capability by id. Cascades to anything delegated from it. */
export async function revokeCommand(capabilityId) {
  const { api } = clientForProject();
  await api.revokeCapability(capabilityId);
  process.stdout.write(`Revoked ${capabilityId} and everything delegated from it.\n`);
}
