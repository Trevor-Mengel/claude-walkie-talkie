/**
 * The shared secret the OMP enrollment hook authenticates with.
 *
 * The hook runs in the operator's OMP process, not ours, so it cannot present a
 * capability token — it has not enrolled yet, that is the whole point. What it can
 * hold is a secret only a process with the operator's uid could have read: a 0600
 * file inside a 0700 directory, or an env var the operator exported. Possession of
 * that secret is the attestation that a human sat in front of the approval dialog.
 *
 * Rules that hold everywhere in this file:
 *  - the secret is returned only to the comparison path; nothing here writes it to a
 *    log, an audit row, or an error message, and no exported function that produces
 *    audit/log material has access to it;
 *  - a secret file with permissions wider than 0600 is a refusal, not a warning: a
 *    group- or world-readable hook secret is an authority bypass;
 *  - comparison is constant time over fixed-length digests, so neither the contents
 *    nor the length of the real secret leaks through timing;
 *  - the secret's PATH is not the secret, but it still does not travel. A startup refusal names
 *    the file and the fix on the OPERATOR channel (stderr, via `onReport`) because they are the
 *    only party who can fix a wedged secret file; the CollabcastError envelope carries neither,
 *    because an envelope reaches peers, wire replies and audit rows. `secretFileFault` is that
 *    boundary, and `secret.test.js` pins both halves of it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs';
import { CollabcastError } from '../identity/errors.js';
import { ensureRuntimeDir, hookSecretPath, RUNTIME_FILE_MODE } from './paths.js';

/** Env var the hook and the authority agree on (see omp-extension/collabcast-enroll.js). */
export const SECRET_ENV = 'COLLABCAST_HOOK_SECRET';

/** 32 bytes, base64url — 43 characters, same shape as every other collabcast secret. */
export const SECRET_BYTES = 32;

/** A shorter secret is not a secret; refuse to load one. */
export const MIN_SECRET_LENGTH = 16;

/** Permission bits that must be clear on the secret file. */
const FORBIDDEN_MODE_BITS = 0o077;

/** What an operator does about a secret file that cannot be used. */
const RECREATE_REMEDY = 'delete that file and restart the service, which mints a fresh secret';

/** What an operator does about a secret file that could not be written at all. */
const WRITABLE_REMEDY =
  'check that the runtime directory exists and is writable by this user, then restart the service';

/**
 * Where an operator-actionable diagnostic goes.
 *
 * stderr, because that is where the supervisor reads a failed start from (see the entry point in
 * `daemon/daemon-entry.js`) and because the only person who can fix a wedged secret file is the
 * human at that terminal.
 *
 * @param {string} message
 */
function defaultReport(message) {
  process.stderr.write(`collabcast: ${message}\n`);
}

/**
 * A startup-time refusal, split across two channels on purpose.
 *
 * The OPERATOR gets the path and the remedy. They are the only party who can act, and
 * withholding the file name is what turned an interrupted write into a boot that failed with
 * nothing to act on.
 *
 * The ERROR ENVELOPE gets neither. An envelope travels: into a peer's context, into a wire reply,
 * into an audit row, into whatever diagnostics persist it. A runtime path in a structure that
 * travels is a quiet disclosure, which is the rule `identity/errors.js` states and
 * `secret.test.js` pins. Same failure, two audiences, and the boundary between them is this
 * function — so a later change cannot move the path across it by accident.
 *
 * @param {(msg:string) => void} report
 * @param {{problem:string, path:string, remedy:string, detail?:object}} fault
 */
function secretFileFault(report, { problem, path, remedy, detail }) {
  report(`${problem}: ${path} — ${remedy}`);
  return new CollabcastError(
    'config_invalid',
    `${problem}; the file and the fix are on stderr`,
    detail
  );
}

/**
 * Constant-time equality for two secrets.
 *
 * Both sides are hashed first, so the comparison is always over 32 bytes and a
 * length mismatch cannot be observed through timing. Non-strings, empty strings and
 * length mismatches all return false; nothing here throws, because a comparison that
 * throws inside an auth check turns a denial into a crash.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function compareSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  // Both digests are 32 bytes by construction, so `timingSafeEqual` can never throw
  // on a length mismatch here — the guard is the digest, not a length comparison,
  // which is also why an unequal-length secret costs the same time as an equal one.
  return timingSafeEqual(left, right);
}

/** @returns {string} a fresh secret; the only copy is the return value. */
export function generateSecret() {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{path:string, report:(msg:string) => void}} [file] set when the value came from a file
 * @returns {string}
 */
function requireUsable(value, label, file) {
  const secret = typeof value === 'string' ? value.trim() : '';
  if (secret.length === 0) {
    if (file === undefined) throw new CollabcastError('config_invalid', `${label} is empty`);
    // An empty secret file is what an interrupted write leaves behind, and it is not
    // self-healing: the file exists at 0600, so every later boot reads it, refuses it and
    // stops. The operator gets the file name and the one-line fix.
    throw secretFileFault(file.report, {
      problem: `${label} is empty, which is what an interrupted write leaves behind`,
      path: file.path,
      remedy: RECREATE_REMEDY
    });
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    const detail = { minLength: MIN_SECRET_LENGTH };
    if (file === undefined) {
      throw new CollabcastError('config_invalid', `${label} is too short to be a secret`, detail);
    }
    throw secretFileFault(file.report, {
      problem: `${label} is too short to be a secret`,
      path: file.path,
      remedy: RECREATE_REMEDY,
      detail
    });
  }
  return secret;
}

/**
 * Reads the secret file, refusing anything that is not an owner-only regular file.
 *
 * Every refusal tells the operator which file and what to do, and tells the error envelope
 * neither — see `secretFileFault` for the boundary and why it is where it is.
 *
 * @param {string} path
 * @param {(msg:string) => void} report
 * @returns {string}
 */
function readSecretFile(path, report) {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    throw secretFileFault(report, {
      problem: `the hook secret file could not be read (${err?.code ?? 'unknown'})`,
      path,
      remedy: WRITABLE_REMEDY,
      detail: { reason: err?.code ?? 'unknown' }
    });
  }
  if (!stat.isFile()) {
    throw secretFileFault(report, {
      problem: 'the hook secret is not a regular file',
      path,
      remedy: RECREATE_REMEDY
    });
  }
  if ((stat.mode & FORBIDDEN_MODE_BITS) !== 0) {
    const mode = (stat.mode & 0o777).toString(8);
    throw secretFileFault(report, {
      problem: `the hook secret file is readable beyond its owner (mode 0${mode})`,
      path,
      remedy: `run \`chmod 600 ${path}\`, or delete it and restart the service`,
      detail: { mode }
    });
  }
  return requireUsable(readFileSync(path, 'utf8'), 'the hook secret file', { path, report });
}

/**
 * Resolves the hook secret: the env var wins, then the file.
 *
 * @param {{runtimeRoot?:string, path?:string, env?:Record<string,string|undefined>,
 *          onReport?:(msg:string) => void}} opts `onReport` receives the operator-facing
 *          diagnostic — the one that names the file and the fix.
 * @returns {{secret:string, source:'env'|'file'}|null} null when no secret is configured
 */
export function loadSecret({
  runtimeRoot,
  path,
  env = process.env,
  onReport = defaultReport
} = {}) {
  const fromEnv = env?.[SECRET_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { secret: requireUsable(fromEnv, `${SECRET_ENV}`), source: 'env' };
  }
  if (path === undefined && runtimeRoot === undefined) return null;
  const file = hookSecretPath(runtimeRoot, path);
  if (!existsSync(file)) return null;
  return { secret: readSecretFile(file, onReport), source: 'file' };
}

/**
 * Resolves the hook secret, minting and persisting one when absent.
 *
 * The secret is staged in a sibling temp file at 0600 — so it never exists at umask-derived
 * permissions, not even momentarily — and published under one atomic syscall. The containing
 * directory is clamped to 0700 first.
 *
 * @param {{runtimeRoot?:string, path?:string, env?:Record<string,string|undefined>,
 *          onReport?:(msg:string) => void}} opts
 * @returns {{secret:string, source:'env'|'file'|'created', path:string|null}}
 */
export function ensureSecret({
  runtimeRoot,
  path,
  env = process.env,
  onReport = defaultReport
} = {}) {
  const existing = loadSecret({ runtimeRoot, path, env, onReport });
  if (existing) {
    return {
      ...existing,
      path: existing.source === 'env' ? null : hookSecretPath(runtimeRoot, path)
    };
  }
  if (path === undefined && runtimeRoot === undefined) {
    throw new CollabcastError('config_invalid', 'a runtime directory is required to create a secret');
  }

  const file = hookSecretPath(runtimeRoot, path);
  if (path === undefined) ensureRuntimeDir(runtimeRoot);

  const secret = generateSecret();

  // Stage, then publish atomically. `open(file,'wx')` followed by `write` made the final path
  // exist before it held anything, so an interruption between those two syscalls left a 0-byte
  // 0600 file — and that state never clears itself: every later boot reads it, refuses it and
  // dies. Staging means `file` either does not exist or holds a whole secret.
  //
  // `link`, not `rename`, and that is the load-bearing choice: `rename` would clobber a secret
  // another authority published while we were writing, leaving that authority holding a secret
  // the hook no longer accepts. `link` is equally atomic and fails with EEXIST instead, which is
  // the race outcome this function has always honoured — the winner's secret is the live one.
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', RUNTIME_FILE_MODE);
  } catch (err) {
    throw secretFileFault(onReport, {
      problem: `the hook secret could not be staged (${err?.code ?? 'unknown'})`,
      path: tmp,
      remedy: WRITABLE_REMEDY,
      detail: { reason: err?.code ?? 'unknown' }
    });
  }
  try {
    try {
      writeSync(fd, `${secret}\n`, 0, 'utf8');
      // Durable before it is visible: publishing an inode whose bytes are still in page cache
      // would reintroduce the empty-file wedge across a host crash.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, RUNTIME_FILE_MODE);
    linkSync(tmp, file);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      // Another authority won the race; its secret is the live one, not ours.
      const winner = loadSecret({ runtimeRoot, path, env, onReport });
      if (!winner) {
        throw secretFileFault(onReport, {
          problem:
            'the hook secret file appeared while this process was writing one, but could not be read back',
          path: file,
          remedy: RECREATE_REMEDY
        });
      }
      return { ...winner, path: file };
    }
    throw secretFileFault(onReport, {
      problem: `the hook secret file could not be created (${err?.code ?? 'unknown'})`,
      path: file,
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
  return { secret, source: 'created', path: file };
}
