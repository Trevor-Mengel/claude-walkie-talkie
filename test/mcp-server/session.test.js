import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { spawnDaemon, stopDaemon } from '../helpers/spawn-daemon.js';
import { resolveSession, resetSessionCache } from '../../src/mcp-server/session.js';
import { clientForRoot } from '../../src/mcp-server/http-client.js';

describe('mcp session resolution', () => {
  let project;
  let daemon;
  beforeEach(async () => {
    project = createTmpProject();
    daemon = await spawnDaemon(project.wtDir);
    resetSessionCache();
  });
  afterEach(async () => {
    await stopDaemon(daemon);
    cleanup(project);
  });

  test('joins on first call and caches sessionId for the process', async () => {
    const client = clientForRoot(project.root);
    const a = await resolveSession({ client, tool: 'claude-code' });
    const b = await resolveSession({ client, tool: 'claude-code' });
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.tool).toBe('claude-code');
    expect(a.alias).toMatch(/^claude-code-\d+$/);
  });

  test('honours alias parameter on first join', async () => {
    const client = clientForRoot(project.root);
    const session = await resolveSession({ client, tool: 'claude-code', alias: 'demo-builder' });
    expect(session.alias).toBe('demo-builder');
  });
});
