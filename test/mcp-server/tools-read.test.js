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

describe('walkie_read', () => {
  let project, daemon;
  beforeEach(async () => { project = createTmpProject(); daemon = await spawnDaemon(project.wtDir); });
  afterEach(async () => { await stopDaemon(daemon); cleanup(project); });

  test('returns the latest N messages newest-first', async () => {
    const http = clientForProject(project.root);
    for (const body of ['m1', 'm2', 'm3']) {
      await http.post({ body, fromSessionId: 'operator', fromAlias: 'operator', fromTool: 'operator' });
    }
    const { client, close } = await startMcp(project.root);
    const res = await client.callTool({ name: 'walkie_read', arguments: { limit: 2 } });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[0].body.trim()).toBe('m3');
    expect(parsed.messages[1].body.trim()).toBe('m2');
    await close();
  });

  test('include_archived=true returns archived messages too', async () => {
    const http = clientForProject(project.root);
    const post = await http.post({ body: 'gone', fromSessionId: 'operator', fromAlias: 'operator', fromTool: 'operator' });
    await http.archive(post.id, { archivedBy: 'operator', reason: 'cleanup' });

    const { client, close } = await startMcp(project.root);
    const without = JSON.parse((await client.callTool({ name: 'walkie_read', arguments: {} })).content[0].text);
    expect(without.messages.length).toBe(0);
    const withArchived = JSON.parse((await client.callTool({ name: 'walkie_read', arguments: { include_archived: true } })).content[0].text);
    expect(withArchived.messages.length).toBe(1);
    await close();
  });
});
