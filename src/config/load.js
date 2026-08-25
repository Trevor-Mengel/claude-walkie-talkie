import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { NOT_A_REPO_RE, runGit } from '../core/git.js';
import { WalkieError } from '../identity/errors.js';
import { canonicalizePath } from '../identity/paths.js';
import { configPath, validateConfig } from './schema.js';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Reads and validates `<canonicalRoot>/.walkie-talkie/config.json`, applying schema defaults for
 * absent optional keys, and returns it deeply frozen.
 *
 * @param {{canonicalRoot:string, path?:string, expectNamespace?:string, storeDir?:string}} opts
 */
export function loadConfig({ canonicalRoot, path, expectNamespace, storeDir } = {}) {
  if (typeof canonicalRoot !== 'string' || canonicalRoot.length === 0) {
    throw new WalkieError('config_invalid', 'loadConfig requires canonicalRoot');
  }
  const root = canonicalizePath(canonicalRoot);
  const file = path === undefined ? configPath(root) : canonicalizePath(path);

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new WalkieError('not_found', `no walkie config at ${file}`, { path: file });
    }
    throw new WalkieError(
      'config_invalid',
      `walkie config is unreadable: ${file} (${err.code || 'read error'})`,
      { path: file }
    );
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new WalkieError('config_invalid', `walkie config is not valid JSON: ${err.message}`, {
      path: file
    });
  }

  return deepFreeze(validateConfig(raw, { canonicalRoot: root, expectNamespace, storeDir }));
}

// `runGit` and `NOT_A_REPO_RE` moved to core/git.js when identity/resolve.js had to
// classify the same failures: which repository owns a directory has to fail closed for
// exactly the reasons a tracked-path check does, and one rule cannot live in two files.

/**
 * Walks up to the nearest existing directory. History targets are checked BEFORE they are
 * created, so the path itself (and its parent) may not exist yet; git still needs a real cwd.
 * Walking up can only leave a repository when no repository contains the path at all.
 */
function nearestExistingDir(start) {
  let dir = start;
  for (;;) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // fall through and try the parent
    }
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/**
 * Confirms a path is safe to write walkie history/snapshot material into: it must be BOTH
 * git-ignored AND untracked, so a prune or snapshot can never mutate version-controlled files.
 *
 * A tracked path is rejected even when an ignore rule also matches it.
 *
 * @param {string} target
 * @param {{repoRoot?:string, env?:Record<string,string|undefined>}} [opts]
 * @returns {{ok:boolean, reason:'ignored-and-untracked'|'not-ignored'|'tracked'|'not-a-repo'|
 *   'git-indeterminate'|'git-unavailable', path:string}}
 */
export function verifyPathExcluded(target, { repoRoot, env } = {}) {
  const path = canonicalizePath(target);
  const cwd = nearestExistingDir(
    repoRoot === undefined ? dirname(path) : canonicalizePath(repoRoot)
  );

  const inRepo = runGit(['rev-parse', '--is-inside-work-tree'], { cwd, env });
  if (inRepo.spawnFailed) return { ok: false, reason: 'git-unavailable', path };
  const insideWorkTree = inRepo.stdout.trim();
  if (inRepo.status !== 0 || insideWorkTree !== 'true') {
    // A clean `false` (a bare repo, or a cwd inside `.git`) and an explicit
    // "not a repository" refusal are the only states in which nothing here can be
    // tracked. Every other failure is git declining to answer.
    const noRepo =
      inRepo.status === 0 ? insideWorkTree === 'false' : NOT_A_REPO_RE.test(inRepo.stderr);
    return noRepo
      ? { ok: true, reason: 'not-a-repo', path }
      : { ok: false, reason: 'git-indeterminate', path };
  }

  const tracked = runGit(['ls-files', '--error-unmatch', '--', path], { cwd, env });
  if (tracked.spawnFailed) return { ok: false, reason: 'git-unavailable', path };
  if (tracked.status === 0) return { ok: false, reason: 'tracked', path };

  const ignored = runGit(['check-ignore', '-q', '--', path], { cwd, env });
  if (ignored.spawnFailed) return { ok: false, reason: 'git-unavailable', path };
  if (ignored.status !== 0) return { ok: false, reason: 'not-ignored', path };

  return { ok: true, reason: 'ignored-and-untracked', path };
}

/**
 * Throws `config_invalid` unless `target` is git-excluded — the strict form, which refuses on
 * every non-ok reason including `not-ignored` and `git-indeterminate`.
 *
 * The paths walkie writes on the message path (`channel.md`, `.sessions/`) are checked ONCE at
 * service start by `assertChannelStateExcluded` below, not per write. Use this one for a
 * write that is rare, destructive and operator-initiated — a retention prune or a snapshot
 * rollback — where paying for a git call, and refusing on anything short of proven-excluded,
 * is the right trade.
 *
 * @param {string} target
 * @param {{repoRoot?:string, env?:Record<string,string|undefined>}} [opts]
 */
export function assertPathExcluded(target, opts = {}) {
  const result = verifyPathExcluded(target, opts);
  if (!result.ok) {
    throw new WalkieError(
      'config_invalid',
      `${result.path} is not safe for walkie history writes (${result.reason})`,
      { path: result.path, reason: result.reason }
    );
  }
  return result;
}

/**
 * Boot-time guard for the walkie state a repository must never track: `channel.md`
 * (the document every agent reads into its context, and an input the watcher honours
 * on external edit) and `.sessions/` (where `appendRevision` writes edit history on
 * every message edit).
 *
 * A committed `channel.md` ships a poisoned channel to every clone; a committed
 * `.sessions/` means walkie mutates version-controlled files on every edit. Both are
 * misconfiguration a human has to fix, so this runs ONCE at service start rather than
 * on the write hot path — loud at boot beats silent on the first edit.
 *
 * Only `tracked` is fatal, because only `tracked` is a fact: the file IS in version
 * control. `not-ignored` (untracked, no ignore rule yet — `walkie init` writes one),
 * `git-indeterminate` and `git-unavailable` are all states where refusing to boot
 * would take the service down over a broken git config rather than over walkie state,
 * so they warn instead. Outside a repository there is nothing to check.
 *
 * @param {{channelPath:string, sessionsDir:string, repoRoot?:string,
 *   env?:Record<string,string|undefined>, warn?:(message:string)=>void}} opts
 * @returns {Array<{label:string, result:object}>} every path checked, in order
 */
export function assertChannelStateExcluded({
  channelPath,
  sessionsDir,
  repoRoot,
  env,
  warn = (message) => process.stderr.write(`${message}\n`)
} = {}) {
  const targets = [
    ['channel.md', channelPath],
    ['.walkie-talkie/.sessions', sessionsDir]
  ].filter(([, target]) => typeof target === 'string' && target.length > 0);

  const checked = [];
  for (const [label, target] of targets) {
    const result = verifyPathExcluded(target, { repoRoot, env });
    checked.push({ label, result });
    if (result.reason === 'tracked') {
      throw new WalkieError(
        'config_invalid',
        `${label} is tracked in git (${result.path}). Walkie writes to it, so a commit ` +
          'would version local channel state and let a clone ship a forged channel. Run ' +
          `\`git rm -r --cached ${result.path}\` and add \`.walkie-talkie/\` to .gitignore, ` +
          'then start again.',
        { path: result.path, reason: result.reason, label }
      );
    }
    if (!result.ok) {
      warn(
        `walkie: ${label} is not git-excluded (${result.reason}): ${result.path}. Add ` +
          '`.walkie-talkie/` to .gitignore so local channel state is never committed.'
      );
    }
  }
  return checked;
}
