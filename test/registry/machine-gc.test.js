import { describe, test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjects, registerProject, deregisterProject } from '../../src/daemon/registry-machine.js';

async function withFakeHome(fn) {
  const fakeHome = mkdtempSync(join(tmpdir(), 'walkie-home-'));
  const origWalkieHome = process.env.WALKIE_HOME;
  process.env.WALKIE_HOME = fakeHome;
  try {
    return await fn(fakeHome);
  } finally {
    if (origWalkieHome === undefined) delete process.env.WALKIE_HOME;
    else process.env.WALKIE_HOME = origWalkieHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

describe('machine registry GC', () => {
  test('listProjects prunes entries whose PID is dead', async () => {
    await withFakeHome(async () => {
      await registerProject({ projectPath: '/tmp/p1', port: 1234, pid: process.pid, projectName: 'alive' });
      await registerProject({ projectPath: '/tmp/p2', port: 1235, pid: 999999, projectName: 'dead' });
      const projects = await listProjects();
      const names = projects.map((p) => p.projectName).sort();
      expect(names).toEqual(['alive']);
    });
  });

  test('deregisterProject removes the named project and prunes dead siblings', async () => {
    await withFakeHome(async () => {
      await registerProject({ projectPath: '/tmp/p1', port: 1234, pid: process.pid, projectName: 'alive' });
      await registerProject({ projectPath: '/tmp/p2', port: 1235, pid: 999999, projectName: 'dead' });
      await registerProject({ projectPath: '/tmp/p3', port: 1236, pid: process.pid, projectName: 'also-alive' });
      await deregisterProject('/tmp/p3');
      const projects = await listProjects();
      const names = projects.map((p) => p.projectName).sort();
      expect(names).toEqual(['alive']);
    });
  });
});
