import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { spawnDaemon, stopDaemon } from '../helpers/spawn-daemon.js';
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
  const client = new Client({ name: 't', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe('walkie_sessions / walkie_rename', () => {
  let project, daemon;
  beforeEach(async () => { project = createTmpProject(); daemon = await spawnDaemon(project.wtDir); });
  afterEach(async () => { await stopDaemon(daemon); cleanup(project); });

  test('sessions returns active sessions including self', async () => {
    const { client, close } = await startMcp(project.root);
    const res = await client.callTool({ name: 'walkie_sessions', arguments: {} });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.active.length).toBeGreaterThanOrEqual(1);
    expect(parsed.active.find((s) => s.tool === 'claude-code')).toBeTruthy();
    await close();
  });

  test('rename updates this session alias', async () => {
    const { client, close } = await startMcp(project.root);
    await client.callTool({ name: 'walkie_rename', arguments: { alias: 'demo-builder' } });
    const after = JSON.parse((await client.callTool({ name: 'walkie_sessions', arguments: {} })).content[0].text);
    expect(after.active.find((s) => s.alias === 'demo-builder')).toBeTruthy();
    await close();
  });
});
