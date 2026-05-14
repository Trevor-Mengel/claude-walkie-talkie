import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
});
