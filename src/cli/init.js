// src/cli/init.js
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { isValidOperatorName } from '../core/validate.js';
import { walkieError } from '../identity/errors.js';
import { canonicalizePath } from '../identity/paths.js';
import { assertNamespace, isNamespace } from '../identity/namespace.js';
import {
  IDENTITIES_SCHEMA_VERSION,
  identitiesPath,
  parseIdentities
} from '../identity/identities.js';
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG, MODES, configPath, walkieDir } from '../config/schema.js';
import { verifyPathExcluded } from '../config/load.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../templates/channel.md');

/** The host identity map names signal targets and project paths: owner-only, always. */
const IDENTITIES_MODE = 0o600;

/**
 * `.walkie-talkie/` is local state, and `channel.md` is an input the daemon's watcher
 * honours — a committed channel ships whatever it contains to every clone, including a
 * forged message block. So `init` makes the directory git-ignored, idempotently and
 * without ever rewriting a line the operator put there.
 */
const GITIGNORE_RULE = '.walkie-talkie/';
const GITIGNORE_COMMENT = '# walkie-talkie: local channel state and session history';

/** Every spelling of a rule that already ignores the directory. */
function ignoresWalkieDir(line) {
  const bare = line.trim().replace(/\/+$/, '');
  return bare === '.walkie-talkie' || bare === '/.walkie-talkie' || bare === '**/.walkie-talkie';
}

/**
 * Ensures `<projectRoot>/.gitignore` ignores `.walkie-talkie/`. Appends only, so existing
 * content survives byte-for-byte, and re-running `init` never duplicates the rule.
 * @param {string} projectRoot
 * @returns {Promise<{path:string, added:boolean}>}
 */
async function ensureGitignored(projectRoot) {
  const path = join(projectRoot, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing.split('\n').some(ignoresWalkieDir)) return { path, added: false };
  // Supply only the newlines the file is actually missing; a file that does not end in
  // one would otherwise get our comment glued onto its last rule.
  const terminator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const spacer = existing.length === 0 ? '' : '\n';
  await appendFile(path, `${terminator}${spacer}${GITIGNORE_COMMENT}\n${GITIGNORE_RULE}\n`, 'utf8');
  return { path, added: true };
}

/**
 * Serialises read-modify-write on the host identity map.
 *
 * The map is the root of ALL namespace resolution, and `init` runs concurrently in
 * different projects on one host. Unlocked read -> parse -> mutate -> write silently
 * dropped one registration (that project then failed every command with
 * `namespace_unresolved` and no clue why), and a crash mid-write left JSON that
 * `parseIdentities` rejects for EVERY project. Same lock + temp + rename discipline as
 * `withChannelLock` / `writeAtomic` in core/channel.js.
 */
async function withIdentitiesLock(path, fn) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(path, {
    retries: { retries: 40, minTimeout: 25, maxTimeout: 200, factor: 1.5 },
    stale: 5000,
    realpath: false
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function writeIdentitiesAtomic(path, map) {
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`);
  // chmod, never `writeFile({ mode })`: that mode applies at CREATE time only and is masked
  // by the umask, so it silently left an existing map at whatever mode it already had and
  // could land a mode we never asked for on a new one. Tighten BEFORE the rename, so the map
  // is never visible at a looser mode than we promise.
  await chmod(tmp, IDENTITIES_MODE);
  await rename(tmp, path);
}

function gitUserName(cwd) {
  try {
    const out = execFileSync('git', ['config', 'user.name'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const trimmed = out.trim();
    if (!trimmed) return null;
    if (!isValidOperatorName(trimmed)) {
      process.stderr.write('(git config user.name is invalid; falling back)\n');
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function osUsername() {
  try {
    const name = userInfo().username;
    if (!name) return null;
    if (!isValidOperatorName(name)) {
      process.stderr.write('(OS username is invalid; falling back)\n');
      return null;
    }
    return name;
  } catch {
    return null;
  }
}

function inferOperator(cwd) {
  const fromGit = gitUserName(cwd);
  if (fromGit) return { value: fromGit, source: 'git config user.name' };
  const fromOs = osUsername();
  if (fromOs) return { value: fromOs, source: 'OS username' };
  return null;
}

/**
 * Turn a directory name into a namespace. A namespace is host configuration and must match
 * `^[a-z][a-z0-9-]{0,63}$`, so anything else is folded rather than rejected — but the result is
 * asserted, so a name that cannot be folded fails loudly instead of producing a broken config.
 *
 * @param {string} raw
 * @returns {string}
 */
export function deriveNamespace(raw) {
  const folded = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const candidate = folded === '' ? '' : /^[a-z]/.test(folded) ? folded : `ns-${folded}`.slice(0, 64);
  if (!isNamespace(candidate)) {
    throw walkieError(
      'config_invalid',
      `cannot derive a namespace from "${raw}"; pass --namespace <name> matching ` +
        'a lowercase letter followed by lowercase letters, digits or hyphens'
    );
  }
  return candidate;
}

/**
 * Add this project to the host identity map, which is what makes the namespace resolvable at
 * all: a client resolves its namespace from the map, and an unregistered directory has no
 * channel. Refuses to move an existing namespace or to claim a root another namespace owns.
 *
 * @param {{namespace:string, canonicalRoot:string, env?:Record<string,string|undefined>}} opts
 * @returns {Promise<{path:string, created:boolean}>}
 */
async function registerNamespace({ namespace, canonicalRoot, env = process.env }) {
  const { path } = identitiesPath({ env });
  return withIdentitiesLock(path, async () => {
    let map = { schemaVersion: IDENTITIES_SCHEMA_VERSION, identities: {} };
    let created = true;
    if (existsSync(path)) {
      created = false;
      const parsed = parseIdentities(JSON.parse(await readFile(path, 'utf8')), { source: path });
      map = {
        schemaVersion: IDENTITIES_SCHEMA_VERSION,
        identities: Object.fromEntries(
          Object.entries(parsed.identities).map(([name, entry]) => [
            name,
            {
              canonicalRoot: entry.canonicalRoot,
              registrations: [...entry.registrations],
              ...(entry.paseoProjectKey === null ? {} : { paseoProjectKey: entry.paseoProjectKey })
            }
          ])
        )
      };
    }

    for (const [name, entry] of Object.entries(map.identities)) {
      if (name === namespace) continue;
      if (entry.registrations.includes(canonicalRoot)) {
        throw walkieError(
          'conflict',
          `this directory is already registered to the namespace "${name}"; a path may only ` +
            'belong to one namespace'
        );
      }
    }

    const existing = map.identities[namespace];
    if (existing && existing.canonicalRoot !== canonicalRoot) {
      throw walkieError(
        'conflict',
        `the namespace "${namespace}" is already registered to a different directory; pick ` +
          'another name with --namespace'
      );
    }

    const registrations = existing
      ? [...new Set([...existing.registrations, canonicalRoot])]
      : [canonicalRoot];
    map.identities[namespace] = { canonicalRoot, registrations };

    await writeIdentitiesAtomic(path, map);
    return { path, created };
  });
}

/**
 * Scaffold a channel.
 *
 * Two things changed with v0.3. The config is schema-validated now, so `operator` and
 * `projectName` no longer live in it — the operator's name belongs to the channel document, and
 * the config carries only `schemaVersion`, `namespace` and `mode`. And the namespace is
 * registered in the host identity map, without which no client can resolve this directory.
 */
export async function initCommand({ operator, name, namespace, mode, force } = {}) {
  const projectRoot = canonicalizePath(process.cwd());
  const wt = walkieDir(projectRoot);
  if (existsSync(wt) && !force) {
    throw walkieError(
      'conflict',
      '.walkie-talkie/ already exists here. Use --force to reinitialize.'
    );
  }

  let operatorName = operator;
  let operatorSource = 'flag';
  if (operatorName) {
    if (!isValidOperatorName(operatorName)) {
      throw walkieError(
        'invalid_request',
        "invalid --operator value: contains forbidden characters or exceeds 80 chars; pass a " +
          "name matching letters/numbers/spaces/._'-"
      );
    }
  } else {
    const inferred = inferOperator(projectRoot);
    if (!inferred) {
      throw walkieError(
        'invalid_request',
        'could not infer an operator name (no valid git config user.name and no valid OS ' +
          'username). Pass --operator <name>.'
      );
    }
    operatorName = inferred.value;
    operatorSource = inferred.source;
  }

  const projectName = name || basename(projectRoot);
  const effectiveNamespace = namespace
    ? assertNamespace(namespace, { label: '--namespace' })
    : deriveNamespace(projectName);
  const effectiveMode = mode ?? DEFAULT_CONFIG.mode;
  if (!MODES.includes(effectiveMode)) {
    throw walkieError('invalid_request', `--mode must be one of ${MODES.join(', ')}`);
  }

  // Claim the namespace FIRST. Registration is the only step here that can be
  // legitimately refused (the namespace belongs to another directory, or this
  // directory belongs to another namespace), so it must gate the writes rather
  // than follow them. Writing config.json before claiming meant a refused
  // `init --namespace other --force` had already overwritten the namespace of a
  // working project, bricking it for `loadConfig({ expectNamespace })` until
  // someone hand-edited it back. The remaining failure direction — registered
  // but not yet scaffolded — is benign and self-heals on a re-run.
  const registration = await registerNamespace({
    namespace: effectiveNamespace,
    canonicalRoot: projectRoot
  });

  await mkdir(wt, { recursive: true });
  await mkdir(join(wt, '.sessions'), { recursive: true });
  await mkdir(join(wt, 'logs'), { recursive: true });

  const template = (await readFile(TEMPLATE_PATH, 'utf8'))
    .replace('PROJECT_NAME', projectName)
    .replace('OPERATOR_NAME', operatorName)
    .replace('CREATED_AT', new Date().toISOString());
  await writeFile(join(wt, 'channel.md'), template);
  await writeFile(
    configPath(projectRoot),
    `${JSON.stringify(
      { schemaVersion: CONFIG_SCHEMA_VERSION, namespace: effectiveNamespace, mode: effectiveMode },
      null,
      2
    )}\n`
  );

  // Ignore the directory BEFORE telling the operator the channel exists: a committed
  // channel.md is a supply-chain vector, not a tidiness problem.
  const ignoreRule = await ensureGitignored(projectRoot);
  const exclusion = verifyPathExcluded(join(wt, 'channel.md'), { repoRoot: projectRoot });

  const sourceNote = operatorSource === 'flag' ? '' : ` (inferred from ${operatorSource})`;
  const lines = [
    `Initialized the "${effectiveNamespace}" channel for "${projectName}" with operator ` +
      `"${operatorName}"${sourceNote}.`,
    `Registered the namespace in the host identity map${registration.created ? ' (created)' : ''}.`
  ];
  lines.push(
    ignoreRule.added
      ? `Added \`${GITIGNORE_RULE}\` to .gitignore so local channel state is never committed.`
      : `.gitignore already ignores \`${GITIGNORE_RULE}\`.`
  );
  if (exclusion.reason === 'tracked') {
    lines.push(
      'WARNING: .walkie-talkie/channel.md is TRACKED in git. The service refuses to start ' +
        'while it is, because a committed channel is shipped to every clone. Run ' +
        '`git rm -r --cached .walkie-talkie` and commit that removal.'
    );
  }
  lines.push(
    effectiveMode === 'managed'
      ? 'Mode is managed: Paseo supervises this namespace\'s walkie-svc. Re-run with ' +
          '`--mode standalone --force` if you want to run it yourself.'
      : 'Mode is standalone. Next: walkie start'
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}
