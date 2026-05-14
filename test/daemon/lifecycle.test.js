import { describe, test, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, stopDaemon, statusDaemon } from '../../src/daemon/lifecycle.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(async () => {
  if (project) {
    try { await stopDaemon(project.root); } catch (_e) {}
    cleanup(project);
    project = null;
  }
});

describe('daemon lifecycle', () => {
  test('startDaemon writes server.pid + server.port, status reports running', async () => {
    project = createTmpProject();
    await startDaemon(project.root);
    const status = await statusDaemon(project.root);
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);
    expect(existsSync(join(project.wtDir, 'server.pid'))).toBe(true);
    expect(existsSync(join(project.wtDir, 'server.port'))).toBe(true);
  });

  test('stopDaemon kills process and removes pid/port', async () => {
    project = createTmpProject();
    await startDaemon(project.root);
    await stopDaemon(project.root);
    await new Promise((r) => setTimeout(r, 100));
    const status = await statusDaemon(project.root);
    expect(status.running).toBe(false);
  });

  test('startDaemon is idempotent when already running', async () => {
    project = createTmpProject();
    await startDaemon(project.root);
    const first = await statusDaemon(project.root);
    await startDaemon(project.root);
    const second = await statusDaemon(project.root);
    expect(second.pid).toBe(first.pid);
  });
});
