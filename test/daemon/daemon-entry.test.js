// The composition root itself.
//
// Every other daemon test builds the stack from `test/helpers/stack.js`, and that fixture wires
// the authority socket with its own `startAuthority` call. A fixture that constructs the subject
// cannot notice the subject not being constructed — which is exactly how `walkie-svc` shipped a
// boot that bound HTTP, answered `/health`, and could never issue a first capability. So this
// file deliberately imports NOTHING from `stack.js`: it starts the real service the real way
// (namespace from the identity map, config from the project) and then performs the bootstrap a
// fresh install has to perform.

import net from 'node:net';
import http from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startService } from '../../src/daemon/daemon-entry.js';
import {
  DEFAULT_ENROLL_TTL_SECONDS,
  ROLE_SCOPES,
  SECRET_FILENAME,
  SOCKET_FILENAME
} from '../../src/authority/index.js';
import { createRegisteredNamespace } from '../helpers/registered-namespace.js';

const NAMESPACE = 'walkie-entry';

/** Every service this file started, so a failed assertion cannot leak a listener. */
const running = [];

afterEach(async () => {
  while (running.length > 0) {
    const service = running.pop();
    try {
      await service.stop();
    } catch {
      // A test may have stopped it already, or be asserting on a broken teardown.
    }
  }
});

/** A namespace with no authority artifacts in it yet: the fresh-install starting point. */
function freshNamespace() {
  const ns = createRegisteredNamespace({ namespace: NAMESPACE, mode: 'standalone' });
  expect(existsSync(join(ns.runtimeRoot, SOCKET_FILENAME))).toBe(false);
  expect(existsSync(join(ns.runtimeRoot, SECRET_FILENAME))).toBe(false);
  return ns;
}

/**
 * Starts the real service, capturing what an operator would see on stdout instead of writing it.
 * @param {ReturnType<typeof createRegisteredNamespace>} ns
 */
async function boot(ns) {
  /** @type {object[]} */
  const logs = [];
  const service = await startService({
    cwd: ns.canonicalRoot,
    env: ns.env,
    log: (entry) => logs.push(entry)
  });
  running.push(service);
  return { service, logs, text: () => JSON.stringify(logs) };
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

/**
 * One line in, one line out, over the authority's enrollment socket.
 * @param {string} socketPath
 * @param {object} payload
 * @returns {Promise<object>}
 */
function authorityRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer.trim()));
      } catch {
        reject(new Error(`the authority did not answer with one JSON line: ${buffer}`));
      }
    });
  });
}

/**
 * @param {{socketPath:string, method:string, path:string, token?:string, body?:object}} opts
 * @returns {Promise<{status:number, body:any}>}
 */
function httpRequest({ socketPath, method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    /** @type {Record<string,string|number>} */
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ socketPath, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          parsed = { raw: text };
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('startService bootstrap', () => {
  it('mints the hook secret and binds the authority socket the OMP hook needs', async () => {
    const ns = freshNamespace();
    const { service, logs, text } = await boot(ns);

    const socketPath = join(ns.runtimeRoot, SOCKET_FILENAME);
    const secretPath = join(ns.runtimeRoot, SECRET_FILENAME);

    expect(service.authoritySocketPath).toBe(socketPath);
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect(mode(socketPath)).toBe(0o600);
    expect(mode(ns.runtimeRoot)).toBe(0o700);

    expect(existsSync(secretPath)).toBe(true);
    expect(mode(secretPath)).toBe(0o600);
    expect(service.hookSecretPath).toBe(secretPath);

    // Requirement 4: an operator must be able to wire both env vars from the startup output.
    const ready = logs.find((entry) => entry.event === 'service.ready');
    expect(ready).toMatchObject({
      namespace: NAMESPACE,
      runtimeRoot: ns.runtimeRoot,
      authoritySocket: socketPath,
      hookSecretPath: secretPath,
      hookSecretSource: 'created'
    });

    // The path, never the value.
    const secret = readFileSync(secretPath, 'utf8').trim();
    expect(secret.length).toBeGreaterThan(16);
    expect(text()).not.toContain(secret);
  });

  it('performs the whole first-capability bootstrap a fresh install could not', async () => {
    const ns = freshNamespace();
    const { service, text } = await boot(ns);
    const secret = readFileSync(join(ns.runtimeRoot, SECRET_FILENAME), 'utf8').trim();

    // 1. the OMP hook's `enroll()`: one line on the authority socket, authenticated by the
    //    secret the daemon just minted. Nothing else in the system can produce a code.
    const reply = await authorityRequest(service.authoritySocketPath, {
      op: 'enroll.request',
      namespace: NAMESPACE,
      role: 'root',
      scopes: [...ROLE_SCOPES.root],
      ttlSeconds: DEFAULT_ENROLL_TTL_SECONDS,
      hookSecret: secret
    });
    expect(reply.error, JSON.stringify(reply)).toBeUndefined();
    expect(typeof reply.code).toBe('string');

    // 2. redeem it on the only route mounted ahead of the capability gate.
    const socketPath = service.addresses.socket;
    const exchanged = await httpRequest({
      socketPath,
      method: 'POST',
      path: '/enroll/exchange',
      body: { enrollmentCode: reply.code }
    });
    expect(exchanged.status).toBe(201);
    expect(exchanged.body.role).toBe('root');
    expect(typeof exchanged.body.token).toBe('string');

    // 3. the capability actually opens a gated route — and only with the token.
    const authenticated = await httpRequest({
      socketPath,
      method: 'GET',
      path: '/self',
      token: exchanged.body.token
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.principalId).toBe(exchanged.body.principalId);
    expect(authenticated.body.scopes).toEqual(expect.arrayContaining([...ROLE_SCOPES.root]));

    const anonymous = await httpRequest({ socketPath, method: 'GET', path: '/self' });
    expect(anonymous.status).toBe(401);

    // The enrollment code and the token are credentials; neither may reach the log.
    expect(text()).not.toContain(reply.code);
    expect(text()).not.toContain(exchanged.body.token);
    expect(text()).not.toContain(secret);
  });

  it('refuses a bad hook secret on the socket it just bound', async () => {
    const ns = freshNamespace();
    const { service } = await boot(ns);

    const reply = await authorityRequest(service.authoritySocketPath, {
      op: 'enroll.request',
      namespace: NAMESPACE,
      role: 'root',
      scopes: [...ROLE_SCOPES.root],
      ttlSeconds: DEFAULT_ENROLL_TTL_SECONDS,
      hookSecret: 'not-the-secret'
    });
    expect(reply.code).toBeUndefined();
    expect(reply.error).toBeTruthy();
  });

  it('removes both sockets on stop, and stopping twice is safe', async () => {
    const ns = freshNamespace();
    const { service } = await boot(ns);
    const authoritySocket = service.authoritySocketPath;
    const transportSocket = service.addresses.socket;
    const pidPath = join(ns.runtimeRoot, 'walkie.pid');

    expect(existsSync(authoritySocket)).toBe(true);
    expect(existsSync(transportSocket)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);

    await service.stop();

    expect(existsSync(authoritySocket)).toBe(false);
    expect(existsSync(transportSocket)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);

    // The secret is the operator's wiring, not per-boot state: it must survive a restart.
    expect(existsSync(join(ns.runtimeRoot, SECRET_FILENAME))).toBe(true);

    await expect(service.stop()).resolves.toBeUndefined();
  });

  it('reuses the existing secret across a restart', async () => {
    const ns = freshNamespace();
    const first = await boot(ns);
    const secretPath = join(ns.runtimeRoot, SECRET_FILENAME);
    const secret = readFileSync(secretPath, 'utf8').trim();
    await first.service.stop();

    const second = await boot(ns);
    expect(readFileSync(secretPath, 'utf8').trim()).toBe(secret);
    const ready = second.logs.find((entry) => entry.event === 'service.ready');
    expect(ready.hookSecretSource).toBe('file');
    expect(lstatSync(second.service.authoritySocketPath).isSocket()).toBe(true);
  });

  it('fails closed rather than serving HTTP with no way in', async () => {
    const ns = freshNamespace();
    // A directory squatting the address is unbindable and unremovable-by-accident: the same
    // shape as a bad mount or a stray `mkdir` in the runtime root.
    mkdirSync(join(ns.runtimeRoot, SOCKET_FILENAME));

    const error = await boot(ns).then(
      () => null,
      (err) => err
    );
    expect(error, 'startService came up without an authority socket').toBeTruthy();
    expect(error.code).toBe('config_invalid');
    expect(error.message).toContain(ns.runtimeRoot);
    expect(error.detail.runtimeRoot).toBe(ns.runtimeRoot);
    expect(error.detail.cause).toBeTruthy();

    // The whole point: no listening HTTP surface is left behind.
    const transportSocket = join(ns.runtimeRoot, 'walkie.sock');
    expect(existsSync(transportSocket)).toBe(false);
    expect(existsSync(join(ns.runtimeRoot, 'walkie.pid'))).toBe(false);
  });
});

// The boot ordering above refuses to serve HTTP with no way in. That rule used to hold for the
// first instant of the process only: an authority whose listener went down afterwards left the
// service running, answering `ok`, and permanently unable to issue a first capability. These
// drive the real service and read the real `/health`.
describe('startService health reflects the authority socket', () => {
  it('degrades /health to 503 when the authority stops serving, without killing the daemon', async () => {
    const ns = freshNamespace();
    const { service } = await boot(ns);
    const socketPath = service.addresses.socket;

    const healthy = await httpRequest({ socketPath, method: 'GET', path: '/health' });
    expect(healthy.status).toBe(200);
    expect(healthy.body).toMatchObject({ ok: true, namespace: NAMESPACE });
    expect(healthy.body.authority).toBeUndefined();

    // The listener goes down under the process — not via `authority.close()`, which is an
    // orderly shutdown. This is the condition that used to be invisible.
    await new Promise((resolve) => service.authority.server.close(() => resolve(undefined)));
    expect(service.authority.status().serving).toBe(false);

    const degraded = await httpRequest({ socketPath, method: 'GET', path: '/health' });
    expect(degraded.status).toBe(503);
    expect(degraded.body).toMatchObject({ ok: false, namespace: NAMESPACE, authority: 'faulted' });

    // The daemon is alive and its HTTP surface still answers — that is what made the answer
    // above possible, and it is why a listener fault is not fatal.
    const stillThere = await httpRequest({ socketPath, method: 'GET', path: '/nope' });
    expect(stillThere.status).toBe(401);
  });

  it('records a recoverable listener fault without degrading /health', async () => {
    // EMFILE under fd pressure: Node reports it and the listener stays up. Visible in the log
    // the operator reads, and `/health` correctly still says the door is open.
    const ns = freshNamespace();
    const { service, logs } = await boot(ns);
    const before = logs.length;

    service.authority.server.emit(
      'error',
      Object.assign(new Error('accept failed'), { code: 'EMFILE' })
    );

    const faults = logs.slice(before).filter((entry) => entry.event === 'authority.socket');
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ outcome: 'faulted', reason: 'EMFILE', listening: true });

    const res = await httpRequest({
      socketPath: service.addresses.socket,
      method: 'GET',
      path: '/health'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
