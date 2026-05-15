import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { spawnDaemon, stopDaemon } from '../helpers/spawn-daemon.js';
import { clientForProject } from '../../src/cli/client.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_BIN = join(__dirname, '..', '..', 'bin', 'walkie-talkie-mcp.js');

async function startMcp(projectRoot) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    env: { ...process.env, WALKIE_PROJECT_ROOT: projectRoot, WALKIE_TOOL: 'claude-code' }
  });
  const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe('walkie_talk', () => {
  let project, daemon;
  beforeEach(async () => { project = createTmpProject(); daemon = await spawnDaemon(project.wtDir); });
  afterEach(async () => { await stopDaemon(daemon); cleanup(project); });

  test('blocks autonomous talk when no permit; returns permit_required with hint', async () => {
    const { client, close } = await startMcp(project.root);
    const res = await client.callTool({ name: 'walkie_talk', arguments: { body: 'first words' } });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.status).toBe('permit_required');
    expect(parsed.hint).toMatch(/walkie permit/);
    await close();
  });

  test('posts successfully after operator grants a once permit', async () => {
    const http = clientForProject(project.root);
    const { client, close } = await startMcp(project.root);
    const sessions = (await http.sessions()).active;
    const me = sessions[0];
    await http.grantPermit({ sessionId: me.sessionId, mode: 'once' });

    const ok = await client.callTool({ name: 'walkie_talk', arguments: { body: 'permitted talk' } });
    const parsedOk = JSON.parse(ok.content[0].text);
    expect(parsedOk.id).toMatch(/^[0-9A-Z]{26}$/);

    const blocked = await client.callTool({ name: 'walkie_talk', arguments: { body: 'second' } });
    expect(JSON.parse(blocked.content[0].text).status).toBe('permit_required');
    await close();
  });

  test('surfaces unresolved-mention warnings', async () => {
    const http = clientForProject(project.root);
    const { client, close } = await startMcp(project.root);
    const me = (await http.sessions()).active[0];
    await http.grantPermit({ sessionId: me.sessionId, mode: 'always' });

    const res = await client.callTool({ name: 'walkie_talk', arguments: { body: '@unknown please help' } });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.warnings).toEqual([{ type: 'unresolved-mention', token: 'unknown' }]);
    await close();
  });
});
