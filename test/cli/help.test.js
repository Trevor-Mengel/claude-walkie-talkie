import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '../../bin/walkie.js');

describe('CLI help', () => {
  test('walkie --help lists core commands', () => {
    const out = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    expect(out).toContain('init');
    expect(out).toContain('start');
    expect(out).toContain('talk');
    expect(out).toContain('read');
    expect(out).toContain('tail');
    expect(out).toContain('sessions');
    expect(out).toContain('permit');
    expect(out).toContain('remove');
  });

  test('walkie --version prints semver', () => {
    const out = execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
