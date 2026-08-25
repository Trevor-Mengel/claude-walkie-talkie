// The MCP handshake against a real service, and the exact tool inventory.
//
// v0.2 asserted an eight-name set and got there by spawning a daemon with `spawnDaemon(wtDir)`
// while the child auto-joined a session from `WALKIE_TOOL`. Both halves are gone: the child is
// handed a capability, and the inventory grew the two tools that carry the authority model —
// `walkie_enroll` (how a session acquires a capability) and `walkie_ack` (what acknowledgement
// became once reading stopped consuming).
//
// The set is asserted exactly rather than with `toContain`, so adding a tool is a deliberate
// edit here and a silently reintroduced `walkie_join` / `walkie_permit` fails.

import { describe, test, expect } from 'vitest';
import { createStack } from '../helpers/stack.js';
import { spawnMockClient, TOOL_NAMES } from '../helpers/mock-mcp-client.js';
import { spawnMcp } from '../helpers/spawn-mcp.js';

/** Run the MCP child to completion (or to a deadline) and collect its streams. */
function runChild(child, { closeStdinAfterMs = 400 } = {}) {
  return new Promise((resolve) => {
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    // Nothing is sent on stdin, so the server exits when the transport closes. That is also
    // the assertion: it must still be alive to exit, not to have crashed at startup.
    const timer = setTimeout(() => child.stdin.end(), closeStdinAfterMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe('MCP scaffold', () => {
  test('initializes and lists exactly the current tools', async () => {
    const stack = await createStack({
      namespace: 'walkie-scaffold',
      roles: ['root', { name: 'hub', role: 'goal_hub' }]
    });
    const client = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.hub
    });
    try {
      const tools = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
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
      // The helper surface and the server must not drift apart.
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES]);

      // Every tool is described and schema'd: an undescribed tool is unusable by a model.
      for (const tool of tools) {
        expect(tool.description, tool.name).toBeTruthy();
        expect(tool.inputSchema.type, tool.name).toBe('object');
        expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      }
    } finally {
      await client.close();
    }
  }, 20000);

  test('the removed v0.2 tools are absent, not merely undocumented', async () => {
    const stack = await createStack({
      namespace: 'walkie-scaffold2',
      roles: ['root', { name: 'hub', role: 'goal_hub' }]
    });
    const client = await spawnMockClient({
      env: stack.childEnv(),
      capability: stack.tokens.hub
    });
    try {
      const names = (await client.listTools()).map((t) => t.name);
      for (const gone of ['walkie_join', 'walkie_invite', 'walkie_permit', 'walkie_remove']) {
        expect(names).not.toContain(gone);
      }
      const attempt = await client.callRaw('walkie_permit', { mode: 'always' });
      expect(attempt.isError).toBe(true);
      expect(attempt.payload.code).toBe('not_found');
    } finally {
      await client.close();
    }
  }, 20000);

  test('a session with no injected capability comes up and says what to do', async () => {
    const stack = await createStack({ namespace: 'walkie-scaffold3', roles: ['root'] });
    const client = await spawnMockClient({ env: stack.childEnv() });
    try {
      // Listing tools needs no authority: the model has to be able to see walkie_enroll.
      expect((await client.listTools()).map((t) => t.name)).toContain('walkie_enroll');

      const blocked = await client.callRaw('walkie_read', {});
      expect(blocked.isError).toBe(true);
      expect(blocked.payload.code).toBe('unauthenticated');
      expect(blocked.payload.message).toMatch(/walkie_enroll/);
    } finally {
      await client.close();
    }
  }, 20000);

  test('a rejected injected capability is named on stderr and the session still comes up', async () => {
    const stack = await createStack({ namespace: 'walkie-scaffold4', roles: ['root'] });

    // A well-formed token that no store has ever seen: exactly what a stale or revoked
    // supervisor injection looks like from the child's side.
    const child = spawnMcp({
      env: stack.childEnv(),
      capability: 'ZzQ9xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE'
    });
    const { stderr, stdout } = await runChild(child);

    expect(stderr).toMatch(/\[walkie-talkie-mcp] injected capability rejected \(unauthenticated\)/);
    // A rejected injection is reported, not fatal: the session must stay up so the model can
    // still reach walkie_enroll.
    expect(stderr).not.toMatch(/fatal/);
    // stdout is the MCP transport; a diagnostic there would corrupt the protocol stream.
    expect(stdout).toBe('');
    // And the token itself is never echoed.
    expect(stderr).not.toContain('ZzQ9xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE');
  }, 20000);

  test('a usable injected capability produces no startup diagnostic at all', async () => {
    const stack = await createStack({
      namespace: 'walkie-scaffold5',
      roles: ['root', { name: 'hub', role: 'goal_hub' }]
    });
    const child = spawnMcp({ env: stack.childEnv(), capability: stack.tokens.hub });
    const { stderr, stdout } = await runChild(child);
    expect(stderr).toBe('');
    expect(stdout).toBe('');
  }, 20000);
});
