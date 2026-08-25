/**
 * The operator's break-glass capability: `<runtimeRoot>/operator.cred`.
 *
 * Until this module existed, nothing in `src/` or `bin/` ever WROTE that file. `client/
 * credentials.js` read it, `cli/client.js` authenticated with it, the docs described it — and
 * the only writers in the repository were test helpers. A fresh install therefore had a working
 * daemon, a working agent enrollment path, and an operator CLI that could not authenticate a
 * single command. This is the same defect class that shipped an HTTP surface answering `/health`
 * while the authority socket was never bound: a fixture that constructs the subject cannot
 * notice the subject failing to construct itself.
 *
 * So the rule the boot order already encodes — readiness implies enrollment is possible — is
 * extended here: readiness implies the OPERATOR can act. This runs after the store is open (a
 * capability is a row, so there is nothing to mint before that) and before the HTTP transport
 * answers, so `/health` cannot report ready over an install whose operator is locked out.
 *
 * Four properties this file is careful about:
 *
 *  - **Idempotent.** A usable credential is left exactly as it is. Rotating on every `start`
 *    would silently invalidate a token a running CLI, script or `COLLABCAST_CAPABILITY` export
 *    already holds.
 *  - **Never a bypass.** The credential is an ordinary capability row with an ordinary
 *    derivation closure, so `collabcast revoke` kills it like any other. A present credential
 *    that no longer verifies is REFUSED, never replaced — auto-minting over a revoked token
 *    would turn revocation into a formality. Recovery is deliberate and requires the operator's
 *    own uid: delete the file and restart, which mints a fresh one.
 *  - **Atomic, 0600, inside the 0700 runtime dir.** Staged in a sibling temp file and published
 *    with `link`, exactly as `ensureSecret` does. `open(file,'wx')` then `write` was already
 *    found to leave a 0-byte 0600 file behind on an interrupted boot, and that state never
 *    clears itself; `link` also loses a race with EEXIST instead of clobbering the winner.
 *  - **The token never leaves.** The return value carries the PATH and the provenance, never the
 *    value — the same `{path, source}` split `ensureSecret` uses so the composition root cannot
 *    leak something it never holds. Operator-facing stderr may name the file; the
 *    `CollabcastError` envelope may not, because an envelope travels into peers, wire replies
 *    and audit rows.
 *
 * On lifetime: the capability is issued at the store's ceiling, `MAX_TTL_SECONDS` (one year).
 * This is the break-glass root of the manual path, so it is long-lived on purpose, but it is not
 * eternal — the ceiling exists because the store's timestamps are only lexicographically
 * ordered while the year stays four digits. A credential that has aged out lands in the same
 * refusal as a revoked one and is fixed the same way. Telling those two apart would need a
 * token lookup that ignores liveness, and a function shaped like that is one route away from
 * being an authentication bypass, so this file does not have one.
 */

import { chmodSync, closeSync, fsyncSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CollabcastError } from '../identity/errors.js';
// The writer borrows the READER's parser on purpose. `parseCredential` defines the file format
// — bare token, or the enrollment document with only `token` trusted — and a second parser here
// would be two definitions of one format with nothing proving they agree, which is the drift
// class this repository has already been bitten by. The dependency points at the format, not at
// the CLI: nothing else in `client/credentials.js` is reachable from here.
import { parseCredential } from '../client/credentials.js';
import { MAX_TTL_SECONDS } from '../store/clock.js';
import { issueCapability, revokeCapability, verifyCapability } from '../store/capabilities.js';
import { createPrincipal, listPrincipals } from '../store/principals.js';
import { audit } from '../store/audit.js';
import { scopesForRole } from './policy.js';
import {
  OPERATOR_CREDENTIAL_FILENAME,
  RUNTIME_FILE_MODE,
  ensureRuntimeDir,
  operatorCredentialPath
} from './paths.js';

/** The role the minted principal holds. */
export const OPERATOR_ROLE = 'operator';

/**
 * How the store records why this capability exists. `operator_cli` is the attestation kind the
 * schema already reserves for authority reached by a human at a terminal rather than through an
 * approval dialog, and possession of uid-restricted access to a 0700 runtime directory is
 * precisely that attestation.
 */
export const OPERATOR_ATTESTATION_KIND = 'operator_cli';

/** A fixed, path-free reference: `attestation_ref` ends up in audit rows. */
export const OPERATOR_ATTESTATION_REF = 'authority.operator_credential';

/** Long-lived by design, and bounded by the store's ceiling. See the module header. */
export const OPERATOR_CREDENTIAL_TTL_SECONDS = MAX_TTL_SECONDS;

/** Permission bits that must be clear on the credential file. */
const FORBIDDEN_MODE_BITS = 0o077;

/** What an operator does about a credential file that cannot be used. */
const RECREATE_REMEDY =
  `delete that file and restart the service, which mints a fresh operator credential ` +
  `(if you revoked it on purpose, that lockout is working — deleting the file is how you get ` +
  `back in, and it needs your own uid)`;

/** What an operator does about a credential that could not be written at all. */
const WRITABLE_REMEDY =
  'check that the runtime directory exists and is writable by this user, then restart the service';

/**
 * Where an operator-actionable diagnostic goes: stderr, because that is where a supervisor
 * surfaces a failed start and the human at that terminal is the only party who can fix a wedged
 * credential file.
 *
 * @param {string} message
 */
function defaultReport(message) {
  process.stderr.write(`collabcast: ${message}\n`);
}

/**
 * A startup-time refusal, split across two channels on purpose — the same boundary
 * `secret.js`'s `secretFileFault` draws, for the same reason. The OPERATOR gets the path and the
 * remedy; the ERROR ENVELOPE gets neither.
 *
 * @param {(msg:string) => void} report
 * @param {{problem:string, path:string, remedy:string, detail?:object}} fault
 */
function credentialFileFault(report, { problem, path, remedy, detail }) {
  report(`${problem}: ${path} — ${remedy}`);
  return new CollabcastError(
    'config_invalid',
    `${problem}; the file and the fix are on stderr`,
    detail
  );
}

/**
 * Reads the credential already on disk and decides whether it is usable.
 *
 * @param {{store:object, path:string, report:(msg:string) => void}} opts
 * @returns {{capabilityId:string, principalId:string}|null} null when the file is absent
 */
function inspectExisting({ store, path, report }) {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw credentialFileFault(report, {
      problem: `the operator credential could not be read (${err?.code ?? 'unknown'})`,
      path,
      remedy: WRITABLE_REMEDY,
      detail: { reason: err?.code ?? 'unknown' }
    });
  }
  if (!stat.isFile()) {
    throw credentialFileFault(report, {
      problem: 'the operator credential is not a regular file',
      path,
      remedy: RECREATE_REMEDY
    });
  }
  if ((stat.mode & FORBIDDEN_MODE_BITS) !== 0) {
    const mode = (stat.mode & 0o777).toString(8);
    // Refused rather than clamped: a credential that has been world-readable must be treated as
    // disclosed, and quietly chmodding it would hide that it ever was.
    throw credentialFileFault(report, {
      problem: `the operator credential is readable beyond its owner (mode 0${mode})`,
      path,
      remedy: `it holds a root capability, so treat it as disclosed: \`collabcast revoke\` it, delete ${OPERATOR_CREDENTIAL_FILENAME} and restart the service`,
      detail: { mode }
    });
  }

  let credential;
  try {
    credential = parseCredential(readFileSync(path, 'utf8'), 'the operator credential');
  } catch (err) {
    throw credentialFileFault(report, {
      problem: `the operator credential could not be parsed (${err?.code ?? 'unknown'})`,
      path,
      remedy: RECREATE_REMEDY,
      detail: { reason: err?.code ?? 'unknown' }
    });
  }

  const verified = verifyCapability(store, credential.token);
  if (!verified) {
    throw credentialFileFault(report, {
      problem:
        'the operator credential names a capability this namespace will not honour — revoked, ' +
        'expired, or issued by a store that no longer exists',
      path,
      remedy: RECREATE_REMEDY
    });
  }
  return { capabilityId: verified.capability.id, principalId: verified.principal.id };
}

/**
 * Mints the capability. Principal reuse is deliberate: an operator who deleted the file to
 * recover is the same human, and a fresh principal per boot would scatter their identity (and
 * their cursor) across rows. A REVOKED operator principal is never reused — revoking the
 * principal is the stronger act, and honouring it means starting over.
 *
 * One transaction, and `runTx` uses `BEGIN IMMEDIATE`, so concurrent services are serialized
 * here: exactly one of them can find no incumbent, and every other one reuses what it inserted.
 * That is what keeps a cold double-boot from producing two operator identities.
 *
 * @param {{store:object}} opts
 * @returns {{token:string, capabilityId:string, principalId:string, scopes:string[]}}
 */
function mintCapability({ store }) {
  return store.tx((tx) => {
    const [incumbent] = listPrincipals(tx, { role: OPERATOR_ROLE });
    const principal = incumbent ?? createPrincipal(tx, { role: OPERATOR_ROLE, displayAlias: null });
    const scopes = scopesForRole(OPERATOR_ROLE);
    const { capabilityId, token } = issueCapability(tx, {
      principalId: principal.id,
      scopes,
      ttlSeconds: OPERATOR_CREDENTIAL_TTL_SECONDS,
      attestationKind: OPERATOR_ATTESTATION_KIND,
      attestationRef: OPERATOR_ATTESTATION_REF
    });
    audit(tx, {
      actorPrincipalId: principal.id,
      action: 'operator.credential.minted',
      subject: capabilityId,
      outcome: 'issued',
      detail: { principalId: principal.id, scopes, reusedPrincipal: incumbent !== undefined }
    });
    return { token, capabilityId, principalId: principal.id, scopes };
  });
}

/**
 * Publishes `token` at `path` without ever letting the final path exist half-written.
 *
 * @param {{token:string, path:string, report:(msg:string) => void}} opts
 * @returns {boolean} false when another process published first
 */
function publish({ token, path, report }) {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', RUNTIME_FILE_MODE);
  } catch (err) {
    throw credentialFileFault(report, {
      problem: `the operator credential could not be staged (${err?.code ?? 'unknown'})`,
      path: tmp,
      remedy: WRITABLE_REMEDY,
      detail: { reason: err?.code ?? 'unknown' }
    });
  }
  try {
    try {
      writeSync(fd, `${token}\n`, 0, 'utf8');
      // Durable before visible: publishing an inode whose bytes are still in page cache would
      // reintroduce the empty-file wedge across a host crash.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, RUNTIME_FILE_MODE);
    linkSync(tmp, path);
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw credentialFileFault(report, {
      problem: `the operator credential could not be created (${err?.code ?? 'unknown'})`,
      path,
      remedy: WRITABLE_REMEDY,
      detail: { reason: err?.code ?? 'unknown' }
    });
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* the staging file is already gone */
    }
  }
  return true;
}

/**
 * Resolves the operator credential, minting and persisting one when absent.
 *
 * @param {{store:object, runtimeRoot:string, path?:string,
 *          onReport?:(msg:string) => void}} opts `onReport` receives the operator-facing
 *          diagnostic — the one that names the file and the fix.
 * @returns {{path:string, source:'file'|'created', capabilityId:string, principalId:string}}
 */
export function ensureOperatorCredential({ store, runtimeRoot, path, onReport = defaultReport } = {}) {
  if (!store || typeof store.tx !== 'function') {
    throw new CollabcastError('internal', 'an open store is required to mint an operator credential');
  }
  const file = path ?? operatorCredentialPath(runtimeRoot);
  if (path === undefined) ensureRuntimeDir(runtimeRoot);

  const existing = inspectExisting({ store, path: file, report: onReport });
  if (existing) return { path: file, source: 'file', ...existing };

  const minted = mintCapability({ store });
  if (!publish({ token: minted.token, path: file, report: onReport })) {
    // Another boot published first; its credential is the live one. Ours can never be presented
    // by anybody — the only copy of the token is the local we are about to drop — so the
    // capability is revoked rather than left as a live row nothing holds.
    //
    // The CAPABILITY only, never the principal. `runTx` uses `BEGIN IMMEDIATE`, so writers are
    // serialized and exactly one racer ever inserts the operator principal; every other racer
    // reuses it. That includes the winner. A loser that "tidied up" the principal it happened to
    // insert would therefore revoke the identity behind the credential that just won — turning a
    // lost race into a locked-out operator, with revocation cascading over the winner's row.
    store.tx((tx) => {
      revokeCapability(tx, minted.capabilityId, 'operator-credential-race-loser');
      audit(tx, {
        actorPrincipalId: minted.principalId,
        action: 'operator.credential.minted',
        subject: minted.capabilityId,
        outcome: 'discarded',
        detail: { reason: 'another service published the credential first' }
      });
    });
    const winner = inspectExisting({ store, path: file, report: onReport });
    if (!winner) {
      throw credentialFileFault(onReport, {
        problem:
          'the operator credential appeared while this process was writing one, then vanished',
        path: file,
        remedy: RECREATE_REMEDY
      });
    }
    return { path: file, source: 'file', ...winner };
  }

  return {
    path: file,
    source: 'created',
    capabilityId: minted.capabilityId,
    principalId: minted.principalId
  };
}
