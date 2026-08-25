import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { isolatedEnv } from '../helpers/isolation.js';
import { MAX_SOCKET_PATH_BYTES } from '../../src/authority/paths.js';
import { DEFAULT_CONFIG, SOCKET_DIR_MODE } from '../../src/config/schema.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';
import {
  PID_FILENAME,
  SOCKET_FILE_MODE,
  COLLABCAST_SOCKET_FILENAME,
  assertBindableSocketPath,
  ensureSocketDir,
  listen,
  probeSocket,
  reclaimSocketPath,
  resolveTransportPaths
} from '../../src/daemon/transport.js';

// Short on purpose: an AF_UNIX path is capped near 104 bytes, so tests bind inside a shallow
// mkdtemp rather than under a deep project root.
let base;
let runtimeRoot;
const openListeners = [];

function transportConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    transport: {
      ...DEFAULT_CONFIG.transport,
      ...overrides,
      tcp: { ...DEFAULT_CONFIG.transport.tcp, ...(overrides.tcp ?? {}) }
    }
  };
}

function tinyApp() {
  const app = express();
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

async function startListener(app, opts) {
  const listener = await listen(app, { runtimeRoot, ...opts });
  openListeners.push(listener);
  return listener;
}

beforeEach(() => {
  base = createFixtureDir('wk-tp-');
  runtimeRoot = join(base, 'run');
});

afterEach(async () => {
  while (openListeners.length > 0) {
    await openListeners.pop().close();
  }
  rmSync(base, { recursive: true, force: true });
});

describe('resolveTransportPaths', () => {
  it('puts both sockets and the pid file in one runtime directory', () => {
    const paths = resolveTransportPaths({ runtimeRoot });
    expect(paths.runtimeRoot).toBe(runtimeRoot);
    expect(paths.socketPath).toBe(join(runtimeRoot, COLLABCAST_SOCKET_FILENAME));
    expect(paths.authoritySocketPath).toBe(join(runtimeRoot, 'authority.sock'));
    expect(paths.pidPath).toBe(join(runtimeRoot, PID_FILENAME));
  });

  it('derives the runtime directory from the project root when none is given', () => {
    const paths = resolveTransportPaths({ canonicalRoot: base, env: {} });
    expect(paths.runtimeRoot).toBe(join(base, '.collabcast', 'run'));
  });

  it('prefers an explicit config.transport.socketPath over the default filename', () => {
    const custom = join(runtimeRoot, 'custom.sock');
    const paths = resolveTransportPaths({
      runtimeRoot,
      config: transportConfig({ socketPath: custom })
    });
    expect(paths.socketPath).toBe(custom);
    // The authority socket is unaffected: only the HTTP transport is relocatable.
    expect(paths.authoritySocketPath).toBe(join(runtimeRoot, 'authority.sock'));
  });
});

describe('socket path guards', () => {
  it('rejects a path the kernel could not bind', () => {
    const tooLong = join(base, 'x'.repeat(MAX_SOCKET_PATH_BYTES + 1));
    expect(() => assertBindableSocketPath(tooLong)).toThrowError(/too long/);
    expect(() => assertBindableSocketPath(join(runtimeRoot, COLLABCAST_SOCKET_FILENAME))).not.toThrow();
  });

  it('creates the parent directory owner-only', () => {
    const dir = ensureSocketDir(join(runtimeRoot, COLLABCAST_SOCKET_FILENAME));
    expect(dir).toBe(runtimeRoot);
    expect(statSync(runtimeRoot).mode & 0o777).toBe(SOCKET_DIR_MODE);
  });

  it('re-tightens a runtime directory that was loosened out of band', () => {
    mkdirSync(runtimeRoot, { recursive: true });
    chmodSync(runtimeRoot, 0o755);
    ensureSocketDir(join(runtimeRoot, COLLABCAST_SOCKET_FILENAME));
    expect(statSync(runtimeRoot).mode & 0o777).toBe(SOCKET_DIR_MODE);
  });
});

describe('stale socket reclamation', () => {
  it('reports no listener for an absent path and does not create one', async () => {
    const path = join(runtimeRoot, COLLABCAST_SOCKET_FILENAME);
    expect(await probeSocket(path)).toBe(false);
    expect(await reclaimSocketPath(path)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it('reclaims a socket file with no listener behind it', async () => {
    mkdirSync(runtimeRoot, { recursive: true, mode: SOCKET_DIR_MODE });
    const path = join(runtimeRoot, COLLABCAST_SOCKET_FILENAME);

    await leaveStaleSocket(path);
    expect(existsSync(path)).toBe(true);
    expect(await probeSocket(path)).toBe(false);

    expect(await reclaimSocketPath(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to unlink a socket with a LIVE listener', async () => {
    mkdirSync(runtimeRoot, { recursive: true, mode: SOCKET_DIR_MODE });
    const path = join(runtimeRoot, COLLABCAST_SOCKET_FILENAME);
    const server = createNetServer((socket) => socket.end());
    await new Promise((resolve) => server.listen(path, resolve));
    try {
      expect(await probeSocket(path)).toBe(true);
      await expect(reclaimSocketPath(path)).rejects.toMatchObject({ code: 'conflict' });
      // The incumbent's socket is still there: reclaim must never disconnect a live service.
      expect(existsSync(path)).toBe(true);
      expect(await probeSocket(path)).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('never removes a non-socket occupying the path', async () => {
    mkdirSync(runtimeRoot, { recursive: true, mode: SOCKET_DIR_MODE });
    const path = join(runtimeRoot, COLLABCAST_SOCKET_FILENAME);
    writeFileSync(path, 'not a socket');
    await expect(reclaimSocketPath(path)).rejects.toMatchObject({ code: 'conflict' });
    expect(existsSync(path)).toBe(true);
  });
});

describe('listen: unix socket', () => {
  it('binds the socket at 0600 inside a 0700 directory and serves requests', async () => {
    const listener = await startListener(tinyApp(), { config: transportConfig() });
    const socketPath = join(runtimeRoot, COLLABCAST_SOCKET_FILENAME);

    expect(listener.addresses.socket).toBe(socketPath);
    expect(listener.addresses.tcp).toBeNull();
    expect(statSync(socketPath).mode & 0o777).toBe(SOCKET_FILE_MODE);
    expect(statSync(runtimeRoot).mode & 0o777).toBe(SOCKET_DIR_MODE);

    const body = await getOverSocket(socketPath, '/ping');
    expect(body).toEqual({ ok: true });
  });

  it('unlinks the socket on graceful shutdown', async () => {
    const listener = await startListener(tinyApp(), { config: transportConfig() });
    const socketPath = listener.addresses.socket;
    expect(existsSync(socketPath)).toBe(true);
    await listener.close();
    expect(existsSync(socketPath)).toBe(false);
  });

  it('close() is idempotent', async () => {
    const listener = await startListener(tinyApp(), { config: transportConfig() });
    await listener.close();
    await expect(listener.close()).resolves.toBeUndefined();
  });

  it('reclaims a stale socket left by a crashed predecessor', async () => {
    mkdirSync(runtimeRoot, { recursive: true, mode: SOCKET_DIR_MODE });
    const socketPath = join(runtimeRoot, COLLABCAST_SOCKET_FILENAME);
    await leaveStaleSocket(socketPath);
    expect(existsSync(socketPath)).toBe(true);

    const listener = await startListener(tinyApp(), { config: transportConfig() });
    expect(listener.addresses.socket).toBe(socketPath);
    expect(await getOverSocket(socketPath, '/ping')).toEqual({ ok: true });
  });

  it('refuses to start beside a live listener on the same path', async () => {
    await startListener(tinyApp(), { config: transportConfig() });
    await expect(
      listen(tinyApp(), { runtimeRoot, config: transportConfig() })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('honours a configured socketPath', async () => {
    const custom = join(runtimeRoot, 'alt.sock');
    const listener = await startListener(tinyApp(), {
      config: transportConfig({ socketPath: custom })
    });
    expect(listener.addresses.socket).toBe(custom);
    expect(statSync(custom).mode & 0o777).toBe(SOCKET_FILE_MODE);
  });

  it('refuses a config with no transport at all', async () => {
    await expect(
      listen(tinyApp(), {
        runtimeRoot,
        config: transportConfig({ unixSocket: false, tcp: { enabled: false } })
      })
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });
});

describe('listen: loopback tcp', () => {
  it('does not bind tcp unless it is enabled', async () => {
    const listener = await startListener(tinyApp(), { config: transportConfig() });
    expect(listener.addresses.tcp).toBeNull();
  });

  // The regression test for the top S0 finding: v0.2 called `app.listen(0)` with no host, so the
  // live daemon was observed listening on *:54030 — reachable from the LAN, unauthenticated.
  it('binds EXACTLY 127.0.0.1, never a wildcard address', async () => {
    const listener = await startListener(tinyApp(), {
      config: transportConfig({ tcp: { enabled: true, host: '127.0.0.1', port: 0 } })
    });
    const { tcp } = listener.addresses;
    expect(tcp).not.toBeNull();
    expect(tcp.host).toBe('127.0.0.1');
    expect(tcp.host).not.toBe('0.0.0.0');
    expect(tcp.host).not.toBe('::');
    expect(tcp.port).toBeGreaterThan(0);

    const body = await getOverTcp(tcp.host, tcp.port, '/ping');
    expect(body).toEqual({ ok: true });
  });

  it('binds the IPv6 loopback literal when configured', async () => {
    const listener = await startListener(tinyApp(), {
      config: transportConfig({ tcp: { enabled: true, host: '::1', port: 0 } })
    });
    expect(listener.addresses.tcp.host).toBe('::1');
  });

  it('serves the socket and tcp from the same application', async () => {
    const listener = await startListener(tinyApp(), {
      config: transportConfig({ tcp: { enabled: true, host: '127.0.0.1', port: 0 } })
    });
    expect(await getOverSocket(listener.addresses.socket, '/ping')).toEqual({ ok: true });
    expect(
      await getOverTcp(listener.addresses.tcp.host, listener.addresses.tcp.port, '/ping')
    ).toEqual({ ok: true });
  });

  it('refuses a non-loopback host even when the config object is hand-built', async () => {
    await expect(
      listen(tinyApp(), {
        runtimeRoot,
        config: transportConfig({
          unixSocket: false,
          tcp: { enabled: true, host: '0.0.0.0', port: 0 }
        })
      })
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('refuses an empty host rather than falling back to every interface', async () => {
    await expect(
      listen(tinyApp(), {
        runtimeRoot,
        config: transportConfig({ unixSocket: false, tcp: { enabled: true, host: '', port: 0 } })
      })
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('refuses a non-integer port', async () => {
    await expect(
      listen(tinyApp(), {
        runtimeRoot,
        config: transportConfig({
          unixSocket: false,
          tcp: { enabled: true, host: '127.0.0.1', port: 70000 }
        })
      })
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('does not leave the unix socket bound when the tcp bind fails', async () => {
    await expect(
      listen(tinyApp(), {
        runtimeRoot,
        config: transportConfig({ tcp: { enabled: true, host: '0.0.0.0', port: 0 } })
      })
    ).rejects.toMatchObject({ code: 'config_invalid' });
    expect(existsSync(join(runtimeRoot, COLLABCAST_SOCKET_FILENAME))).toBe(false);
  });
});

/**
 * Leaves a real, orphaned socket inode at `path`, with the owner claim a crashed collabcast
 * process would have left beside it.
 *
 * A Node `net.Server` unlinks its own socket file on `close()`, so a clean shutdown cannot
 * produce the case we care about. The only faithful way to make a stale socket is to bind it in
 * a child and SIGKILL that child, which is exactly what a crashed daemon leaves behind — the
 * socket, and the claim it wrote when it took the address. The child calls the production
 * `claimSocketAddress` rather than hand-rolling the file, so this fixture cannot drift from
 * what a real bind writes.
 *
 * @param {string} path
 * @param {{claim?:boolean}} [opts] `claim: false` reproduces a socket with no provenance at
 *   all — an older build, or a foreign process — which is refused rather than reclaimed.
 */
async function leaveStaleSocket(path, { claim = true } = {}) {
  const claimModule = new URL('../../src/authority/socket-claim.js', import.meta.url).href;
  const source =
    "import net from 'node:net';" +
    `const claim = ${claim};` +
    `const mod = claim ? await import(${JSON.stringify(claimModule)}) : null;` +
    'const s = net.createServer();' +
    's.listen(process.argv[1], () => {' +
    '  if (mod) mod.claimSocketAddress(process.argv[1]);' +
    "  process.stdout.write('up');" +
    '});';
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, path], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: isolatedEnv()
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stale-socket child never bound')), 5000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  return child.pid;
}

/** @returns {Promise<object>} */
async function getOverSocket(socketPath, path) {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** @returns {Promise<object>} */
async function getOverTcp(host, port, path) {
  const { request } = await import('node:http');
  const hostHeader = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method: 'GET', headers: { Host: hostHeader } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
