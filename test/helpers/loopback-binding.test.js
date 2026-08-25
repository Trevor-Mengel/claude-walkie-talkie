// The suite's ephemeral listeners must be unreachable by anything but the suite.
//
// `supertest` starts a throw-away server per request with `server.listen(0)` — no host,
// so the wildcard address — and then connects to `127.0.0.1:<port>`. On darwin a wildcard
// bind and a specific `127.0.0.1` bind on the same port coexist happily, and the loopback
// connection resolves to the more specific of the two. So any port that some unrelated
// process on the machine holds on `127.0.0.1` is a port the kernel may hand to a wildcard
// `listen(0)` — and the request supertest sends is then answered by a stranger.
//
// That was not theoretical. It is what made this suite fail roughly one run in three, in a
// different file each time: `501` and `404` from routes this project does not define,
// `ECONNRESET`, `Parse Error: Expected HTTP/, RTSP/ or ICE/`, and SSE reads that never
// resolved. The captured `rawPacket` of one such failure decoded to
// `{"type":"Tier1","version":"1.0"}` — a handshake banner from another application's
// loopback listener, delivered to a supertest client that had asked this project's
// express app a question. Measured on this machine: eleven foreign loopback-only
// listeners inside darwin's ephemeral range, and a wildcard `listen(0)` landed on one of
// them 6 times in 6000 binds against 0 times in 6000 for a loopback-explicit bind.
//
// `installLoopbackBinding` (test/helpers/isolation.js) closes it by making every hostless
// port bind a `127.0.0.1` bind. The kernel will not hand out — or accept a bind on — a
// port already held on the address being bound, so the collision stops being possible
// rather than becoming less likely.
//
// Both halves are asserted below: that the hazard is real on this kernel, and that the
// harness makes it unreachable.

import { describe, test, expect, afterEach } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { installLoopbackBinding } from './isolation.js';
import { createFixtureDir } from './fixture-leaks.js';

/** The exact banner recovered from a poisoned run, so the failure mode is recognisable. */
const STRANGER_BANNER = '{"type":"Tier1","version":"1.0"}\r\n';

const open = [];
const sockets = [];

afterEach(async () => {
  // A half-closed peer keeps `server.close()` waiting, and one of these tests
  // deliberately leaves a failed HTTP exchange behind.
  for (const socket of sockets.splice(0)) socket.destroy();
  while (open.length > 0) {
    const server = open.pop();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

/** @param {net.Server|http.Server} server @param {...unknown} args */
function bind(server, ...args) {
  open.push(server);
  server.on('connection', (socket) => sockets.push(socket));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => resolve(server.address()));
  });
}

/** A process that is not us, holding one loopback port and speaking its own protocol. */
function stranger() {
  return net.createServer((socket) => socket.end(STRANGER_BANNER));
}

/** Whatever comes back from `GET http://127.0.0.1:port/`, HTTP or not. */
function ask(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (err) => resolve({ error: err.code, rawPacket: err.rawPacket?.toString() }));
    req.end();
  });
}

describe('the ephemeral-port hazard this harness exists to remove', () => {
  test('a wildcard bind coexists with a foreign loopback listener, which then answers for it', async () => {
    const held = await bind(stranger(), 0, '127.0.0.1');
    const port = held.port;

    // An explicit wildcard host is left alone by the harness, which is what makes this
    // assertion possible: it is the bind supertest used to get, reproduced deliberately.
    const ours = http.createServer((_req, res) => res.end('ours'));
    await expect(bind(ours, port, '0.0.0.0')).resolves.toMatchObject({ port });

    // Two listeners, one port, and the loopback request goes to the stranger. This is the
    // silent wrong answer that landed on an unrelated test once every few runs.
    const answer = await ask(port);
    expect(answer.status).toBeUndefined();
    expect(answer.error).toBe('HPE_INVALID_CONSTANT');
    expect(answer.rawPacket).toBe(STRANGER_BANNER);
  });

  test('a hostless bind cannot take a port a foreign loopback listener holds', async () => {
    installLoopbackBinding();
    const held = await bind(stranger(), 0, '127.0.0.1');

    // The harness turned this into a loopback bind, so the kernel refuses it outright
    // instead of quietly sharing the port.
    const ours = http.createServer((_req, res) => res.end('ours'));
    await expect(bind(ours, held.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('installLoopbackBinding', () => {
  test('a hostless port bind lands on loopback, and address() is readable at once', () => {
    installLoopbackBinding();
    // Synchronously readable is not a nicety: supertest reads `address().port` on the line
    // after `listen(0)`, and a host passed to `listen` defers the bind by a tick.
    const server = net.createServer();
    open.push(server);
    server.listen(0);
    expect(server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(server.address().port).toBeGreaterThan(0);
  });

  test('the options form and http servers are covered too', async () => {
    installLoopbackBinding();
    const viaOptions = net.createServer();
    open.push(viaOptions);
    viaOptions.listen({ port: 0 });
    expect(viaOptions.address().address).toBe('127.0.0.1');

    const viaHttp = http.createServer((_req, res) => res.end('ours'));
    const address = await bind(viaHttp, 0);
    expect(address.address).toBe('127.0.0.1');
    // And it really serves: the rewrite must not break the listener it rewrites.
    expect(await ask(address.port)).toEqual({ status: 200, body: 'ours' });
  });

  test('the listening callback still fires, and only once', async () => {
    installLoopbackBinding();
    const server = net.createServer();
    open.push(server);
    let calls = 0;
    await new Promise((resolve) => server.listen(0, () => { calls += 1; resolve(undefined); }));
    expect(calls).toBe(1);
    expect(server.address().address).toBe('127.0.0.1');
  });

  test('a unix socket and an explicit host are passed through untouched', async () => {
    installLoopbackBinding();
    const { rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = createFixtureDir('wk-lb-');
    try {
      // A path bind must not acquire a host — the product binds both sockets this way.
      const viaPath = net.createServer();
      const socketPath = join(root, 'u.sock');
      await bind(viaPath, socketPath);
      expect(viaPath.address()).toBe(socketPath);

      const viaOptionsPath = net.createServer();
      await bind(viaOptionsPath, { path: join(root, 'v.sock'), backlog: 8 });
      expect(viaOptionsPath.address()).toBe(join(root, 'v.sock'));

      // An explicit host is the caller's decision. src/daemon/transport.js passes one on
      // purpose, and this harness must not silently override it.
      const viaHost = net.createServer();
      const address = await bind(viaHost, 0, '127.0.0.1');
      expect(address.address).toBe('127.0.0.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('installing twice does not wrap listen twice', () => {
    installLoopbackBinding();
    const once = net.Server.prototype.listen;
    installLoopbackBinding();
    expect(net.Server.prototype.listen).toBe(once);
  });
});
