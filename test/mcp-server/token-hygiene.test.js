// A full enroll -> talk -> fail cycle through the real MCP stack against a stub service, then a
// sweep for the token.
//
// The rule under test: a capability token exists in exactly two places — the response body that
// issued it, and the Authorization header of subsequent requests. Not on disk, not in a tool
// response, not in an error message, not in a log line.

import { describe, test, expect, afterEach } from 'vitest';
import http from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createMcpServer } from '../../src/mcp-server/index.js';
import { createRegisteredNamespace } from '../helpers/registered-namespace.js';

const TOKEN = 'ZzQ9xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE';
const CODE = 'Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDe4FgH7jKl0MnO';

const SELF = {
  principalId: 'prn_01',
  role: 'root',
  displayAlias: 'builder',
  scopes: ['channel:read', 'channel:publish', 'channel:ack', 'self:alias', 'self:cursor'],
  capabilityId: 'cap_01',
  expiresAt: '2030-01-01T00:00:00.000Z'
};

/** @type {Array<() => Promise<void>>} */
const teardown = [];
afterEach(async () => {
  while (teardown.length) await teardown.pop()();
});

function stubService(socketPath) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const reply = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'POST' && req.url === '/enroll/exchange') {
        return reply(201, {
          token: TOKEN,
          capabilityId: SELF.capabilityId,
          principalId: SELF.principalId,
          role: SELF.role,
          scopes: SELF.scopes,
          expiresAt: SELF.expiresAt
        });
      }
      if (req.method === 'GET' && req.url === '/self') return reply(200, SELF);
      if (req.method === 'POST' && req.url === '/channel/message') {
        return reply(201, { id: '01HZZZ', warnings: [] });
      }
      if (req.method === 'GET' && req.url.startsWith('/inbox')) {
        return reply(200, { messages: [], mentionedForMe: [], lastReadId: '', lastAckedId: '' });
      }
      if (req.method === 'PATCH') {
        return reply(403, {
          error: { code: 'not_owner', message: 'only the author may edit a message' }
        });
      }
      return reply(404, { error: { code: 'not_found', message: 'no such route' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      let closed = false;
      const close = () =>
        new Promise((done) => {
          if (closed) return done();
          closed = true;
          server.close(() => done());
        });
      teardown.push(close);
      resolve({ seen, close });
    });
  });
}

/** Every regular file under `dir`, recursively. */
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
      else if (entry.isSymbolicLink()) {
        try {
          if (statSync(full).isFile()) out.push(full);
        } catch {
          // A dangling link holds no bytes.
        }
      }
    }
  };
  walk(dir);
  return out;
}

describe('token hygiene across a full enroll and publish cycle', () => {
  test('the token reaches the Authorization header and nothing else', async () => {
    const ns = createRegisteredNamespace({ mode: 'managed' });
    const service = await stubService(ns.socketPath);
    const stderr = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderr.push(String(chunk));
      return originalWrite(chunk, ...rest);
    };
    teardown.push(() => {
      process.stderr.write = originalWrite;
    });

    const { tools, capability, context } = await createMcpServer({
      env: ns.env,
      cwd: ns.canonicalRoot,
      runtimeRoot: ns.runtimeRoot
    });
    const call = (name, args = {}) => tools.call({ params: { name, arguments: args } });
    const texts = [];
    const collect = async (name, args) => {
      const result = await call(name, args);
      texts.push(result.content.map((c) => c.text).join('\n'));
      return result;
    };

    // 1. enroll — the only response that legitimately contains a token, and the MCP layer must
    //    not pass it on.
    const enrolled = await collect('walkie_enroll', {
      namespace: ns.namespace,
      role: 'root',
      scopes: SELF.scopes,
      enrollmentCode: CODE
    });
    expect(JSON.parse(enrolled.content[0].text)).toEqual({
      status: 'enrolled',
      role: SELF.role,
      scopes: SELF.scopes,
      expiresAt: SELF.expiresAt
    });
    expect(capability.state()).toBe('active');
    expect(capability.identity()).toMatchObject({
      principalId: SELF.principalId,
      displayAlias: 'builder',
      role: 'root'
    });

    // 2. talk and read — authenticated, and stating no identity.
    await collect('walkie_talk', { body: 'hello from a capability' });
    await collect('walkie_inbox', {});
    // 3. a real refusal, so an error path is on the record too.
    const refused = await collect('walkie_edit', { id: '01HZZZ', body: 'nope' });
    expect(JSON.parse(refused.content[0].text).code).toBe('not_owner');

    // The header carried it on every authenticated request, and only there.
    const authed = service.seen.filter((r) => r.url !== '/enroll/exchange');
    expect(authed.length).toBeGreaterThanOrEqual(4);
    for (const req of authed) expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    for (const req of service.seen) expect(req.body).not.toContain(TOKEN);

    // No tool response ever contains it.
    for (const text of texts) expect(text).not.toContain(TOKEN);

    // 4. an `unavailable` error, raised after the service goes away.
    await service.close();
    const dead = await collect('walkie_read', {});
    expect(JSON.parse(dead.content[0].text).code).toBe('unavailable');
    for (const text of texts) expect(text).not.toContain(TOKEN);

    // Nothing under any disposable root holds it: not the runtime dir, not the project, not the
    // harness's home/config/history tree.
    const roots = [ns.base, process.env.WALKIE_ISOLATION_ROOT].filter(Boolean);
    let scanned = 0;
    for (const root of roots) {
      for (const file of filesUnder(root)) {
        scanned += 1;
        expect(readFileSync(file, 'utf8').includes(TOKEN), `${file} contains the token`).toBe(false);
      }
    }
    expect(scanned).toBeGreaterThan(0);
    // The runtime dir is where a careless implementation would cache a credential. Only the
    // stub's socket may ever have been there (and closing it already unlinked the node).
    expect(readdirSync(ns.runtimeRoot).filter((name) => name !== 'walkie.sock')).toEqual([]);

    // And nothing was written to stderr with it in.
    for (const line of stderr) expect(line).not.toContain(TOKEN);
    expect(context.namespace).toBe(ns.namespace);
  });

  test('an injected credential document is used for its token only, and drift is reported', async () => {
    const ns = createRegisteredNamespace({
      mode: 'managed',
      env: {
        // Stale on purpose: the document claims a narrower role and older expiry than the
        // service reports.
        WALKIE_CAPABILITY: JSON.stringify({
          token: TOKEN,
          capabilityId: SELF.capabilityId,
          principalId: SELF.principalId,
          role: 'listener',
          scopes: ['channel:read'],
          expiresAt: '2020-01-01T00:00:00.000Z'
        })
      }
    });
    const service = await stubService(ns.socketPath);
    const stderr = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderr.push(String(chunk));
      return originalWrite(chunk, ...rest);
    };
    teardown.push(() => {
      process.stderr.write = originalWrite;
    });

    const { capability, injectionError } = await createMcpServer({
      env: ns.env,
      cwd: ns.canonicalRoot,
      runtimeRoot: ns.runtimeRoot
    });

    expect(injectionError).toBeNull();
    expect(capability.state()).toBe('active');
    // The service's answer wins.
    expect(capability.identity()).toMatchObject({ role: 'root', scopes: SELF.scopes });
    const drift = stderr.find((line) => line.includes('disagrees with the service'));
    expect(drift).toBeTruthy();
    expect(drift).toMatch(/expiresAt/);
    expect(drift).toMatch(/role/);
    expect(drift).toMatch(/scopes/);
    // Reporting drift must not report the credential itself.
    for (const line of stderr) expect(line).not.toContain(TOKEN);
    expect(service.seen.map((r) => r.url)).toEqual(['/self']);
  });
});
