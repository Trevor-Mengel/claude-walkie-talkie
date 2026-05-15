import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_BIN = join(__dirname, '..', '..', 'bin', 'walkie-talkie-mcp.js');

/**
 * Spawn a fresh walkie-talkie-mcp child process and connect an MCP client to it.
 * Returns a high-level helper covering the conversation operations used in
 * the E2E harness.
 */
export async function spawnMockClient({ projectRoot, tool = 'claude-code', alias }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    env: {
      ...process.env,
      WALKIE_PROJECT_ROOT: projectRoot,
      WALKIE_TOOL: tool,
      ...(alias ? { WALKIE_ALIAS: alias } : {})
    }
  });
  const client = new Client({ name: 'mock', version: '0.0.1' }, { capabilities: { resources: { subscribe: true } } });
  await client.connect(transport);

  async function call(name, args = {}) {
    const res = await client.callTool({ name, arguments: args });
    return JSON.parse(res.content[0].text);
  }

  return {
    raw: client,
    inbox: (opts) => call('walkie_inbox', opts),
    read: (opts) => call('walkie_read', opts ?? {}),
    talk: (body, opts = {}) => call('walkie_talk', { body, ...opts }),
    reply: (replyTo, body) => call('walkie_reply', { reply_to: replyTo, body }),
    edit: (id, body) => call('walkie_edit', { id, body }),
    archive: (id, reason) => call('walkie_archive', { id, ...(reason ? { reason } : {}) }),
    sessions: () => call('walkie_sessions', {}),
    rename: (alias) => call('walkie_rename', { alias }),
    close: () => client.close()
  };
}
