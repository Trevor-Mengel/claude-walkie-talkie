import { describe, test, expect, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import {
  compareSecret,
  ensureSecret,
  generateSecret,
  loadSecret,
  MIN_SECRET_LENGTH,
  SECRET_ENV
} from '../../src/authority/secret.js';
import { hookSecretPath } from '../../src/authority/paths.js';
import { createFixture, modeOf, TEST_SECRET } from './helpers.js';

let fixture;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** An env with no ambient WALKIE_HOOK_SECRET, so file behaviour is what we measure. */
const NO_ENV = Object.freeze({});

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

describe('compareSecret', () => {
  test('accepts an identical secret and rejects a different one', () => {
    expect(compareSecret(TEST_SECRET, TEST_SECRET)).toBe(true);
    expect(compareSecret(TEST_SECRET, `${TEST_SECRET}x`)).toBe(false);
    expect(compareSecret(TEST_SECRET, TEST_SECRET.replace(/.$/, 'X'))).toBe(false);
  });

  test('returns false rather than throwing on a length mismatch', () => {
    // `crypto.timingSafeEqual` throws on unequal-length buffers; a comparison that
    // throws inside an auth check turns a denial into a crash.
    expect(() => compareSecret('short', TEST_SECRET)).not.toThrow();
    expect(compareSecret('short', TEST_SECRET)).toBe(false);
    expect(compareSecret(TEST_SECRET, 'short')).toBe(false);
  });

  test('an absent, empty or non-string secret never authenticates', () => {
    for (const value of ['', undefined, null, 0, false, {}, [], Buffer.from(TEST_SECRET)]) {
      expect(compareSecret(value, TEST_SECRET)).toBe(false);
      expect(compareSecret(TEST_SECRET, value)).toBe(false);
    }
    // Two empty strings must not compare equal: an unconfigured hook would otherwise
    // authenticate against an unconfigured authority.
    expect(compareSecret('', '')).toBe(false);
  });

  test('a unicode secret compares by bytes, not by code points', () => {
    // 'é' as one code point vs as e + combining accent: different secrets.
    expect(compareSecret(`caf\u00e9${'x'.repeat(20)}`, `cafe\u0301${'x'.repeat(20)}`)).toBe(false);
  });
});

describe('generateSecret', () => {
  test('mints 43-character base64url secrets that never repeat', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).not.toBe(a);
  });
});

describe('ensureSecret', () => {
  test('creates the file 0600 inside a 0700 directory', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    const created = ensureSecret({ runtimeRoot, env: NO_ENV });

    expect(created.source).toBe('created');
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.path).toBe(hookSecretPath(runtimeRoot));
    expect(modeOf(created.path)).toBe('600');
    expect(modeOf(runtimeRoot)).toBe('700');
    expect(readFileSync(created.path, 'utf8').trim()).toBe(created.secret);
  });

  test('is idempotent: a second call reuses the persisted secret', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    const first = ensureSecret({ runtimeRoot, env: NO_ENV });
    const second = ensureSecret({ runtimeRoot, env: NO_ENV });
    expect(second.secret).toBe(first.secret);
    expect(second.source).toBe('file');
  });

  test('the env var wins and nothing is written to disk', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    const resolved = ensureSecret({
      runtimeRoot,
      env: { [SECRET_ENV]: TEST_SECRET }
    });
    expect(resolved).toEqual({ secret: TEST_SECRET, source: 'env', path: null });
    expect(() => readFileSync(hookSecretPath(runtimeRoot), 'utf8')).toThrow();
  });

  test('refuses to invent a secret with nowhere to put it', () => {
    expect(codeOf(() => ensureSecret({ env: NO_ENV }))).toBe('config_invalid');
  });
});

// The secret is published atomically and every failure is actionable.
//
// v0.3 wrote the secret with `open(file,'wx')` followed by `write(fd)`. Those are two syscalls,
// so an interruption between them left the final name existing at 0600 and holding nothing — a
// state that never clears itself, because every subsequent boot reads that file, refuses it, and
// dies. And it died behind "the hook secret file is empty", naming neither the file nor what to
// do about it, which is what turned a one-line fix into a wedged install.
describe('ensureSecret publication and failure reporting', () => {
  test('publishes a complete 0600 secret and leaves no staging file behind', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    const { secret, path, source } = ensureSecret({ runtimeRoot, env: NO_ENV });

    expect(source).toBe('created');
    expect(modeOf(path)).toBe('600');
    expect(readFileSync(path, 'utf8')).toBe(`${secret}\n`);
    // The publish links a fully written, fsynced inode into place. Nothing may be left over.
    expect(readdirSync(runtimeRoot).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  test('refuses to publish over a name that already exists rather than clobbering it', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const path = hookSecretPath(runtimeRoot);
    // A dangling symlink: `existsSync` follows it and reports absent, so `ensureSecret` proceeds
    // to mint — and then finds the name taken at publish time. That EEXIST is the same one a
    // racing authority produces, and the answer must be to refuse. This is exactly why the
    // publish is `link` and not `rename`: `rename` would have silently replaced whatever was
    // there, leaving the authority that won the race holding a secret the hook no longer accepts.
    symlinkSync(join(fixture.root, 'nowhere'), path);

    expect(codeOf(() => ensureSecret({ runtimeRoot, env: NO_ENV, onReport: () => {} }))).toBe(
      'config_invalid'
    );
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(runtimeRoot).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  test('an interrupted write is reported with the file and the fix', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const path = hookSecretPath(runtimeRoot);
    // Exactly the state the old two-syscall write left behind.
    writeFileSync(path, '', { mode: 0o600 });

    /** @type {string[]} */
    const reports = [];
    let err;
    try {
      ensureSecret({ runtimeRoot, env: NO_ENV, onReport: (msg) => reports.push(msg) });
    } catch (caught) {
      err = caught;
    }

    expect(err?.code).toBe('config_invalid');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(path);
    expect(reports[0]).toMatch(/interrupted write/);
    expect(reports[0]).toMatch(/delete that file and restart/);
  });

  test('a secret that cannot be written is reported with the file and the fix', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const path = hookSecretPath(runtimeRoot);
    // r-x: the loader can look, the writer cannot land anything. `path` is passed explicitly so
    // `ensureRuntimeDir` does not re-widen the directory we just closed.
    chmodSync(runtimeRoot, 0o500);

    /** @type {string[]} */
    const reports = [];
    let err;
    try {
      ensureSecret({ runtimeRoot, path, env: NO_ENV, onReport: (msg) => reports.push(msg) });
    } catch (caught) {
      err = caught;
    }
    chmodSync(runtimeRoot, 0o700);

    expect(err?.code).toBe('config_invalid');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(path);
    expect(reports[0]).toMatch(/writable/);
    // A failed publish leaves no secret behind, whole or partial.
    expect(existsSync(path)).toBe(false);
  });

  test('the operator sees the path; the error envelope never does', () => {
    // Two channels, one failure. The operator is the only party who can fix a wedged secret
    // file, so their line names it. The envelope travels — into a peer's context, a wire reply,
    // an audit row — so it carries neither the path nor the runtime root. Asserting only one
    // half would let a later change move the path across the boundary unnoticed.
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    const { path, secret } = ensureSecret({ runtimeRoot, env: NO_ENV });
    chmodSync(path, 0o644);

    /** @type {string[]} */
    const reports = [];
    let err;
    try {
      loadSecret({ runtimeRoot, env: NO_ENV, onReport: (msg) => reports.push(msg) });
    } catch (caught) {
      err = caught;
    }

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(path);
    expect(reports[0]).toContain(`chmod 600 ${path}`);
    expect(reports[0]).not.toContain(secret);

    const rendered = JSON.stringify(err.toEnvelope());
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(path);
    expect(rendered).not.toContain(runtimeRoot);
  });
});

describe('loadSecret', () => {
  test('returns null when nothing is configured', () => {
    fixture = createFixture();
    expect(loadSecret({ runtimeRoot: join(fixture.root, 'r'), env: NO_ENV })).toBeNull();
    expect(loadSecret({ env: NO_ENV })).toBeNull();
  });

  test('refuses a secret file readable beyond its owner', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    const { path } = ensureSecret({ runtimeRoot, env: NO_ENV });

    for (const mode of [0o640, 0o604, 0o644, 0o666]) {
      chmodSync(path, mode);
      expect(codeOf(() => loadSecret({ runtimeRoot, env: NO_ENV }))).toBe('config_invalid');
    }
    chmodSync(path, 0o600);
    expect(loadSecret({ runtimeRoot, env: NO_ENV }).source).toBe('file');
  });

  test('refuses an empty or too-short secret from either source', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const path = hookSecretPath(runtimeRoot);

    writeFileSync(path, '   \n', { mode: 0o600 });
    expect(codeOf(() => loadSecret({ runtimeRoot, env: NO_ENV }))).toBe('config_invalid');

    writeFileSync(path, `${'a'.repeat(MIN_SECRET_LENGTH - 1)}\n`, { mode: 0o600 });
    expect(codeOf(() => loadSecret({ runtimeRoot, env: NO_ENV }))).toBe('config_invalid');

    expect(codeOf(() => loadSecret({ runtimeRoot, env: { [SECRET_ENV]: 'tiny' } }))).toBe(
      'config_invalid'
    );
  });

  test('refuses a secret path that is not a regular file', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    mkdirSync(hookSecretPath(runtimeRoot), { recursive: true, mode: 0o700 });
    expect(codeOf(() => loadSecret({ runtimeRoot, env: NO_ENV }))).toBe('config_invalid');
  });

  test('never puts the secret or its path in the failure message', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    const { path, secret } = ensureSecret({ runtimeRoot, env: NO_ENV });
    chmodSync(path, 0o644);
    let err;
    try {
      loadSecret({ runtimeRoot, env: NO_ENV });
    } catch (caught) {
      err = caught;
    }
    const rendered = JSON.stringify(err.toEnvelope());
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(path);
    expect(rendered).not.toContain(runtimeRoot);
  });

  test('follows an explicit path override ahead of the runtime root', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    ensureSecret({ runtimeRoot, env: NO_ENV });

    const elsewhere = join(fixture.root, 'other.secret');
    writeFileSync(elsewhere, `${TEST_SECRET}\n`, { mode: 0o600 });
    expect(loadSecret({ runtimeRoot, path: elsewhere, env: NO_ENV }).secret).toBe(TEST_SECRET);
  });

  test('a symlinked secret is judged by its target permissions', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const target = join(fixture.root, 'target.secret');
    writeFileSync(target, `${TEST_SECRET}\n`, { mode: 0o644 });
    symlinkSync(target, hookSecretPath(runtimeRoot));
    // statSync follows the link, so a world-readable target is still refused.
    expect(codeOf(() => loadSecret({ runtimeRoot, env: NO_ENV }))).toBe('config_invalid');
  });
});
