/**
 * The MCP server's capability holder — what replaced the v0.2 session singleton.
 *
 * v0.2 joined `POST /sessions/join` once per process and cached `{ sessionId, alias, tool }`
 * forever. Identity was whatever the client declared, and when the server stopped believing
 * it, some tools kept working while others 404'd, so a session could look healthy while being
 * unable to read. This holder fixes both halves:
 *
 * - identity is never declared. It comes from `GET /self`, resolved from the bearer token, so
 *   role, scopes and expiry are the server's answer and not the client's claim.
 * - there is one authority state for the whole process. The moment any call comes back
 *   `unauthenticated` the holder goes invalid, and every tool then fails the same way with the
 *   same actionable message instead of failing inconsistently per route.
 * - "cannot confirm" is not "refused". The four states are `unenrolled` (nothing held),
 *   `active` (held and confirmed), `unverified` (held, unconfirmed because the service could
 *   not be reached) and `invalid` (held and refused, so discarded). Only a refusal reaches
 *   `invalid`; anything else parks in `unverified` with the credential intact and recovers via
 *   `revalidate()`, because the token was bought with a one-use operator approval and a
 *   connection error must not spend a second one.
 *
 * The token lives in a box this module writes and the HTTP client reads. It is never returned
 * from a method, never logged and never placed in an error.
 */

import { credentialDrift, credentialFromEnv } from '../client/credentials.js';
import { isCollabcastError, collabcastError } from '../identity/errors.js';

/**
 * An enrollment code is `randomBytes(32).toString('base64url')` — exactly 43 base64url
 * characters. The shape is checked before anything is sent so that a code the model invented
 * is rejected locally, with an explanation, instead of being smuggled to the authority.
 */
export const ENROLLMENT_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/** @typedef {'unenrolled'|'active'|'unverified'|'invalid'} CapabilityState */

/**
 * The only server answers that mean the credential itself is no good.
 *
 * This set exists because the holder used to treat EVERY failure of `GET /self` as credential
 * invalidity. A service that was merely down, or a socket that hiccuped, therefore made the
 * holder discard a token that had just been minted — and minting it consumed a ONE-USE operator
 * approval. The operator's click is a human action, so destroying it over a connection refusal
 * is not a papercut: the model was told the capability was "expired or revoked", enrolled again,
 * and asked a person to approve a second time for no reason.
 *
 * - `unauthenticated`: the bearer was presented and refused. Definitive.
 * - `forbidden`: the principal is not allowed to resolve itself, which a live capability always
 *   is; the credential is not usable here.
 * - `wrong_namespace`: a real credential for a different channel. It will never work against
 *   this endpoint, so re-enrolling in this namespace is the correct remedy.
 *
 * Deliberately absent: `scope_required` (a narrow capability is narrow, not invalid),
 * `unavailable`, `internal`, `not_found`, `conflict` and everything else — none of them is the
 * server refusing this credential, so none of them may throw it away.
 */
const REFUSAL_CODES = new Set(['unauthenticated', 'forbidden', 'wrong_namespace']);

function defaultWarn(message) {
  // stderr: stdout is the MCP transport.
  process.stderr.write(`[collabcast-mcp] ${message}\n`);
}

const UNENROLLED_MESSAGE =
  'this session holds no collabcast capability. Either the supervisor injects one as ' +
  'COLLABCAST_CAPABILITY, or call collabcast_enroll and have the operator approve the request.';

const INVALID_MESSAGE =
  'this session\'s collabcast capability is no longer accepted (expired or revoked). Every ' +
  'channel operation will fail until a new one is issued: call collabcast_enroll to request ' +
  'operator approval again.';

const UNVERIFIED_MESSAGE =
  'this session holds a collabcast capability that has not been confirmed yet, because the collabcast ' +
  'service could not be reached. The capability is intact and still held: do NOT call ' +
  'collabcast_enroll, which would ask the operator to approve a second time for nothing. Make sure ' +
  'the service for this namespace is running and retry.';

/** The sentence appended when a credential survives a failure, so the model does not re-enroll. */
const RETAINED_NOTE =
  ' The capability is still held and is unchanged — this was not a refusal of your credential, ' +
  'so do not enroll again; retry once the service is reachable.';

/**
 * @param {object} opts
 * @param {object} opts.api the unguarded API client (this module handles its own failures)
 * @param {{value:string|null}} opts.tokenBox the box the HTTP client reads the bearer from
 * @param {string} opts.namespace
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {(message:string)=>void} [opts.warn]
 */
export function createCapabilityHolder({ api, tokenBox, namespace, env = process.env, warn = defaultWarn }) {
  /** @type {CapabilityState} */
  let state = 'unenrolled';
  /** @type {null|{principalId:string, role:string, displayAlias:string|null, scopes:string[], capabilityId:string, expiresAt:string|null}} */
  let identity = null;
  let driftReported = false;
  /** The `claimed` block that came with the held token, so `revalidate` can still report drift. */
  /** @type {Record<string,unknown>|null} */
  let pendingClaimed = null;

  /** Discard the credential. Only ever called for a real refusal. */
  function clear(next) {
    state = next;
    identity = null;
    pendingClaimed = null;
    tokenBox.value = null;
  }

  function reportDrift(claimed, authoritative) {
    if (driftReported || !claimed) return;
    const drifted = credentialDrift(claimed, authoritative);
    if (claimed.namespace !== undefined && claimed.namespace !== namespace) {
      drifted.push('namespace');
    }
    if (drifted.length === 0) return;
    driftReported = true;
    // A stale injection is a real signal. Field names only — never values, one of which
    // could be a namespace the caller has no business asserting.
    warn(
      `injected credential disagrees with the service on ${drifted.sort().join(', ')}; ` +
        'the service is authoritative and its answer is being used'
    );
  }

  /**
   * Resolve identity from the server for the token currently in the box.
   * @param {Record<string,unknown>|null} claimed
   */
  async function resolve(claimed) {
    const self = await api.self();
    identity = {
      principalId: self.principalId,
      role: self.role,
      displayAlias: self.displayAlias ?? null,
      scopes: Array.isArray(self.scopes) ? [...self.scopes] : [],
      capabilityId: self.capabilityId,
      expiresAt: self.expiresAt ?? null
    };
    state = 'active';
    reportDrift(claimed, identity);
    return identity;
  }

  /**
   * Classify a failed `resolve` and decide the credential's fate.
   *
   * Only a refusal (see REFUSAL_CODES) may discard the token. Everything else — the service
   * being down, a socket error, a timeout, an unreadable body — leaves the token exactly where
   * it was and parks the holder in `unverified`, from which `revalidate()` recovers with no new
   * operator approval. The thrown error keeps its original code so a caller can still branch on
   * `unavailable` versus `unauthenticated`; only the message gains the retention note.
   *
   * @param {unknown} err
   * @returns {never}
   */
  function noteResolveFailure(err) {
    const code = isCollabcastError(err) ? err.code : null;
    if (code && REFUSAL_CODES.has(code)) {
      clear('invalid');
      throw err;
    }
    // Credential retained. `state` is not `active` because identity is unknown, but the token
    // in the box is still the one the operator approved.
    state = 'unverified';
    identity = null;
    // The original context (namespace, mode, timeout) is part of what makes the remedy
    // actionable, so it is carried through; our two fields are added last and always win.
    const detail = {
      ...(isCollabcastError(err) && err.detail && typeof err.detail === 'object' ? err.detail : {}),
      capabilityState: 'unverified',
      credentialRetained: true
    };
    throw collabcastError(
      code ?? 'internal',
      (code ? err.message : 'the collabcast service could not confirm this capability') +
        RETAINED_NOTE,
      detail
    );
  }

  return {
    state: () => state,

    /**
     * Adopt a supervisor-injected credential, if there is one. Returns false when nothing was
     * injected, which is not an error: the model may still enroll.
     */
    async adoptInjected() {
      const credential = credentialFromEnv(env);
      if (!credential) return false;
      tokenBox.value = credential.token;
      pendingClaimed = credential.claimed;
      try {
        await resolve(credential.claimed);
      } catch (err) {
        noteResolveFailure(err);
      }
      return true;
    },

    /**
     * Adopt a freshly issued capability. `claimed` is the non-token part of the issuing
     * response, kept only so drift against `GET /self` can be reported.
     *
     * Issuing this token consumed a one-use operator approval, so a failure to CONFIRM it is
     * never allowed to throw it away unless the server actually refused it.
     *
     * @param {string} token
     * @param {Record<string,unknown>|null} [claimed]
     */
    async adopt(token, claimed = null) {
      if (typeof token !== 'string' || token.trim() === '') {
        throw collabcastError('internal', 'enrollment returned no capability token');
      }
      tokenBox.value = token.trim();
      pendingClaimed = claimed;
      try {
        return await resolve(claimed);
      } catch (err) {
        noteResolveFailure(err);
      }
    },

    /**
     * Re-confirm a credential the holder kept but could not verify. This is the recovery path
     * out of `unverified`, and it exists so the remedy for a transient failure is a retry
     * rather than a second trip to the operator.
     */
    async revalidate() {
      if (state === 'active') return identity;
      if (state !== 'unverified' || !tokenBox.value) {
        // Nothing is held, or what was held was refused. `requireActive` owns that message.
        return this.requireActive();
      }
      try {
        return await resolve(pendingClaimed);
      } catch (err) {
        noteResolveFailure(err);
      }
    },

    /** Throws the one actionable error for a session that cannot act. */
    requireActive() {
      if (state === 'active') return identity;
      if (state === 'unverified') {
        // Not `unauthenticated`: nothing rejected this credential. `unavailable` is the code
        // that says "the service isn't there, here's the remedy" — and the remedy is a retry,
        // not another operator approval.
        throw collabcastError('unavailable', UNVERIFIED_MESSAGE, { capabilityState: state });
      }
      throw collabcastError(
        'unauthenticated',
        state === 'invalid' ? INVALID_MESSAGE : UNENROLLED_MESSAGE,
        { capabilityState: state }
      );
    },

    /** Server-resolved identity, or null when this session cannot act. */
    identity: () => (state === 'active' ? { ...identity } : null),

    /**
     * Record that the service rejected our bearer. One 401 invalidates the whole process so
     * every subsequent tool fails identically rather than some succeeding.
     */
    noteUnauthenticated() {
      if (state === 'unenrolled') return;
      clear('invalid');
    },

    /** Re-read this principal's alias from the roster (it can be renamed out of band). */
    async refreshAlias() {
      const active = this.requireActive();
      const { principals } = await api.principals();
      const mine = (principals ?? []).find((p) => p.id === active.principalId);
      if (mine && identity) identity.displayAlias = mine.displayAlias ?? null;
      return identity?.displayAlias ?? null;
    },

    /** Record a locally applied alias change so the next read does not need the roster. */
    setDisplayAlias(alias) {
      if (identity) identity.displayAlias = alias;
    }
  };
}
