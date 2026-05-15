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
  const client = new Client({ name: 't', version: '0.0.1' }, { capabilities: { resources: { subscribe: true } } });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe('walkie:// resources', () => {
  let project, daemon;
  beforeEach(async () => { project = createTmpProject(); daemon = await spawnDaemon(project.wtDir); });
  afterEach(async () => { await stopDaemon(daemon); cleanup(project); });

  test('lists three resources', async () => {
    const { client, close } = await startMcp(project.root);
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual([
      'walkie://channel/inbox',
      'walkie://channel/recent',
      'walkie://sessions/active'
    ]);
    await close();
  });

  test('reading channel/recent returns latest messages', async () => {
    const http = clientForProject(project.root);
    await http.post({ body: 'hi', fromSessionId: 'operator', fromAlias: 'operator', fromTool: 'operator' });
    const { client, close } = await startMcp(project.root);
    const r = await client.readResource({ uri: 'walkie://channel/recent' });
    const payload = JSON.parse(r.contents[0].text);
    expect(payload.messages[0].body.trim()).toBe('hi');
    await close();
  });

  test('reading sessions/active returns the auto-joined session', async () => {
    const { client, close } = await startMcp(project.root);
    const r = await client.readResource({ uri: 'walkie://sessions/active' });
    const payload = JSON.parse(r.contents[0].text);
    expect(payload.active.length).toBeGreaterThanOrEqual(1);
    await close();
  });
});
