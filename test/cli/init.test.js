import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SCHEMA_VERSION } from '../../src/config/schema.js';
import { deriveNamespace } from '../../src/cli/init.js';
import { assertDisposable } from '../helpers/isolation.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../../bin/collabcast.js');

/**
 * A throw-away checkout with its own identity map. `collabcast init` now writes to the host identity
 * map, so every test must point `COLLABCAST_IDENTITIES` at a private file: the harness's map is
 * shared by every worker in the run.
 */
function scratch(prefix = 'collabcast-init-') {
  const base = realpathSync(createFixtureDir(prefix));
  assertDisposable(base, 'init scratch dir');
  const dir = join(base, 'demo');
  execFileSync('mkdir', ['-p', dir]);
  const identities = join(base, 'identities.json');
  return {
    base,
    dir,
    identities,
    env: { ...process.env, COLLABCAST_IDENTITIES: identities },
    config: () => JSON.parse(readFileSync(join(dir, '.collabcast/config.json'), 'utf8')),
    map: () => JSON.parse(readFileSync(identities, 'utf8')),
    cleanup: () => rmSync(base, { recursive: true, force: true })
  };
}

function run(args, s, opts = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd: s.dir,
    encoding: 'utf8',
    env: s.env,
    ...opts
  });
}

describe('deriveNamespace', () => {
  test('folds a project name into a legal namespace', () => {
    expect(deriveNamespace('collabcast')).toBe('collabcast');
    expect(deriveNamespace('My Project!')).toBe('my-project');
    expect(deriveNamespace('__weird__')).toBe('weird');
    expect(deriveNamespace('2024-rewrite')).toBe('ns-2024-rewrite');
  });

  test('a name with nothing to fold is an error, not a broken config', () => {
    expect(() => deriveNamespace('!!!')).toThrow(/cannot derive a namespace/);
  });
});

describe('collabcast init', () => {
  test('writes a schema-valid config and registers the namespace', () => {
    const s = scratch();
    try {
      const out = run(['init', '--operator', 'Trevor', '--name', 'demo'], s);

      expect(existsSync(join(s.dir, '.collabcast/channel.md'))).toBe(true);
      // The config carries only what the schema allows: no operator, no projectName, no permits.
      expect(s.config()).toEqual({
        schemaVersion: CONFIG_SCHEMA_VERSION,
        namespace: 'demo',
        mode: 'managed'
      });

      const channel = readFileSync(join(s.dir, '.collabcast/channel.md'), 'utf8');
      expect(channel).toContain('Collabcast Channel: demo');
      expect(channel).toContain('Operator:** Trevor');

      // Without a registration the directory resolves to no namespace at all.
      expect(s.map()).toEqual({
        schemaVersion: 1,
        identities: { demo: { canonicalRoot: s.dir, registrations: [s.dir] } }
      });
      expect(statSync(s.identities).mode & 0o777).toBe(0o600);
      expect(out).toMatch(/Registered the namespace/);
      expect(out).toMatch(/managed/);
    } finally {
      s.cleanup();
    }
  });

  test('--namespace and --mode are honoured', () => {
    const s = scratch();
    try {
      const out = run(['init', '--operator', 'T', '--namespace', 'my-chan', '--mode', 'standalone'], s);
      expect(s.config()).toMatchObject({ namespace: 'my-chan', mode: 'standalone' });
      expect(Object.keys(s.map().identities)).toEqual(['my-chan']);
      expect(out).toMatch(/collabcast start/);
    } finally {
      s.cleanup();
    }
  });

  test('an illegal namespace is refused with the rule', () => {
    const s = scratch();
    try {
      expect(() =>
        run(['init', '--operator', 'T', '--namespace', 'Not Legal'], s, { stdio: 'pipe' })
      ).toThrow(/config_invalid/);
    } finally {
      s.cleanup();
    }
  });

  test('a directory already claimed by another namespace is refused, and nothing is rewritten', () => {
    const s = scratch();
    try {
      run(['init', '--operator', 'First', '--namespace', 'first'], s);
      const before = s.config();
      let stderr = '';
      try {
        run(['init', '--operator', 'Second', '--namespace', 'second', '--force'], s, {
          stdio: 'pipe'
        });
      } catch (err) {
        stderr = String(err.stderr);
      }
      expect(stderr).toMatch(/already registered to the namespace "first"/);
      // The original registration is untouched.
      expect(Object.keys(s.map().identities)).toEqual(['first']);

      // And so is everything the refused run would have written. Registration is
      // the only step here that can be legitimately refused, so it has to GATE
      // the writes: while config.json was written first, a refused
      // `init --namespace second --force` had already replaced the namespace of
      // a working project, so `loadConfig({ expectNamespace })` refused to start
      // until someone hand-edited it back. The stderr and identity-map
      // assertions above hold either way — these two are the ones that fail when
      // the ordering regresses.
      expect(s.config()).toEqual(before);
      expect(s.config().namespace).toBe('first');
      expect(readFileSync(join(s.dir, '.collabcast/channel.md'), 'utf8')).toContain(
        'Operator:** First'
      );
    } finally {
      s.cleanup();
    }
  });

  test('refuses to overwrite an existing channel without --force', () => {
    const s = scratch();
    try {
      run(['init', '--operator', 'A'], s);
      let stderr = '';
      try {
        run(['init', '--operator', 'B'], s, { stdio: 'pipe' });
      } catch (err) {
        stderr = String(err.stderr);
      }
      expect(stderr).toMatch(/^collabcast \[conflict]: /);
      expect(stderr).not.toMatch(/^\s+at /m);
    } finally {
      s.cleanup();
    }
  });

  test('infers the operator from git config user.name', () => {
    const s = scratch();
    try {
      execFileSync('git', ['init', '-q'], { cwd: s.dir, env: s.env });
      execFileSync('git', ['config', 'user.name', 'Inferred From Git'], { cwd: s.dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: s.dir });
      const out = run(['init'], s);
      expect(readFileSync(join(s.dir, '.collabcast/channel.md'), 'utf8')).toContain(
        'Operator:** Inferred From Git'
      );
      expect(out).toMatch(/inferred from git config user\.name/);
    } finally {
      s.cleanup();
    }
  });

  test('falls back to the OS username when git offers no user.name', () => {
    // Two ways for git to have nothing to say: no repository at all, and a
    // repository whose user.name is unset (git exits cleanly with empty output,
    // which the subject must treat as "no answer" rather than as an answer).
    for (const initGitRepo of [false, true]) {
      const s = scratch();
      try {
        if (initGitRepo) execFileSync('git', ['init', '-q'], { cwd: s.dir, env: s.env });
        const out = run(['init'], s);
        const channel = readFileSync(join(s.dir, '.collabcast/channel.md'), 'utf8');

        // The expectation comes from `id -un`, NOT from the `os.userInfo()` call
        // the subject itself makes: comparing the subject's source against
        // itself passes for any implementation that returns
        // `os.userInfo().username`, whatever the precedence or validation does.
        // `id -un` is an independent read of the same passwd entry, so a subject
        // that returned a uid, a home-directory basename or a hardcoded
        // placeholder fails here. Poisoning `node:os` for real — and proving the
        // OS-username source is validated and can fail closed — is
        // test/security/init-injection.test.js's "every source unusable" case.
        const osUser = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
        expect(osUser).not.toBe('');
        expect(channel).toContain(`Operator:** ${osUser}`);

        // The source is reported honestly, and git is not credited for it.
        expect(out).toMatch(/inferred from OS username/);
        expect(out).not.toMatch(/git config user\.name/);
      } finally {
        s.cleanup();
      }
    }
  });

  test('an existing identity map is merged, not replaced', () => {
    const s = scratch();
    try {
      const other = join(s.base, 'other');
      execFileSync('mkdir', ['-p', other]);
      const existing = {
        schemaVersion: 1,
        identities: { other: { canonicalRoot: other, registrations: [other] } }
      };
      execFileSync('sh', ['-c', `printf '%s' '${JSON.stringify(existing)}' > ${s.identities}`]);
      chmodSync(s.identities, 0o600);

      run(['init', '--operator', 'T', '--namespace', 'demo'], s);

      expect(Object.keys(s.map().identities).sort()).toEqual(['demo', 'other']);
      expect(s.map().identities.other).toEqual({ canonicalRoot: other, registrations: [other] });
    } finally {
      s.cleanup();
    }
  });
});
