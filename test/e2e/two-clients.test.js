import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { spawnDaemon, stopDaemon } from '../helpers/spawn-daemon.js';
import { spawnMockClient } from '../helpers/mock-mcp-client.js';
import { clientForProject } from '../../src/cli/client.js';

describe('E2E: two-client conversation', () => {
  let project, daemon, op, code, cowork;
  beforeEach(async () => {
    project = createTmpProject({ operator: 'Trevor', projectName: 'e2e' });
    daemon = await spawnDaemon(project.wtDir);
    op = clientForProject(project.root);
    code = await spawnMockClient({ projectRoot: project.root, tool: 'claude-code' });
    cowork = await spawnMockClient({ projectRoot: project.root, tool: 'claude-cowork' });
  });
  afterEach(async () => {
    await code.close();
    await cowork.close();
    await stopDaemon(daemon);
    cleanup(project);
  });

  test('walks join → talk → mention → reply → edit → archive → invite → fulfill', async () => {
    const sessions = (await op.sessions()).active;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const codeSess = sessions.find((s) => s.tool === 'claude-code');
    const coworkSess = sessions.find((s) => s.tool === 'claude-cowork');
    expect(codeSess).toBeTruthy();
    expect(coworkSess).toBeTruthy();

    await code.rename('demo-builder');
    await cowork.rename('slide-designer');

    await op.grantPermit({ sessionId: codeSess.sessionId, mode: 'always' });
    await op.grantPermit({ sessionId: coworkSess.sessionId, mode: 'always' });

    const q = await code.talk('@slide-designer demo supports refunds — slide?', { type: 'question' });
    expect(q.id).toBeTruthy();
    expect(q.warnings).toEqual([]);

    const inbox = await cowork.inbox();
    expect(inbox.mentionedForMe.length).toBe(1);
    expect(inbox.mentionedForMe[0].id).toBe(q.id);

    const r = await cowork.reply(q.id, 'keep it scoped to happy path');
    expect(r.id).toBeTruthy();

    const edited = await code.edit(q.id, '@slide-designer demo supports refunds — slide? (clarified)');
    expect(edited.revision).toBe(1);

    await op.archive(r.id, { archivedBy: 'operator', reason: 'consolidated' });
    const recent = await op.latest(5, false);
    expect(recent.messages.find((m) => m.id === r.id)).toBeUndefined();

    await op.invite('codex-helper');
    const pending = (await op.sessions()).invitations;
    expect(pending.some((i) => i.alias === 'codex-helper')).toBe(true);

    const codex = await spawnMockClient({ projectRoot: project.root, tool: 'claude-code', alias: 'codex-helper' });
    // Joining with an alias does not fulfill the invitation; only walkie_rename
    // (which routes through /sessions/:id/rename) calls fulfillInvitation. Trigger
    // it explicitly to mirror what an agent would do after seeing the invite.
    await codex.rename('codex-helper');
    const afterFulfill = (await op.sessions()).invitations;
    const stillPending = afterFulfill.find((i) => i.alias === 'codex-helper' && !i.fulfilled);
    expect(stillPending).toBeFalsy();
    await codex.close();
  }, 30000);
});
