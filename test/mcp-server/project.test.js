import { describe, test, expect } from 'vitest';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot, ensureDaemon } from '../../src/mcp-server/project.js';
import { stopDaemon as stopLifecycle } from '../../src/daemon/lifecycle.js';

describe('mcp project discovery', () => {
  test('uses WALKIE_PROJECT_ROOT when set', () => {
    const project = createTmpProject();
    const root = findProjectRoot({ env: { WALKIE_PROJECT_ROOT: project.root }, cwd: '/' });
    expect(root).toBe(project.root);
    cleanup(project);
  });

  test('walks up from cwd looking for .walkie-talkie/', () => {
    const project = createTmpProject();
    const nested = join(project.root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    const root = findProjectRoot({ env: {}, cwd: nested });
    expect(root).toBe(project.root);
    cleanup(project);
  });

  test('throws if no .walkie-talkie/ found anywhere up the tree', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'orphan-'));
    expect(() => findProjectRoot({ env: {}, cwd: orphan })).toThrow(/no \.walkie-talkie/i);
  });

  test('ensureDaemon starts daemon when none is running', async () => {
    const project = createTmpProject();
    const status = await ensureDaemon(project.root, { projectName: 'test-proj' });
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);
    await stopLifecycle(project.root);
    cleanup(project);
  });
});
