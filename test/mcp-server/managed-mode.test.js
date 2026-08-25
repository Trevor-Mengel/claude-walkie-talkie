// Managed mode: a client connects, or it fails with guidance. It never starts anything.
//
// v0.2's MCP entry point called `ensureDaemon(projectRoot)` before doing anything else, so
// launching an MCP client left a detached, unsupervised daemon behind — the finding that matters
// most to Paseo, because it takes execution ownership away from the supervisor.

import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer } from '../../src/mcp-server/index.js';
import { createRegisteredNamespace } from '../helpers/registered-namespace.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE = 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDe4FgH7jKl0MnO';
const TOKEN = 'PsQ2xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE';

/** Every `.js` file under a source directory, recursively. */
function sourceFiles(...dirs) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  for (const dir of dirs) walk(join(PKG_ROOT, dir));
  return out;
}

/** Source with comments removed, so a prose mention is never mistaken for a call. */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

describe('no auto-daemon', () => {
  test('building the server with nothing listening starts no process and creates no socket', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    expect(readdirSync(ns.runtimeRoot)).toEqual([]);

    const { context, capability } = await createMcpServer({
      env: ns.env,
      cwd: ns.canonicalRoot,
      runtimeRoot: ns.runtimeRoot
    });

    expect(context.mode).toBe('managed');
    expect(context.namespace).toBe(ns.namespace);
    expect(context.socketPath).toBe(ns.socketPath);
    // Nothing was bound, nothing was written: no socket, no pid file, no lock.
    expect(readdirSync(ns.runtimeRoot)).toEqual([]);
    expect(existsSync(ns.socketPath)).toBe(false);
    // And the session is honestly unenrolled rather than pretending to hold authority.
    expect(capability.state()).toBe('unenrolled');
  });

  test('a tool call against a dead service names the Paseo-supervised process', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    const { tools } = await createMcpServer({
      env: ns.env,
      cwd: ns.canonicalRoot,
      runtimeRoot: ns.runtimeRoot
    });

    const result = await tools.call({
      params: {
        name: 'walkie_enroll',
        arguments: {
          namespace: ns.namespace,
          role: 'root',
          scopes: ['channel:read'],
          enrollmentCode: CODE
        }
      }
    });
    const payload = payloadOf(result);

    expect(payload.code).toBe('unavailable');
    expect(payload.message).toMatch(/walkie-svc/);
    expect(payload.message).toMatch(/Paseo/);
    expect(payload.message).toMatch(/clients never start it/);
    // The remedy must not be "we'll start one for you", and must not leak the socket path.
    expect(payload.message).not.toContain(ns.socketPath);
    expect(readdirSync(ns.runtimeRoot)).toEqual([]);
  });

  test('an injected capability that cannot be verified is held, not thrown away', async () => {
    // This assertion used to read `toBe('invalid')`, which encoded the Wave F blocker: the
    // holder could not tell "the supervisor's service is not up yet" from "the server refused
    // your bearer", so a managed session whose service was still starting DISCARDED a
    // supervisor-injected credential. In managed mode the client cannot start the service, so
    // the only recovery left was to enroll again and ask the operator to approve a second
    // time — over a credential that was never refused by anyone.
    const ns = createRegisteredNamespace({
      mode: 'managed',
      env: { WALKIE_CAPABILITY: TOKEN }
    });

    const { capability, injectionError } = await createMcpServer({
      env: ns.env,
      cwd: ns.canonicalRoot,
      runtimeRoot: ns.runtimeRoot
    });

    // The startup report keeps its code and its managed-mode remedy...
    expect(injectionError.code).toBe('unavailable');
    expect(injectionError.message).toMatch(/Paseo/);
    // ...and now also says the credential was kept, so nothing re-enrolls over an outage.
    expect(injectionError.detail).toMatchObject({ credentialRetained: true });

    // Still fails closed — nothing may act on an unconfirmed identity...
    expect(capability.identity()).toBe(null);
    expect(() => capability.requireActive()).toThrow(/could not be reached/);
    // ...but the guidance is the managed-mode one, and the credential survives for a retry.
    expect(capability.state()).toBe('unverified');
    expect(readdirSync(ns.runtimeRoot)).toEqual([]);
  });

  test('standalone mode gets the standalone remedy, not the supervisor one', async () => {
    const ns = createRegisteredNamespace({ mode: 'standalone' });
    const { tools } = await createMcpServer({
      env: ns.env,
      cwd: ns.canonicalRoot,
      runtimeRoot: ns.runtimeRoot
    });

    const payload = payloadOf(
      await tools.call({
        params: {
          name: 'walkie_enroll',
          arguments: {
            namespace: ns.namespace,
            role: 'root',
            scopes: ['channel:read'],
            enrollmentCode: CODE
          }
        }
      })
    );
    expect(payload.code).toBe('unavailable');
    expect(payload.message).toMatch(/walkie start/);
    expect(payload.message).not.toMatch(/Paseo/);
  });
});

describe('the client cannot spawn a service', () => {
  test('ensureDaemon has no production caller anywhere in src/ or bin/', () => {
    const hits = sourceFiles('src', 'bin')
      .map((file) => ({ file, code: codeOf(file) }))
      .filter(({ code }) => /ensureDaemon\s*\(/.test(code));
    expect(hits.map((h) => h.file)).toEqual([]);
  });

  test('no client module can reach child_process at all', () => {
    const offenders = sourceFiles('src/mcp-server', 'src/client', 'src/cli')
      .map((file) => ({ file, code: codeOf(file) }))
      .filter(({ code }) => /child_process/.test(code))
      // `walkie init` shells out to `git config user.name`, which starts no service.
      .filter(({ file }) => !file.endsWith(join('src', 'cli', 'init.js')));
    expect(offenders.map((h) => h.file)).toEqual([]);
  });

  test('no client module calls a process-spawning function', () => {
    const offenders = sourceFiles('src/mcp-server', 'src/client', 'src/cli')
      .map((file) => ({ file, code: codeOf(file) }))
      .filter(({ code }) => /(?<![.\w])(spawn|spawnSync|fork|execFile|execFileSync)\s*\(/.test(code))
      .filter(({ file }) => !file.endsWith(join('src', 'cli', 'init.js')));
    expect(offenders.map((h) => h.file)).toEqual([]);
  });

  test('only the standalone-only lifecycle commands touch the daemon lifecycle module', () => {
    const importers = sourceFiles('src/mcp-server', 'src/client', 'src/cli')
      .filter((file) => /from '\.\.\/daemon\/lifecycle\.js'/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(PKG_ROOT.length + 1))
      .sort();
    expect(importers).toEqual(['src/cli/start.js', 'src/cli/status.js', 'src/cli/stop.js']);
  });

  test('WALKIE_TOOL and WALKIE_ALIAS are no longer identity inputs', () => {
    const offenders = sourceFiles('src/mcp-server', 'src/client')
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter(({ text }) => /env\.WALKIE_(TOOL|ALIAS)|WALKIE_TOOL\]|WALKIE_ALIAS\]/.test(text));
    expect(offenders.map((h) => h.file)).toEqual([]);
    // ...and the shipped MCP manifest no longer injects one.
    const manifest = JSON.parse(readFileSync(join(PKG_ROOT, '.mcp.json'), 'utf8'));
    expect(manifest.mcpServers['walkie-talkie'].env).toBeUndefined();
  });
});

describe('the shipped entry point', () => {
  test('bin/walkie-talkie-mcp.js serves the tool list over stdio with nothing listening', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(PKG_ROOT, 'bin', 'walkie-talkie-mcp.js')],
      env: ns.env,
      cwd: ns.canonicalRoot,
      stderr: 'pipe'
    });
    const client = new Client({ name: 'b4-smoke', version: '0.0.1' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
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

      // An unenrolled session serves its inventory and refuses to act, in one consistent way.
      const result = await client.callTool({ name: 'walkie_read', arguments: {} });
      expect(JSON.parse(result.content[0].text).code).toBe('unauthenticated');
    } finally {
      await client.close();
    }
    // Serving a tool list started no service and left no runtime artefact behind.
    expect(readdirSync(ns.runtimeRoot)).toEqual([]);
  });
});
