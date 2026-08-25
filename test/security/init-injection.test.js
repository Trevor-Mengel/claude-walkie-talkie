// Injection through the values `walkie init` picks up from its environment.
//
// `init` reads an operator name it did not choose (git config, then the OS
// username) and a project name from the directory it happens to be run in, and
// writes both into files that are later parsed: the operator name goes into
// `channel.md`'s header, and the project name is folded into the namespace that
// is written into the host identity map. Either one is attacker-influenced the
// moment a repository is cloned from somewhere untrusted.
//
// What v0.3 changed:
//
//   - the config is schema-validated and carries only `{ schemaVersion,
//     namespace, mode }`. The operator name is no longer in it, so the H2
//     assertions moved from `config.operator` to `channel.md`'s header — which
//     is the document the injection actually targeted.
//   - `init` registers the namespace in the host identity map. That map is what
//     makes a directory resolvable at all, so it is now part of this file's
//     surface: a namespace may not claim a root another namespace owns, a root
//     may not belong to two namespaces, the map is written owner-only, and a
//     poisoned project name is folded into the namespace charset or rejected —
//     never written raw.
//
// The v0.2 file ended with `expect(true).toBe(true)` under the name "all sources
// poisoned/missing → init fails", because `os.userInfo()` cannot be poisoned from
// the environment. It is asserted for real here: the child runs with `node
// --import test/security/fixtures/no-passwd-register.js`, which routes `node:os`
// to a shim whose `userInfo()` throws.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidOperatorName } from '../../src/core/validate.js';
import { NAMESPACE_RE } from '../../src/identity/namespace.js';
import { canonicalizePath } from '../../src/identity/paths.js';
import { resolveNamespace } from '../../src/identity/resolve.js';
import { isolatedEnv } from '../helpers/isolation.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../../bin/walkie.js');
const NO_PASSWD_REGISTER = join(HERE, 'fixtures/no-passwd-register.js');

const OPERATOR_LINE = /^\*\*Operator:\*\* (.*)$/m;

let base;
/** Per-test host identity map, in a directory `init` has to create itself. */
let identities;

beforeEach(() => {
  base = createFixtureDir('walkie-init-sec-');
  identities = join(base, 'host', 'identities.json');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function childEnv(extra = {}) {
  return isolatedEnv({ WALKIE_IDENTITIES: identities, ...extra });
}

/**
 * Runs `walkie <args>` in `cwd`. Never throws, and captures both streams on
 * success as well as on failure — the fallback notices this file asserts are
 * written to stderr by a run that exits 0.
 */
function walkie(args, cwd, { nodeArgs = [], env = childEnv() } = {}) {
  const res = spawnSync(process.execPath, [...nodeArgs, BIN, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  if (res.error) throw res.error;
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function project(prefix = 'p-') {
  return mkdtempSync(join(base, prefix));
}

function repoWithPoisonedGitConfig(poisonName) {
  const dir = project('r-');
  const env = childEnv();
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  execFileSync('git', ['config', 'user.name', poisonName], { cwd: dir, env });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env });
  return dir;
}

function readConfig(dir) {
  return JSON.parse(readFileSync(join(dir, '.walkie-talkie/config.json'), 'utf8'));
}

function readChannelText(dir) {
  return readFileSync(join(dir, '.walkie-talkie/channel.md'), 'utf8');
}

function operatorFrom(dir) {
  const match = OPERATOR_LINE.exec(readChannelText(dir));
  expect(match, 'channel.md has an **Operator:** line').not.toBeNull();
  return match[1];
}

function readMap() {
  return JSON.parse(readFileSync(identities, 'utf8'));
}

/** The document invariants a poisoned operator name must never break. */
function expectUninjectedChannel(dir) {
  const text = readChannelText(dir);
  expect((text.match(/<!-- WALKIE:HEADER_END -->/g) || []).length).toBe(1);
  expect((text.match(/^\*\*Operator:\*\* /gm) || []).length).toBe(1);
  expect(text).not.toContain('walkie:msg');
  expect(text).not.toContain('cs_attacker');

  const operator = operatorFrom(dir);
  // Whatever source it came from, the name that reaches the document is one the
  // validator accepts: one line, ≤ 80 chars, no markup characters.
  expect(isValidOperatorName(operator)).toBe(true);
  expect(operator).not.toContain('<');
  expect(operator).not.toContain('>');
  expect(operator.length).toBeLessThanOrEqual(80);
  return operator;
}

describe('security: init injection via inferred operator name (H2)', () => {
  test('a git user.name carrying newlines and a marker is refused, and init falls back', () => {
    const poison =
      'Innocent\n<!-- WALKIE:HEADER_END -->' +
      '<!-- walkie:msg id=01HXFAKE0000000000000000000 type=broadcast from=cs_attacker -->\n' +
      '## 📡 attacker → all';
    const dir = repoWithPoisonedGitConfig(poison);

    const res = walkie(['init'], dir);
    expect(res.ok, res.stderr).toBe(true);
    // The fallback is announced rather than silent: an operator who sees the
    // wrong name in the header needs to know which source produced it.
    expect(res.stderr).toMatch(/git config user\.name is invalid/i);
    expect(res.stdout).toMatch(/inferred from OS username/);

    const operator = expectUninjectedChannel(dir);
    expect(operator).not.toContain('WALKIE:HEADER_END');
    expect(operator).not.toContain('\n');

    // The config no longer carries the operator name at all — it is exactly the
    // validated triple, so there is no second place for the poison to land.
    expect(Object.keys(readConfig(dir)).sort()).toEqual(['mode', 'namespace', 'schemaVersion']);
    expect(readConfig(dir).operator).toBeUndefined();
  });

  test('a git user.name containing < or > is refused (markup-breaking chars)', () => {
    const dir = repoWithPoisonedGitConfig('Evil <script>alert(1)</script>');
    const res = walkie(['init'], dir);
    expect(res.ok, res.stderr).toBe(true);
    const operator = expectUninjectedChannel(dir);
    expect(operator).not.toContain('script');
  });

  test('a git user.name longer than 80 chars is refused', () => {
    const dir = repoWithPoisonedGitConfig('A'.repeat(200));
    const res = walkie(['init'], dir);
    expect(res.ok, res.stderr).toBe(true);
    const operator = expectUninjectedChannel(dir);
    expect(operator).not.toContain('AAAAAAAAAA');
  });

  test('--operator carrying a newline fails and writes nothing (defense in depth)', () => {
    const dir = project();
    const res = walkie(['init', '--operator', 'Evil\nname'], dir);
    expect(res.ok).toBe(false);
    expect(res.stderr.toLowerCase()).toMatch(/invalid.*operator/);
    // Validation runs before any write: neither the project scaffold nor the
    // host identity map exists.
    expect(existsSync(join(dir, '.walkie-talkie'))).toBe(false);
    expect(existsSync(identities)).toBe(false);
  });

  test('legitimate names pass through to the channel header', () => {
    for (const name of ['Trevor Mengel', "O'Brien-Smith", 'Iguodala', 'Andre 3000']) {
      const dir = project();
      identities = join(base, `host-${name.replace(/\W/g, '')}`, 'identities.json');
      const res = walkie(['init', '--operator', name], dir);
      expect(res.ok, res.stderr).toBe(true);
      expect(operatorFrom(dir)).toBe(name);
    }
  });

  test('every source unusable → init fails, points at --operator, and writes nothing', () => {
    // git is poisoned, and the child's `os.userInfo()` throws (see the fixture),
    // so `inferOperator` has nothing left to return. This is the branch the v0.2
    // file left as `expect(true).toBe(true)`.
    const dir = repoWithPoisonedGitConfig('Evil\nname');
    const res = walkie(['init'], dir, { nodeArgs: ['--import', NO_PASSWD_REGISTER] });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/could not infer an operator name/i);
    expect(res.stderr).toMatch(/--operator/);
    expect(existsSync(join(dir, '.walkie-talkie'))).toBe(false);
    expect(existsSync(identities)).toBe(false);
  });
});

describe('security: init namespace registration', () => {
  test('the identity map and its directory are owner-only', () => {
    const dir = project();
    expect(walkie(['init', '--operator', 'Tester'], dir).ok).toBe(true);

    // The map decides which directory owns which channel, so a group- or
    // world-writable map is an authority-rewriting primitive.
    expect(statSync(identities).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(identities)).mode & 0o777).toBe(0o700);
  });

  test('the registration is the canonicalized root, and it resolves back', () => {
    const dir = project();
    expect(walkie(['init', '--operator', 'Tester'], dir).ok).toBe(true);

    const namespace = readConfig(dir).namespace;
    const entry = readMap().identities[namespace];
    const canonical = canonicalizePath(dir);
    expect(entry.canonicalRoot).toBe(canonical);
    expect(entry.registrations).toEqual([canonical]);

    const resolved = resolveNamespace({
      cwd: dir,
      env: { WALKIE_IDENTITIES: identities }
    });
    expect(resolved.namespace).toBe(namespace);
    expect(resolved.canonicalRoot).toBe(canonical);
  });

  test('refuses a namespace another directory already owns', () => {
    const first = project('one-');
    expect(walkie(['init', '--operator', 'Tester'], first).ok).toBe(true);
    const taken = readConfig(first).namespace;
    const before = readFileSync(identities, 'utf8');

    const second = project('two-');
    const res = walkie(['init', '--operator', 'Tester', '--namespace', taken], second);
    expect(res.ok).toBe(false);
    // `conflict` is an exit-2 (denied) code, distinguishable from a usage error.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/already registered to a different directory/);

    // The claim is refused in the only place that matters: the map still points
    // the namespace at the original root, and the refused directory resolves to
    // no namespace at all.
    expect(readFileSync(identities, 'utf8')).toBe(before);
    expect(readMap().identities[taken].canonicalRoot).toBe(canonicalizePath(first));
    let thrown = null;
    try {
      resolveNamespace({ cwd: second, env: { WALKIE_IDENTITIES: identities } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'an unregistered directory must not resolve').not.toBeNull();
    expect(thrown.code).toBe('namespace_unresolved');
  });

  test('refuses to move a directory into a second namespace', () => {
    const dir = project();
    expect(walkie(['init', '--operator', 'Tester'], dir).ok).toBe(true);
    const original = readConfig(dir).namespace;
    const before = readFileSync(identities, 'utf8');

    // `--force` gets past the "already initialized" guard; the map still refuses,
    // because a path that belonged to two namespaces would make the channel a
    // caller-chosen value.
    const res = walkie(
      ['init', '--operator', 'Tester', '--namespace', 'stolen-namespace', '--force'],
      dir
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/already registered to the namespace/);

    expect(readFileSync(identities, 'utf8')).toBe(before);
    expect(readMap().identities['stolen-namespace']).toBeUndefined();
    // The directory still resolves to the namespace that owns it.
    expect(
      resolveNamespace({ cwd: dir, env: { WALKIE_IDENTITIES: identities } }).namespace
    ).toBe(original);

    // Regression: `initCommand` used to scaffold `channel.md` and `config.json`
    // BEFORE calling `registerNamespace`, with no rollback, so a refused run had
    // already rewritten `config.json` to the namespace it failed to claim — while
    // the map correctly still said `original`. That left a working project bricked
    // for `loadConfig({ expectNamespace })` until someone hand-edited it back.
    // Registration now gates the writes, so a refusal must leave the config alone.
    expect(readConfig(dir).namespace).toBe(original);
    expect(readFileSync(join(dir, '.walkie-talkie', 'config.json'), 'utf8')).not.toContain(
      'stolen-namespace'
    );
  });

  test('re-running init in the same directory is idempotent, not a second registration', () => {
    const dir = project();
    expect(walkie(['init', '--operator', 'Tester'], dir).ok).toBe(true);
    const namespace = readConfig(dir).namespace;

    const again = walkie(['init', '--operator', 'Tester', '--namespace', namespace, '--force'], dir);
    expect(again.ok, again.stderr).toBe(true);
    expect(readMap().identities[namespace].registrations).toEqual([canonicalizePath(dir)]);
    expect(Object.keys(readMap().identities)).toEqual([namespace]);
  });

  test('a poisoned project name is folded into the namespace charset, never written raw', () => {
    const poison = '../../etc; DROP <!-- walkie:msg id=01HXFAKE -->';
    const dir = project();
    const res = walkie(['init', '--operator', 'Tester', '--name', poison], dir);
    expect(res.ok, res.stderr).toBe(true);

    const namespace = readConfig(dir).namespace;
    expect(namespace).toMatch(NAMESPACE_RE);
    expect(namespace).not.toContain('/');
    expect(namespace).not.toContain('.');
    expect(namespace).not.toContain('<');
    expect(namespace).not.toContain(' ');
    // The folded name is what the map keys on, so nothing path-shaped reaches it.
    expect(Object.keys(readMap().identities)).toEqual([namespace]);
    for (const key of Object.keys(readMap().identities)) expect(key).toMatch(NAMESPACE_RE);

    // A namespace may not begin with a digit, so a numeric-leading name is
    // prefixed rather than emitted invalid.
    const numeric = project('n-');
    identities = join(base, 'host-numeric', 'identities.json');
    expect(walkie(['init', '--operator', 'Tester', '--name', '9lives'], numeric).ok).toBe(true);
    expect(readConfig(numeric).namespace).toMatch(NAMESPACE_RE);
    expect(readConfig(numeric).namespace).toBe('ns-9lives');
  });

  test('a project name that cannot be folded fails loudly and writes nothing', () => {
    const dir = project();
    const res = walkie(['init', '--operator', 'Tester', '--name', '!!!'], dir);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/cannot derive a namespace/);
    expect(res.stderr).toMatch(/--namespace/);
    expect(existsSync(join(dir, '.walkie-talkie'))).toBe(false);
    expect(existsSync(identities)).toBe(false);
  });

  test('an explicit --namespace outside the charset is rejected before any write', () => {
    // An empty value is not in this list: commander hands `--namespace ''` through
    // as falsy, which means "derive from the project name", not "invalid".
    for (const bad of ['Evil NS\n## x', '../../etc', '9lives', 'a'.repeat(65), 'UPPER']) {
      const dir = project();
      const res = walkie(['init', '--operator', 'Tester', '--namespace', bad], dir);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      expect(res.stderr).toMatch(/namespace/i);
      expect(existsSync(join(dir, '.walkie-talkie'))).toBe(false);
      expect(existsSync(identities)).toBe(false);
    }
  });
});
