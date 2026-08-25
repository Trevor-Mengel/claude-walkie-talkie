// A connected MCP client driving a real `walkie-talkie-mcp` child process.
//
// The helper surface tracks the current tool set exactly: the eight preserved v0.2 names plus
// `walkie_enroll` and `walkie_ack`. The v0.2 helpers for deleted operations are gone —
// `join`, `invite`, `permit` and friends had no route left to call, so keeping thin wrappers
// around them would only let a test look like it was exercising something.
//
// Every helper returns the parsed tool payload. `callRaw` additionally exposes `isError`,
// because a refusal is a structured payload with `isError: true` rather than a thrown
// exception, and asserting on the code without asserting the flag misses half the contract.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_BIN, encodeCapability } from './spawn-mcp.js';

/** The complete tool inventory, for tests that assert the surface rather than use it. */
export const TOOL_NAMES = Object.freeze([
  'walkie_ack',
  'walkie_archive',
  'walkie_edit',
  'walkie_enroll',
  'walkie_inbox',
  'walkie_read',
  'walkie_rename',
  'walkie_reply',
  'walkie_sessions',
  'walkie_talk'
]);

/**
 * Spawn an MCP child and connect a client to it.
 *
 * @param {object} opts
 * @param {Record<string,string>} opts.env a complete, isolated child environment
 * @param {string} [opts.cwd] defaults to `env.WALKIE_PROJECT_ROOT`
 * @param {string|object} [opts.capability] injected as `WALKIE_CAPABILITY`; omit for an
 *   unenrolled session
 * @param {string} [opts.name] client name reported in the MCP handshake
 */
export async function spawnMockClient({ env, cwd, capability, name = 'mock' } = {}) {
  if (!env) throw new Error('spawnMockClient requires an isolated env');
  const encoded = encodeCapability(capability);
  const childEnv = { ...env };
  if (encoded === undefined) delete childEnv.WALKIE_CAPABILITY;
  else childEnv.WALKIE_CAPABILITY = encoded;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    cwd: cwd ?? childEnv.WALKIE_PROJECT_ROOT,
    env: childEnv,
    stderr: 'pipe'
  });

  const client = new Client(
    { name, version: '0.0.1' },
    { capabilities: { resources: { subscribe: true } } }
  );

  let stderr = '';
  try {
    await client.connect(transport);
    transport.stderr?.setEncoding('utf8');
    transport.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
  } catch (err) {
    // A failed connect must not leave the MCP child running.
    try {
      await transport.close();
    } catch {
      // transport may already be dead
    }
    throw err;
  }

  /** @param {string} tool @param {object} [args] */
  async function callRaw(tool, args = {}) {
    const res = await client.callTool({ name: tool, arguments: args });
    return { payload: JSON.parse(res.content[0].text), isError: res.isError === true };
  }

  /** @param {string} tool @param {object} [args] */
  async function call(tool, args = {}) {
    return (await callRaw(tool, args)).payload;
  }

  return {
    raw: client,
    transport,
    stderr: () => stderr,
    call,
    callRaw,

    // --- the ten tools -------------------------------------------------------------------
    enroll: (args = {}) => call('walkie_enroll', args),
    inbox: (args = {}) => call('walkie_inbox', args),
    ack: (id, args = {}) => call('walkie_ack', { id, ...args }),
    read: (args = {}) => call('walkie_read', args),
    talk: (body, args = {}) => call('walkie_talk', { body, ...args }),
    reply: (replyTo, body) => call('walkie_reply', { reply_to: replyTo, body }),
    edit: (id, body) => call('walkie_edit', { id, body }),
    archive: (id, reason) => call('walkie_archive', { id, ...(reason ? { reason } : {}) }),
    sessions: () => call('walkie_sessions', {}),
    rename: (alias) => call('walkie_rename', { alias }),

    // --- resources -----------------------------------------------------------------------
    listTools: async () => (await client.listTools()).tools,
    listResources: async () => (await client.listResources()).resources,
    readResource: async (uri) => JSON.parse((await client.readResource({ uri })).contents[0].text),
    subscribe: (uri) => client.subscribeResource({ uri }),
    unsubscribe: (uri) => client.unsubscribeResource({ uri }),

    close: () => client.close()
  };
}
