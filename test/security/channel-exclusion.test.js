// `.collabcast/` must never be under version control.
//
// `channel.md` is the document every agent reads into its context, and the daemon's watcher
// treats an external edit to it as a supported input. So a project that COMMITS the directory
// ships whatever the file contains — including a forged message block — to every clone, and
// `.sessions/` (where `appendRevision` writes on every message edit) means collabcast mutates
// version-controlled files during normal use.
//
// Three defences, tested here end to end:
//
//   1. `collabcast init` writes a `.gitignore` rule, idempotently and without clobbering.
//   2. `verifyPathExcluded` refuses to guess when git cannot answer. It used to read ANY
//      non-zero `rev-parse` exit as "not a repository", so a corrupt `.git`, a poisoned
//      `GIT_DIR` or a dubious-ownership checkout declared a TRACKED path safe.
//   3. The service checks both paths once at start and fails closed on `tracked`, so a
//      misconfigured repo is loud at boot rather than silent on the first edit.
//
// The `verifyPathExcluded` unit matrix lives in test/config/load.test.js; what is here is the
// indeterminate-git case and the two callers.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChannelStateExcluded, verifyPathExcluded } from '../../src/config/load.js';
import { paths as channelPaths } from '../../src/core/channel.js';
import { startService } from '../../src/daemon/daemon-entry.js';
import { createRegisteredNamespace } from '../helpers/registered-namespace.js';
import { assertDisposable } from '../helpers/isolation.js';
import { GIT_ENV, git } from '../identity/tmp-git.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../../bin/collabcast.js');

let base;

beforeEach(() => {
  base = realpathSync(createFixtureDir('collabcast-excl-'));
  assertDisposable(base, 'exclusion scratch dir');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A project directory plus a private identity map, so `collabcast init` can run for real. */
function project(name) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    gitignorePath: join(dir, '.gitignore'),
    gitignore: () => readFileSync(join(dir, '.gitignore'), 'utf8'),
    run: (args = []) =>
      execFileSync(process.execPath, [BIN, 'init', '--operator', 'Excl Op', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, COLLABCAST_IDENTITIES: join(base, `${name}-ids.json`) }
      })
  };
}

/** Count of lines that ignore `.collabcast`, however spelled. */
function ignoreRuleCount(text) {
  return text.split('\n').filter((line) => line.trim().replace(/\/+$/, '') === '.collabcast')
    .length;
}

describe('collabcast init makes .collabcast/ git-ignored', () => {
  test('creates a .gitignore with the rule when none exists', () => {
    const p = project('fresh');
    expect(existsSync(p.gitignorePath)).toBe(false);
    const out = p.run();

    expect(ignoreRuleCount(p.gitignore())).toBe(1);
    expect(out).toMatch(/\.gitignore/);
  });

  test('running twice does not duplicate the rule', () => {
    const p = project('twice');
    p.run();
    const afterFirst = p.gitignore();
    const out = p.run(['--force']);

    expect(p.gitignore()).toBe(afterFirst);
    expect(ignoreRuleCount(p.gitignore())).toBe(1);
    expect(out).toMatch(/already ignores/);
  });

  test('an existing .gitignore keeps every byte it had', () => {
    const p = project('existing');
    const existing = '# my rules\nnode_modules/\ndist\n';
    writeFileSync(p.gitignorePath, existing, 'utf8');
    p.run();

    const after = p.gitignore();
    expect(after.startsWith(existing)).toBe(true);
    expect(ignoreRuleCount(after)).toBe(1);
    expect(after).toContain('node_modules/');
  });

  test('a .gitignore with no trailing newline is appended to, not glued onto', () => {
    const p = project('no-newline');
    writeFileSync(p.gitignorePath, 'dist', 'utf8');
    p.run();

    const lines = p.gitignore().split('\n');
    expect(lines).toContain('dist');
    expect(lines).toContain('.collabcast/');
    expect(ignoreRuleCount(p.gitignore())).toBe(1);
  });

  test('an equivalent rule the operator already wrote is left alone', () => {
    const p = project('equivalent');
    writeFileSync(p.gitignorePath, '/.collabcast\n', 'utf8');
    p.run();
    expect(p.gitignore()).toBe('/.collabcast\n');
  });
});

describe('verifyPathExcluded refuses to guess when git cannot answer', () => {
  /** A repo whose only tracked file is README.md. */
  function repo(name) {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# r\n');
    git(['init', '-q', '-b', 'main', '.'], dir);
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'init'], dir);
    return dir;
  }

  test('a tracked path is NOT reported safe when rev-parse fails for a non-repo reason', () => {
    const dir = repo('indeterminate');
    const tracked = join(dir, 'README.md');
    // An unparseable global config makes every git invocation exit 128 with a message that
    // is not "not a git repository" — the same shape as dubious ownership, a corrupt .git
    // or a poisoned GIT_DIR. Reading that as "no repo" declared a TRACKED path excluded.
    const badConfig = join(base, 'bad.gitconfig');
    writeFileSync(badConfig, '[core\n', 'utf8');
    const env = { ...GIT_ENV, GIT_CONFIG_GLOBAL: badConfig };

    expect(verifyPathExcluded(tracked, { repoRoot: dir, env })).toEqual({
      ok: false,
      reason: 'git-indeterminate',
      path: tracked
    });
  });

  test('a directory outside any repository is still reported as not-a-repo', () => {
    const plain = join(base, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(verifyPathExcluded(join(plain, 'channel.md'), { repoRoot: plain, env: GIT_ENV })).toEqual(
      { ok: true, reason: 'not-a-repo', path: join(plain, 'channel.md') }
    );
  });
});

describe('assertChannelStateExcluded', () => {
  /**
   * A project with a real `.collabcast/` inside a real repo.
   * @param {{gitignore?:string, track?:string[]}} opts
   */
  function scaffold(name, { gitignore, track = [] } = {}) {
    const root = join(base, name);
    const wt = join(root, '.collabcast');
    mkdirSync(join(wt, '.sessions'), { recursive: true });
    writeFileSync(join(wt, 'channel.md'), '# channel\n');
    writeFileSync(join(wt, '.sessions', '01ARZ3.jsonl'), '{}\n');
    writeFileSync(join(root, 'README.md'), '# r\n');
    if (gitignore !== undefined) writeFileSync(join(root, '.gitignore'), gitignore);
    git(['init', '-q', '-b', 'main', '.'], root);
    git(['add', '-A'], root);
    for (const rel of track) git(['add', '-f', rel], root);
    git(['commit', '-qm', 'init'], root);
    const p = channelPaths(root);
    return { root, args: { channelPath: p.channel, sessionsDir: p.sessionsDir, repoRoot: root } };
  }

  function expectThrow(fn) {
    let thrown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'expected a throw').toBeDefined();
    return thrown;
  }

  test('passes when both paths are ignored and untracked', () => {
    const s = scaffold('clean', { gitignore: '.collabcast/\n' });
    const checked = assertChannelStateExcluded({ ...s.args, env: GIT_ENV });
    expect(checked.map((c) => c.result.reason)).toEqual([
      'ignored-and-untracked',
      'ignored-and-untracked'
    ]);
  });

  test('refuses to start when channel.md is tracked', () => {
    const s = scaffold('tracked-channel');
    const err = expectThrow(() => assertChannelStateExcluded({ ...s.args, env: GIT_ENV }));
    expect(err.code).toBe('config_invalid');
    expect(err.detail.label).toBe('channel.md');
    expect(err.detail.reason).toBe('tracked');
    // Actionable: names the remedy, not just the problem.
    expect(err.message).toMatch(/tracked in git/);
    expect(err.message).toMatch(/git rm -r --cached/);
    expect(err.message).toMatch(/\.gitignore/);
  });

  test('refuses to start when only .sessions is tracked, and says which', () => {
    const s = scaffold('tracked-sessions', {
      gitignore: '.collabcast/\n',
      track: ['.collabcast/.sessions/01ARZ3.jsonl']
    });
    const err = expectThrow(() => assertChannelStateExcluded({ ...s.args, env: GIT_ENV }));
    expect(err.code).toBe('config_invalid');
    expect(err.detail.label).toBe('.collabcast/.sessions');
    expect(err.detail.reason).toBe('tracked');
    expect(err.message).toMatch(/\.sessions is tracked in git/);
  });

  test('an untracked but unignored path warns instead of blocking the boot', () => {
    const s = scaffold('not-ignored');
    // Untrack everything so the paths exist but are neither ignored nor tracked.
    git(['rm', '-r', '-q', '--cached', '.collabcast'], s.root);
    const warnings = [];
    const checked = assertChannelStateExcluded({
      ...s.args,
      env: GIT_ENV,
      warn: (m) => warnings.push(m)
    });
    expect(checked.map((c) => c.result.reason)).toEqual(['not-ignored', 'not-ignored']);
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toMatch(/not git-excluded \(not-ignored\)/);
    expect(warnings.join('\n')).not.toMatch(/tracked/);
  });

  test('outside a repository there is nothing to check', () => {
    const root = join(base, 'no-repo');
    mkdirSync(join(root, '.collabcast', '.sessions'), { recursive: true });
    const p = channelPaths(root);
    const warnings = [];
    const checked = assertChannelStateExcluded({
      channelPath: p.channel,
      sessionsDir: p.sessionsDir,
      repoRoot: root,
      env: GIT_ENV,
      warn: (m) => warnings.push(m)
    });
    expect(checked.map((c) => c.result.reason)).toEqual(['not-a-repo', 'not-a-repo']);
    expect(warnings).toEqual([]);
  });
});

describe('the service refuses to start on tracked channel state', () => {
  /** Turns a registered namespace's project root into a git repo. */
  function repoize(ns, { gitignore, track = [] } = {}) {
    const root = ns.canonicalRoot;
    writeFileSync(join(root, 'README.md'), '# r\n');
    if (gitignore !== undefined) writeFileSync(join(root, '.gitignore'), gitignore);
    git(['init', '-q', '-b', 'main', '.'], root);
    git(['add', '-A'], root);
    for (const rel of track) git(['add', '-f', rel], root);
    git(['commit', '-qm', 'init'], root);
    return root;
  }

  function boot(ns) {
    return startService({ cwd: ns.canonicalRoot, env: ns.env, writePidFile: false });
  }

  test('a tracked channel.md is a config_invalid refusal, and no socket is opened', async () => {
    const ns = createRegisteredNamespace({ namespace: 'excl-tracked', mode: 'standalone' });
    repoize(ns);

    let thrown;
    try {
      await boot(ns);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'expected the boot to fail').toBeDefined();
    expect(thrown.code).toBe('config_invalid');
    expect(thrown.message).toMatch(/git rm -r --cached/);
    expect(existsSync(ns.socketPath)).toBe(false);
  });

  test('a tracked .sessions directory is refused too', async () => {
    const ns = createRegisteredNamespace({ namespace: 'excl-sessions', mode: 'standalone' });
    mkdirSync(join(ns.collabcastDir, '.sessions'), { recursive: true });
    writeFileSync(join(ns.collabcastDir, '.sessions', '01ARZ3.jsonl'), '{}\n');
    repoize(ns, {
      gitignore: '.collabcast/\n',
      track: ['.collabcast/.sessions/01ARZ3.jsonl']
    });

    let thrown;
    try {
      await boot(ns);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'expected the boot to fail').toBeDefined();
    expect(thrown.code).toBe('config_invalid');
    expect(thrown.message).toMatch(/\.sessions is tracked in git/);
  });

  test('an ignored-and-untracked channel starts normally', async () => {
    const ns = createRegisteredNamespace({ namespace: 'excl-ignored', mode: 'standalone' });
    repoize(ns, { gitignore: '.collabcast/\n' });

    const service = await boot(ns);
    try {
      expect(service.namespace).toBe('excl-ignored');
      expect(existsSync(ns.socketPath)).toBe(true);
    } finally {
      await service.stop();
    }
  });

  test('outside a repository it starts normally', async () => {
    const ns = createRegisteredNamespace({ namespace: 'excl-plain', mode: 'standalone' });

    const service = await boot(ns);
    try {
      expect(service.namespace).toBe('excl-plain');
      expect(existsSync(ns.socketPath)).toBe(true);
    } finally {
      await service.stop();
    }
  });
});
