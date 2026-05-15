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
  const client = new Client({ name: 't', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe('walkie_reply / walkie_edit / walkie_archive', () => {
  let project, daemon;
  beforeEach(async () => { project = createTmpProject(); daemon = await spawnDaemon(project.wtDir); });
  afterEach(async () => { await stopDaemon(daemon); cleanup(project); });

  test('reply sets type=reply and replyTo', async () => {
    const http = clientForProject(project.root);
    const seed = await http.post({ body: 'q?', fromSessionId: 'operator', fromAlias: 'operator', fromTool: 'operator' });

    const { client, close } = await startMcp(project.root);
    const me = (await http.sessions()).active[0];
    await http.grantPermit({ sessionId: me.sessionId, mode: 'always' });

    const res = await client.callTool({ name: 'walkie_reply', arguments: { reply_to: seed.id, body: 'answer' } });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.id).toMatch(/^[0-9A-Z]{26}$/);

    const msg = await http.message(parsed.id);
    expect(msg.message.type).toBe('reply');
    expect(msg.message.replyTo).toBe(seed.id);
    await close();
  });

  test('edit bumps revision on own message', async () => {
    const http = clientForProject(project.root);
    const { client, close } = await startMcp(project.root);
    const me = (await http.sessions()).active[0];
    await http.grantPermit({ sessionId: me.sessionId, mode: 'always' });

    const post = await client.callTool({ name: 'walkie_talk', arguments: { body: 'original' } });
    const postParsed = JSON.parse(post.content[0].text);
    const edit = await client.callTool({ name: 'walkie_edit', arguments: { id: postParsed.id, body: 'revised' } });
    const editParsed = JSON.parse(edit.content[0].text);
    expect(editParsed.revision).toBe(1);
    await close();
  });

  test('archive marks the message and excludes it from default reads', async () => {
    const http = clientForProject(project.root);
    const { client, close } = await startMcp(project.root);
    const me = (await http.sessions()).active[0];
    await http.grantPermit({ sessionId: me.sessionId, mode: 'always' });

    const post = await client.callTool({ name: 'walkie_talk', arguments: { body: 'temp' } });
    const id = JSON.parse(post.content[0].text).id;
    await client.callTool({ name: 'walkie_archive', arguments: { id, reason: 'test' } });

    const read = JSON.parse((await client.callTool({ name: 'walkie_read', arguments: {} })).content[0].text);
    expect(read.messages.find((m) => m.id === id)).toBeUndefined();
    await close();
  });
});
