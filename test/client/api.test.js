// The shared HTTP client, exercised against a real Unix-socket HTTP server.
//
// This is the layer where "authority travels in exactly one place" is either true or not, so
// the assertions are on what actually goes over the wire: the Authorization header, the request
// body, and what a failure is allowed to say.

import { describe, test, expect, afterEach } from 'vitest';
import http from 'node:http';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createApiClient, DEFAULT_TIMEOUT_MS, unavailableError } from '../../src/client/api.js';
import { assertDisposable } from '../helpers/isolation.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

/** @type {Array<() => Promise<void>|void>} */
const teardown = [];
afterEach(async () => {
  while (teardown.length) await teardown.pop()();
});

/**
 * A stub service on a Unix socket. `handler(record)` returns `{ status, json }`; every request
 * is recorded.
 */
function stubService(handler) {
  const dir = realpathSync(createFixtureDir('wk-api-'));
  assertDisposable(dir, 'stub service dir');
  const socketPath = join(dir, 's.sock');
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw === '' ? null : JSON.parse(raw)
      };
      seen.push(record);
      const { status = 200, json = {} } = handler?.(record) ?? {};
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      teardown.push(
        () =>
          new Promise((done) => {
            server.close(() => {
              rmSync(dir, { recursive: true, force: true });
              done();
            });
          })
      );
      resolve({ socketPath, seen, dir });
    });
  });
}

function clientFor(socketPath, token = 'tok-abc') {
  return createApiClient({
    endpoint: { socketPath },
    namespace: 'collabcast-test',
    mode: 'managed',
    token: () => token
  });
}

/**
 * A stub service that writes a RAW body: the JSON stub above can only produce valid JSON,
 * and the thing under test here is what happens when a 2xx body is not JSON at all.
 *
 * @param {{status?:number, body?:string, contentType?:string|null}} reply
 */
function rawService(reply) {
  const dir = realpathSync(createFixtureDir('wk-api-raw-'));
  assertDisposable(dir, 'raw stub service dir');
  const socketPath = join(dir, 's.sock');
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const headers = reply.contentType === null ? {} : { 'content-type': 'application/json' };
      res.writeHead(reply.status ?? 200, headers);
      res.end(reply.body ?? '');
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      teardown.push(
        () =>
          new Promise((done) => {
            server.close(() => {
              rmSync(dir, { recursive: true, force: true });
              done();
            });
          })
      );
      resolve({ socketPath });
    });
  });
}

describe('client api transport', () => {
  test('every authenticated call carries the bearer and nothing else identifying', async () => {
    const svc = await stubService(() => ({ status: 201, json: { id: 'm1', warnings: [] } }));
    const api = clientFor(svc.socketPath, 'secret-token-value');

    await api.post({ body: 'hello', type: 'broadcast' });

    expect(svc.seen).toHaveLength(1);
    const [req] = svc.seen;
    expect(req.headers.authorization).toBe('Bearer secret-token-value');
    // The body states content, never authority.
    expect(Object.keys(req.body).sort()).toEqual(['body', 'type']);
  });

  test('health and enroll/exchange are sent unauthenticated', async () => {
    const svc = await stubService((req) =>
      req.url === '/health'
        ? { json: { ok: true, namespace: 'collabcast-test', mode: 'managed', schemaVersion: '3' } }
        : { status: 201, json: { token: 't', capabilityId: 'cap_1' } }
    );
    const api = clientFor(svc.socketPath, 'secret-token-value');

    await api.health();
    await api.enrollExchange('code-value');

    expect(svc.seen.map((r) => r.headers.authorization)).toEqual([undefined, undefined]);
    expect(svc.seen[1].body).toEqual({ enrollmentCode: 'code-value' });
  });

  test('an error envelope becomes a CollabcastError with the same code and detail', async () => {
    const svc = await stubService(() => ({
      status: 403,
      json: {
        error: {
          code: 'scope_required',
          message: 'needs channel:publish',
          detail: { scope: 'channel:publish' }
        }
      }
    }));
    const api = clientFor(svc.socketPath);

    await expect(api.post({ body: 'x' })).rejects.toMatchObject({
      name: 'CollabcastError',
      code: 'scope_required',
      message: 'needs channel:publish',
      detail: { scope: 'channel:publish' },
      status: 403
    });
  });

  test('a non-envelope failure body is never echoed back to the caller', async () => {
    const svc = await stubService(() => ({
      status: 502,
      json: { oops: 'Bearer leaked-token-here' }
    }));
    const api = clientFor(svc.socketPath);

    const err = await api.latest().catch((e) => e);
    expect(err.code).toBe('internal');
    expect(err.message).not.toContain('leaked-token-here');
    expect(JSON.stringify(err.detail)).not.toContain('leaked-token-here');
  });

  test('a missing socket is `unavailable` and names the supervisor, not the path', async () => {
    const dir = realpathSync(createFixtureDir('wk-api-'));
    teardown.push(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, 'absent.sock');
    const api = clientFor(socketPath);

    const err = await api.latest().catch((e) => e);
    expect(err.code).toBe('unavailable');
    expect(err.message).toMatch(/Paseo/);
    expect(err.message).toMatch(/collabcast-test/);
    expect(err.message).not.toContain(socketPath);
    expect(err.message).not.toContain('.sock');
  });

  test('standalone mode is told to run collabcast start instead of naming a supervisor', () => {
    const err = unavailableError({ namespace: 'collabcast-test', mode: 'standalone' });
    expect(err.code).toBe('unavailable');
    expect(err.message).toMatch(/collabcast start/);
    expect(err.message).not.toMatch(/Paseo/);
  });

  test('query flags are rendered the way the service parses them', async () => {
    const svc = await stubService(() => ({ json: { messages: [] } }));
    const api = clientFor(svc.socketPath);

    await api.latest(20, true);
    await api.inbox({ includeMemoryUpdates: true });
    await api.inbox();

    expect(svc.seen.map((r) => r.url)).toEqual([
      '/channel/latest?limit=20&include_archived=true',
      '/inbox?include_memory_updates=true',
      '/inbox?include_memory_updates=false'
    ]);
  });

  test('the request timeout is bounded for a local socket', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

// A 2xx body used to be coerced to `{}` when it did not parse. That is the one wrong answer:
// a truncated `GET /inbox` became an inbox with no `messages`, which a model reads as an
// authoritative "nothing to read", and a truncated `/enroll/exchange` became a token-less
// success. An unreadable response is a failure and says so.
describe('client api: an unreadable 2xx is a failure, not an empty result', () => {
  test('a truncated JSON body on 200 rejects as internal rather than resolving {}', async () => {
    const svc = await rawService({ status: 200, body: '{"messages":[{"id":"01H' });
    const api = clientFor(svc.socketPath);

    const err = await api.inbox().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CollabcastError');
    expect(err.code).toBe('internal');
    expect(err.status).toBe(200);
    expect(err.detail).toMatchObject({ namespace: 'collabcast-test', status: 200, bytes: 23 });
    // The unreadable body is never echoed: it could contain anything.
    expect(err.message).not.toContain('messages');
    expect(JSON.stringify(err.detail)).not.toContain('01H');
  });

  test('a token-less garbled enroll exchange fails instead of succeeding', async () => {
    const svc = await rawService({ status: 200, body: '{"token":"tok' });
    const api = clientFor(svc.socketPath);

    await expect(api.enrollExchange('code-abc')).rejects.toMatchObject({ code: 'internal' });
  });

  test('non-JSON on 200 (an HTML error page) rejects as internal', async () => {
    const svc = await rawService({ status: 200, body: '<html>proxy error</html>' });
    const api = clientFor(svc.socketPath);

    const err = await api.latest().catch((e) => e);
    expect(err.code).toBe('internal');
    expect(err.message).not.toContain('proxy error');
  });

  test('a bare `null` on 200 describes no result either', async () => {
    const svc = await rawService({ status: 200, body: 'null' });
    const api = clientFor(svc.socketPath);

    await expect(api.self()).rejects.toMatchObject({ code: 'internal' });
  });

  test('an empty 204 body still resolves — a no-content route returns nothing', async () => {
    const svc = await rawService({ status: 204, body: '', contentType: null });
    const api = clientFor(svc.socketPath);

    await expect(api.markRead(7)).resolves.toEqual({});
  });

  test('an empty 200 body resolves too', async () => {
    const svc = await rawService({ status: 200, body: '' });
    const api = clientFor(svc.socketPath);

    await expect(api.ack(3)).resolves.toEqual({});
  });

  test('a readable 2xx object is still returned verbatim', async () => {
    const svc = await rawService({ status: 200, body: '{"messages":[{"id":"01H"}]}' });
    const api = clientFor(svc.socketPath);

    await expect(api.inbox()).resolves.toEqual({ messages: [{ id: '01H' }] });
  });

  test('an unparseable FAILURE body keeps its status-shaped error', async () => {
    const svc = await rawService({ status: 500, body: '<html>Bearer leaked-token</html>' });
    const api = clientFor(svc.socketPath);

    const err = await api.latest().catch((e) => e);
    expect(err.code).toBe('internal');
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/unrecognised HTTP 500/);
    expect(err.message).not.toContain('leaked-token');
  });
});
