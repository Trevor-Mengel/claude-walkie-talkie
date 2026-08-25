import { execFileSync } from 'node:child_process';

/**
 * Environment variables that redirect git's repository discovery. Every question this
 * module asks — which repository owns this directory, is this path excluded, what
 * branch is this — is a property of the FILESYSTEM, never of whatever a parent
 * process happened to export. So they are scrubbed here, once, for every caller.
 *
 * Three separate holes came from honouring them, which is why the scrub belongs in
 * the shared helper rather than in each caller:
 *  - `identity/resolve.js`: an ambient `GIT_DIR` resolved a worktree to a namespace
 *    that does not own it, and a poisoned `GIT_CEILING_DIRECTORIES` resolved it to a
 *    neighbouring one — both silently.
 *  - `config/load.js`: `GIT_DIR=/nonexistent/x.git` makes git say "not a git
 *    repository", which `NOT_A_REPO_RE` classifies as "no repo here, nothing to
 *    protect" — so a TRACKED path is declared safe to overwrite without git ever
 *    consulting the real repository. Precisely the inversion the regex exists to stop.
 *  - `gitMetadata`: provenance is written into the durable message marker
 *    (`git-branch`, `git-hash`, `git-user-name`, `git-user-email`), so an ambient
 *    `GIT_DIR` stamped another repository's identity onto every message.
 */
export const GIT_DISCOVERY_OVERRIDES = Object.freeze([
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM'
]);

/** `process.env` with the discovery overrides removed, plus any caller additions. */
function gitEnv(extra) {
  const merged = { ...process.env, ...extra };
  for (const key of GIT_DISCOVERY_OVERRIDES) delete merged[key];
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged;
}

/**
 * Provenance that is not one line is not provenance.
 *
 * `git config` stores whatever bytes it was given, including embedded newlines, and
 * `.trim()` only strips the edges — so `user.email` really can come back as several
 * lines. Every value this module returns is interpolated into a durable message block,
 * so a multi-line value is either an injection attempt or corruption; neither is
 * something to render. The consumer (`format.js`) escapes these values too, and both
 * layers are deliberate: escaping keeps the file parseable, this keeps the file honest.
 */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function tryRun(file, args, cwd) {
  try {
    const out = execFileSync(file, args, {
      cwd,
      env: gitEnv(),
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    return CONTROL_CHAR_RE.test(out) ? null : out;
  } catch {
    return null;
  }
}

/**
 * Best-effort git metadata. Returns null fields when not in a repo or git unavailable.
 * Uses execFileSync (no shell) to avoid command-injection surface.
 * @param {string} cwd
 * @returns {{branch:string|null, hash:string|null, userName:string|null, userEmail:string|null}}
 */
export function gitMetadata(cwd) {
  return {
    branch: tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    hash: tryRun('git', ['rev-parse', '--short', 'HEAD'], cwd),
    userName: tryRun('git', ['config', '--local', 'user.name'], cwd),
    userEmail: tryRun('git', ['config', '--local', 'user.email'], cwd)
  };
}

/**
 * Runs git without throwing. `status` is -1 when git could not be executed at all.
 *
 * Every variable in `GIT_DISCOVERY_OVERRIDES` is removed from the child environment,
 * and no caller can opt back in — see that constant for the three separate holes that
 * honouring them opened. A value of `undefined` in `env` likewise removes a variable
 * rather than merging it as the string "undefined".
 *
 * @param {string[]} args
 * @param {{cwd:string, env?:Record<string,string|undefined>}} opts
 * @returns {{status:number, stdout:string, stderr:string, spawnFailed:boolean}}
 */
export function runGit(args, { cwd, env } = {}) {
  const merged = gitEnv(env);
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: merged,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 0, stdout, stderr: '', spawnFailed: false };
  } catch (err) {
    const spawnFailed = typeof err.status !== 'number';
    return {
      status: spawnFailed ? -1 : err.status,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : '',
      spawnFailed
    };
  }
}

/**
 * The three stderr shapes that genuinely mean "there is no repository here". Anything
 * else non-zero is git REFUSING to answer — a corrupt or unreadable `.git`, an
 * unparseable config file, or `detected dubious ownership` on a different-uid
 * checkout — and must never be read as "no repo, so anything goes". That inversion
 * declared a tracked path safe to overwrite in exactly the situations where the answer
 * matters most, and let a directory resolve to a namespace that does not own it.
 *
 * One rule, one copy: `config/load.js` (is this path git-excluded?) and
 * `identity/resolve.js` (which repository owns this directory?) both classify failure
 * with it, and two hand-maintained copies would drift.
 */
export const NOT_A_REPO_RE = /not a git repository|not a working tree|not under version control/i;
