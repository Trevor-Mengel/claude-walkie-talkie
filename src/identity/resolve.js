import { sep } from 'node:path';
import { NOT_A_REPO_RE, runGit } from '../core/git.js';
import { CollabcastError } from './errors.js';
import { isNamespace } from './namespace.js';
import { canonicalizePath, isInside } from './paths.js';
import { loadIdentities } from './identities.js';

const GIT_DIR_SUFFIX = `${sep}.git`;

/**
 * Finds the root of the repository that owns `cwd`.
 *
 * `--git-common-dir` is the load-bearing choice: inside a linked worktree it points at the MAIN
 * repository's `.git` directory, so a worktree resolves to the same identity as its main
 * checkout. `--show-toplevel` would return the worktree instead.
 *
 * Fails CLOSED. There are exactly two answers: this directory is in a repository (and here is
 * its root), or there is demonstrably no repository here (and `cwd` is the root). Anything else
 * — git missing, a corrupt `.git`, an unparseable config, dubious ownership, or a success with
 * no path in it — throws. Substituting `cwd` on any failure was a fabrication: it silently
 * turned "git could not tell me" into "there is no repository", which inside a linked worktree
 * matched the WORKTREE path against the registration map instead of the main checkout's, and so
 * could resolve a directory to a namespace that does not own it. Guarantee 5 says resolution
 * fails closed with no fallback, and a fabricated root is a fallback.
 *
 * @param {{cwd:string, env?:Record<string,string|undefined>}} opts
 * @returns {{root:string, inRepo:boolean, gitCommonDir:string|null}}
 * @throws {CollabcastError} `namespace_unresolved` when git cannot answer
 */
export function repositoryRoot({ cwd, env = process.env }) {
  // `runGit` removes every variable in GIT_DISCOVERY_OVERRIDES from the child
  // environment, so an ambient GIT_DIR cannot steer this answer at another repository.
  const res = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    env
  });
  if (res.spawnFailed) {
    throw new CollabcastError(
      'namespace_unresolved',
      'git could not be executed, so the repository that owns this directory is unknown',
      { reason: 'git_unavailable' }
    );
  }
  if (res.status !== 0) {
    if (!NOT_A_REPO_RE.test(res.stderr)) {
      throw new CollabcastError(
        'namespace_unresolved',
        'git refused to report the repository that owns this directory',
        { reason: 'git_indeterminate', status: res.status }
      );
    }
    // The only benign failure: git looked and there is genuinely no repository.
    return { root: canonicalizePath(cwd), inRepo: false, gitCommonDir: null };
  }
  const out = res.stdout.trim();
  if (out.length === 0) {
    throw new CollabcastError(
      'namespace_unresolved',
      'git reported no path for the repository that owns this directory',
      { reason: 'git_indeterminate', status: 0 }
    );
  }
  const gitCommonDir = canonicalizePath(out);
  const root = gitCommonDir.endsWith(GIT_DIR_SUFFIX)
    ? gitCommonDir.slice(0, -GIT_DIR_SUFFIX.length)
    : gitCommonDir;
  return { root: canonicalizePath(root), inRepo: true, gitCommonDir };
}

/**
 * Resolves the namespace that owns `cwd`.
 *
 * `COLLABCAST_NAMESPACE` is a hint only: it must name a namespace in the map AND that namespace must
 * own `cwd`, otherwise the call is rejected. There is no generic default namespace — an
 * unregistered directory fails with `namespace_unresolved`.
 *
 * @param {{cwd?:string, env?:Record<string,string|undefined>, identities?:object}} [opts]
 * @returns {{namespace:string, canonicalRoot:string, registrationRoot:string,
 *   paseoProjectKey:string|null}}
 */
export function resolveNamespace({ cwd = process.cwd(), env = process.env, identities } = {}) {
  const map = identities ?? loadIdentities({ env });
  const hint = env.COLLABCAST_NAMESPACE;

  if (hint !== undefined && hint !== '') {
    if (!isNamespace(hint)) {
      throw new CollabcastError('namespace_unresolved', 'COLLABCAST_NAMESPACE is not a valid namespace', {
        reason: 'hint_invalid'
      });
    }
    if (!Object.prototype.hasOwnProperty.call(map.identities, hint)) {
      throw new CollabcastError(
        'namespace_unresolved',
        `COLLABCAST_NAMESPACE=${hint} is not present in the identity map`,
        { reason: 'hint_unknown_namespace', hint }
      );
    }
  }

  const { root, inRepo } = repositoryRoot({ cwd, env });

  const matches = [];
  for (const entry of Object.values(map.identities)) {
    for (const registrationRoot of entry.registrations) {
      if (root === registrationRoot || isInside(root, registrationRoot)) {
        matches.push({ entry, registrationRoot, length: registrationRoot.length });
      }
    }
  }

  if (matches.length === 0) {
    throw new CollabcastError(
      'namespace_unresolved',
      `no collabcast identity registers ${root}${inRepo ? '' : ' (not inside a git repository)'}`,
      { searchRoot: root, inRepo }
    );
  }

  const longest = matches.reduce((a, b) => (b.length > a.length ? b : a));
  const tiedNamespaces = [
    ...new Set(matches.filter((m) => m.length === longest.length).map((m) => m.entry.namespace))
  ];
  if (tiedNamespaces.length > 1) {
    throw new CollabcastError(
      'config_invalid',
      `${root} is claimed by more than one namespace: ${tiedNamespaces.join(', ')}`,
      { path: root, namespaces: tiedNamespaces }
    );
  }

  const { entry, registrationRoot } = longest;

  if (hint !== undefined && hint !== '' && hint !== entry.namespace) {
    throw new CollabcastError(
      'namespace_unresolved',
      `COLLABCAST_NAMESPACE=${hint} does not own ${root} (owned by ${entry.namespace})`,
      { reason: 'hint_does_not_own_cwd', hint, owner: entry.namespace, searchRoot: root }
    );
  }

  return Object.freeze({
    namespace: entry.namespace,
    canonicalRoot: entry.canonicalRoot,
    registrationRoot,
    paseoProjectKey: entry.paseoProjectKey
  });
}
