import { describe, test, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { appendRevision, readHistory } from '../../src/core/history.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('history', () => {
  test('appendRevision creates per-message history file with revision metadata', async () => {
    project = createTmpProject();
    const sessionsDir = join(project.wtDir, '.sessions');
    await appendRevision(sessionsDir, '01ABC', {
      revision: 1,
      editedAt: '2026-05-14T15:32:00Z',
      editedBy: 'cs_xyz',
      priorBody: 'first version body'
    });
    const filePath = join(sessionsDir, '01ABC.history.md');
    expect(existsSync(filePath)).toBe(true);
    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('## Revision 1');
    expect(text).toContain('Edited at: 2026-05-14T15:32:00Z');
    expect(text).toContain('Edited by: cs_xyz');
    expect(text).toContain('first version body');
  });

  test('appendRevision appends to an existing history file', async () => {
    project = createTmpProject();
    const sessionsDir = join(project.wtDir, '.sessions');
    await appendRevision(sessionsDir, '01ABC', {
      revision: 1,
      editedAt: 't1',
      editedBy: 'a',
      priorBody: 'one'
    });
    await appendRevision(sessionsDir, '01ABC', {
      revision: 2,
      editedAt: 't2',
      editedBy: 'a',
      priorBody: 'two'
    });
    const history = await readHistory(sessionsDir, '01ABC');
    expect(history.length).toBe(2);
    expect(history[0].body).toBe('one');
    expect(history[1].body).toBe('two');
  });

  test('readHistory returns empty array when no history file exists', async () => {
    project = createTmpProject();
    const history = await readHistory(join(project.wtDir, '.sessions'), 'nope');
    expect(history).toEqual([]);
  });
});
