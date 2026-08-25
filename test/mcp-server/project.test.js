import { describe, test, expect } from 'vitest';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findProjectRoot } from '../../src/mcp-server/project.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

describe('mcp project discovery', () => {
  test('uses COLLABCAST_PROJECT_ROOT when set', () => {
    const project = createTmpProject();
    const root = findProjectRoot({ env: { COLLABCAST_PROJECT_ROOT: project.root }, cwd: '/' });
    expect(root).toBe(project.root);
    cleanup(project);
  });

  test('walks up from cwd looking for .collabcast/', () => {
    const project = createTmpProject();
    const nested = join(project.root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    const root = findProjectRoot({ env: {}, cwd: nested });
    expect(root).toBe(project.root);
    cleanup(project);
  });

  test('throws if no .collabcast/ found anywhere up the tree', () => {
    // Leaked its directory on every run until the leak detector stopped being
    // gated on a two-entry prefix list and started seeing every fixture.
    const orphan = createFixtureDir('collabcast-orphan-');
    try {
      expect(() => findProjectRoot({ env: {}, cwd: orphan })).toThrow(/no \.collabcast/i);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
  // `ensureDaemon` used to live here and was covered by a test that started a real daemon.
  // Both are gone: a client never spawns a service. See test/mcp-server/managed-mode.test.js.
});
