import { describe, test, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertBindablePath,
  authorityRuntimeDir,
  authoritySocketPath,
  ensureRuntimeDir,
  hookSecretPath,
  MAX_SOCKET_PATH_BYTES,
  RUNTIME_ROOT_ENV
} from '../../src/authority/paths.js';
import { createFixture, modeOf } from './helpers.js';

let fixture;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

describe('authorityRuntimeDir', () => {
  test('defaults to the in-tree run directory', () => {
    expect(authorityRuntimeDir('/projects/app', undefined, {})).toBe(
      '/projects/app/.walkie-talkie/run'
    );
  });

  test('the env var overrides the in-tree default', () => {
    expect(authorityRuntimeDir('/projects/app', undefined, { [RUNTIME_ROOT_ENV]: '/run/walkie' })).toBe(
      '/run/walkie'
    );
  });

  test('an explicit override outranks the env var', () => {
    expect(
      authorityRuntimeDir('/projects/app', '/explicit', { [RUNTIME_ROOT_ENV]: '/run/walkie' })
    ).toBe('/explicit');
  });

  test('an empty env value falls through to the default', () => {
    expect(authorityRuntimeDir('/projects/app', undefined, { [RUNTIME_ROOT_ENV]: '' })).toBe(
      '/projects/app/.walkie-talkie/run'
    );
  });

  test('a relative or empty path is a configuration error, never a silent resolve', () => {
    expect(codeOf(() => authorityRuntimeDir('relative/root', undefined, {}))).toBe('config_invalid');
    expect(codeOf(() => authorityRuntimeDir('', undefined, {}))).toBe('config_invalid');
    expect(codeOf(() => authorityRuntimeDir(undefined, undefined, {}))).toBe('config_invalid');
    expect(codeOf(() => authorityRuntimeDir('/projects/app', 'rel', {}))).toBe('config_invalid');
    expect(
      codeOf(() => authorityRuntimeDir('/projects/app', undefined, { [RUNTIME_ROOT_ENV]: 'rel' }))
    ).toBe('config_invalid');
  });
});

describe('socket and secret addresses', () => {
  test('both live in the runtime directory under their canonical names', () => {
    expect(authoritySocketPath('/run/walkie')).toBe('/run/walkie/authority.sock');
    expect(hookSecretPath('/run/walkie')).toBe('/run/walkie/hook.secret');
  });

  test('an explicit override is returned verbatim', () => {
    expect(authoritySocketPath('/run/walkie', '/tmp/a.sock')).toBe('/tmp/a.sock');
    expect(hookSecretPath('/run/walkie', '/tmp/s')).toBe('/tmp/s');
  });

  test('a missing runtime root is refused rather than resolved against cwd', () => {
    expect(codeOf(() => authoritySocketPath(undefined))).toBe('config_invalid');
    expect(codeOf(() => hookSecretPath(undefined))).toBe('config_invalid');
  });
});

describe('assertBindablePath', () => {
  test('accepts a path within the AF_UNIX budget', () => {
    const path = `/tmp/${'a'.repeat(MAX_SOCKET_PATH_BYTES - '/tmp/'.length)}`;
    expect(Buffer.byteLength(path)).toBe(MAX_SOCKET_PATH_BYTES);
    expect(assertBindablePath(path)).toBe(path);
  });

  test('rejects a path the kernel would refuse with ENAMETOOLONG', () => {
    const path = `/tmp/${'a'.repeat(MAX_SOCKET_PATH_BYTES)}`;
    expect(codeOf(() => assertBindablePath(path))).toBe('config_invalid');
  });

  test('counts bytes, not characters, so multi-byte names cannot overflow the field', () => {
    // Each 'é' is two bytes: 60 characters, 120 bytes.
    const path = `/tmp/${'é'.repeat(60)}`;
    expect(path.length).toBeLessThan(MAX_SOCKET_PATH_BYTES);
    expect(codeOf(() => assertBindablePath(path))).toBe('config_invalid');
  });
});

describe('ensureRuntimeDir', () => {
  test('creates the directory 0700, parents included', () => {
    fixture = createFixture();
    const dir = ensureRuntimeDir(join(fixture.root, 'a', 'b', 'run'));
    expect(modeOf(dir)).toBe('700');
  });

  test('re-tightens a directory that was loosened out of band', () => {
    fixture = createFixture();
    const dir = join(fixture.root, 'run');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    expect(modeOf(dir)).toBe('755');

    ensureRuntimeDir(dir);
    // The directory is the access gate for a socket whose own mode lands after bind,
    // so a loose directory must not survive a restart.
    expect(modeOf(dir)).toBe('700');
  });
});
