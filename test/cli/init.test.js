import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../../bin/walkie.js');

describe('walkie init', () => {
  test('creates .walkie-talkie/ with channel.md and config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walkie-init-'));
    try {
      execFileSync(process.execPath, [BIN, 'init', '--operator', 'Trevor', '--name', 'demo'], { cwd: dir });
      expect(existsSync(join(dir, '.walkie-talkie/channel.md'))).toBe(true);
      const cfg = JSON.parse(readFileSync(join(dir, '.walkie-talkie/config.json'), 'utf8'));
      expect(cfg.operator).toBe('Trevor');
      expect(cfg.projectName).toBe('demo');
      const channel = readFileSync(join(dir, '.walkie-talkie/channel.md'), 'utf8');
      expect(channel).toContain('Walkie-Talkie Channel: demo');
      expect(channel).toContain('Operator:** Trevor');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite existing channel without --force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walkie-init-'));
    try {
      execFileSync(process.execPath, [BIN, 'init', '--operator', 'A'], { cwd: dir });
      expect(() =>
        execFileSync(process.execPath, [BIN, 'init', '--operator', 'B'], { cwd: dir, stdio: 'pipe' })
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('infers operator from git config user.name when --operator omitted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walkie-init-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Inferred From Git'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      const out = execFileSync(process.execPath, [BIN, 'init'], { cwd: dir, encoding: 'utf8' });
      const cfg = JSON.parse(readFileSync(join(dir, '.walkie-talkie/config.json'), 'utf8'));
      expect(cfg.operator).toBe('Inferred From Git');
      expect(out).toMatch(/inferred from git config user\.name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to OS username when not in a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walkie-init-'));
    try {
      // Run with HOME pointed elsewhere so any global git config user.name is hidden;
      // this leaves git config user.name unset for the lookup, forcing the OS-username fallback.
      const isolatedHome = mkdtempSync(join(tmpdir(), 'walkie-no-git-'));
      const out = execFileSync(process.execPath, [BIN, 'init'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, HOME: isolatedHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
      });
      const cfg = JSON.parse(readFileSync(join(dir, '.walkie-talkie/config.json'), 'utf8'));
      expect(cfg.operator).toBe(userInfo().username);
      expect(out).toMatch(/inferred from OS username/);
      rmSync(isolatedHome, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
