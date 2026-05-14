import { describe, test, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  loadSessions,
  joinSession,
  renameSession,
  markSeen,
  rolloverStale
} from '../../src/registry/sessions.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('session registry', () => {
  test('loadSessions returns empty active and recent for fresh project', async () => {
    project = createTmpProject();
    const s = await loadSessions(project.wtDir);
    expect(s.active).toEqual([]);
    expect(s.recent).toEqual([]);
  });

  test('joinSession assigns a generated alias when none provided', async () => {
    project = createTmpProject();
    const a = await joinSession(project.wtDir, { tool: 'claude-code' });
    const b = await joinSession(project.wtDir, { tool: 'claude-code' });
    expect(a.alias).toBe('claude-code-1');
    expect(b.alias).toBe('claude-code-2');
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test('joinSession respects a provided sessionId and alias', async () => {
    project = createTmpProject();
    const s = await joinSession(project.wtDir, {
      tool: 'claude-code',
      sessionId: 'cs_abc',
      alias: 'demo-builder'
    });
    expect(s.sessionId).toBe('cs_abc');
    expect(s.alias).toBe('demo-builder');
  });

  test('renameSession updates the active entry', async () => {
    project = createTmpProject();
    const s = await joinSession(project.wtDir, { tool: 'claude-code' });
    await renameSession(project.wtDir, s.sessionId, 'demo-builder');
    const all = await loadSessions(project.wtDir);
    expect(all.active[0].alias).toBe('demo-builder');
  });

  test('renameSession with colliding alias suffixes the older holder', async () => {
    project = createTmpProject();
    const a = await joinSession(project.wtDir, { tool: 'claude-code', alias: 'demo-builder' });
    const b = await joinSession(project.wtDir, { tool: 'claude-code' });
    await renameSession(project.wtDir, b.sessionId, 'demo-builder');
    const all = await loadSessions(project.wtDir);
    const aliases = all.active.map((s) => s.alias).sort();
    expect(aliases).toContain('demo-builder');
    expect(aliases.some((x) => x.startsWith('demo-builder-v'))).toBe(true);
  });

  test('markSeen bumps lastSeen', async () => {
    project = createTmpProject();
    const s = await joinSession(project.wtDir, { tool: 'claude-code' });
    const before = s.lastSeen;
    await new Promise((r) => setTimeout(r, 10));
    await markSeen(project.wtDir, s.sessionId);
    const all = await loadSessions(project.wtDir);
    expect(new Date(all.active[0].lastSeen).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  test('rolloverStale moves stale sessions to recent', async () => {
    project = createTmpProject();
    const s = await joinSession(project.wtDir, { tool: 'claude-code' });
    const path = join(project.wtDir, '.sessions', 'active.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.active[0].lastSeen = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    (await import('node:fs')).writeFileSync(path, JSON.stringify(data));
    await rolloverStale(project.wtDir, 6 * 3600 * 1000);
    const all = await loadSessions(project.wtDir);
    expect(all.active).toEqual([]);
    expect(all.recent.length).toBe(1);
    expect(all.recent[0].sessionId).toBe(s.sessionId);
  });
});
