import { describe, test, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { spawnDaemon } from '../helpers/spawn-daemon.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_BIN = join(__dirname, '..', '..', 'bin', 'walkie-talkie-mcp.js');

describe('MCP scaffold', () => {
  test('initializes and lists tools', async () => {
    const project = createTmpProject();
    const daemon = await spawnDaemon(project.wtDir);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_BIN],
      env: { ...process.env, WALKIE_PROJECT_ROOT: project.root, WALKIE_TOOL: 'claude-code' }
    });
    const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'walkie_archive',
      'walkie_edit',
      'walkie_inbox',
      'walkie_read',
      'walkie_rename',
      'walkie_reply',
      'walkie_sessions',
      'walkie_talk'
    ]);

    await client.close();
    if (daemon?.child) {
      daemon.child.kill();
      await new Promise((r) => setTimeout(r, 50));
    }
    cleanup(project);
  });
});
