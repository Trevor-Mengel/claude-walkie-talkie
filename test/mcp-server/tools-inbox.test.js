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

async function startMcpClient(projectRoot, tool = 'claude-code') {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    env: { ...process.env, WALKIE_PROJECT_ROOT: projectRoot, WALKIE_TOOL: tool }
  });
  const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe('walkie_inbox', () => {
  let project;
  let daemon;
  beforeEach(async () => { project = createTmpProject(); daemon = await spawnDaemon(project.wtDir); });
  afterEach(async () => { await stopDaemon(daemon); cleanup(project); });

  test('returns the operator-posted message and then returns empty', async () => {
    const http = clientForProject(project.root);
    await http.post({ body: 'hello', fromSessionId: 'operator', fromAlias: 'operator', fromTool: 'operator' });

    const { client, close } = await startMcpClient(project.root, 'claude-code');
    const first = await client.callTool({ name: 'walkie_inbox', arguments: {} });
    const firstParsed = JSON.parse(first.content[0].text);
    expect(firstParsed.messages.length).toBe(1);
    expect(firstParsed.messages[0].body.trim()).toBe('hello');

    const second = await client.callTool({ name: 'walkie_inbox', arguments: {} });
    const secondParsed = JSON.parse(second.content[0].text);
    expect(secondParsed.messages.length).toBe(0);
    await close();
  });
});
