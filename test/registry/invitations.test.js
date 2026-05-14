import { describe, test, expect, afterEach } from 'vitest';
import {
  loadInvitations,
  addInvitation,
  findInvitation,
  fulfillInvitation,
  expireOlderThan
} from '../../src/registry/invitations.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('invitations', () => {
  test('loadInvitations returns empty for fresh project', async () => {
    project = createTmpProject();
    expect(await loadInvitations(project.wtDir)).toEqual([]);
  });

  test('addInvitation stores alias + invitedBy + fromMessage', async () => {
    project = createTmpProject();
    await addInvitation(project.wtDir, {
      alias: 'codex-helper',
      invitedBy: 'operator',
      fromMessage: '01XYZ'
    });
    const all = await loadInvitations(project.wtDir);
    expect(all.length).toBe(1);
    expect(all[0].alias).toBe('codex-helper');
  });

  test('findInvitation returns matching entry or null', async () => {
    project = createTmpProject();
    await addInvitation(project.wtDir, {
      alias: 'codex-helper',
      invitedBy: 'operator',
      fromMessage: '01XYZ'
    });
    expect((await findInvitation(project.wtDir, 'codex-helper'))?.alias).toBe('codex-helper');
    expect(await findInvitation(project.wtDir, 'nope')).toBeNull();
  });

  test('fulfillInvitation removes the invitation and returns it', async () => {
    project = createTmpProject();
    await addInvitation(project.wtDir, {
      alias: 'codex-helper',
      invitedBy: 'operator',
      fromMessage: '01XYZ'
    });
    const fulfilled = await fulfillInvitation(project.wtDir, 'codex-helper', 'cs_new');
    expect(fulfilled.alias).toBe('codex-helper');
    expect(await loadInvitations(project.wtDir)).toEqual([]);
  });

  test('expireOlderThan removes invitations older than threshold', async () => {
    project = createTmpProject();
    await addInvitation(project.wtDir, {
      alias: 'codex-helper',
      invitedBy: 'operator',
      fromMessage: '01XYZ'
    });
    const path = (await import('node:path')).join(project.wtDir, '.sessions', 'invitations.json');
    const data = JSON.parse((await import('node:fs')).readFileSync(path, 'utf8'));
    data[0].invitedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    (await import('node:fs')).writeFileSync(path, JSON.stringify(data));
    await expireOlderThan(project.wtDir, 24 * 3600 * 1000);
    expect(await loadInvitations(project.wtDir)).toEqual([]);
  });
});
