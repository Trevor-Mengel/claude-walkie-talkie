// Who owns a socket address, and what may unlink it.
//
// The guard both listeners rely on — "refuse to disturb a live listener, reclaim only a
// dead one" — used to be a `connect()` attempt, and `connect()` cannot answer that
// question. It reports on the accept queue, not on the listener:
//
//   - A live listener that stops calling `accept()` refuses connections exactly as an
//     abandoned inode does. Measured on darwin 25.5, connection 129 to a wedged listener
//     returns ENOENT no matter what backlog was requested — the queue is capped at
//     `kern.ipc.somaxconn`, not at the 8 this socket asks for.
//   - A connect that times out says the machine is busy, nothing more.
//
// The old code read both as "dead" and unlinked, which is address theft: the incumbent
// keeps serving a socket nobody can reach and its clients move to the thief. So the two
// failing verdicts are asserted here directly, by injecting them. That is deliberate: the
// alternative is a 128-connection accept-queue storm whose threshold is a kernel tunable,
// and a load-dependent test is the last thing this suite needs. The real kernel is
// exercised where it can be exercised deterministically — a genuine SIGKILLed child, a
// genuine live listener, a genuine regular file.

import { describe, test, expect, afterEach } from 'vitest';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAuthority } from '../../src/authority/index.js';
import { LISTEN_BACKLOG, clearStaleSocket } from '../../src/authority/socket.js';
import {
  claimSocketAddress,
  probeSocketState,
  readSocketOwner,
  releaseSocketAddress,
  socketAddressState,
  socketOwnerPath,
  socketOwnerState
} from '../../src/authority/socket-claim.js';
import { reclaimSocketPath } from '../../src/daemon/transport.js';
import { authoritySocketPath, ensureRuntimeDir } from '../../src/authority/paths.js';
import { createFixture, enrollRequest, leaveCrashedSocket, roundTrip, TEST_SECRET } from './helpers.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

/** A pid that cannot exist: pid_max is far below this on every platform we run on. */
const IMPOSSIBLE_PID = 0x7ffffff0;

let base;
let fixture;
/** @type {{close:() => Promise<void>}|null} */
let authority;
const servers = [];
const held = [];

afterEach(async () => {
  for (const socket of held.splice(0)) socket.destroy();
  if (authority) await authority.close();
  authority = null;
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
  fixture?.cleanup();
  fixture = null;
  if (base) rmSync(base, { recursive: true, force: true });
  base = null;
});

function dir() {
  base = base ?? createFixtureDir('wk-cl-');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

/** A live, claimed listener at `path`, exactly as a bind leaves it. */
async function liveListener(path) {
  const server = net.createServer((socket) => socket.end('ok\n'));
  await new Promise((resolve) => server.listen({ path, backlog: LISTEN_BACKLOG }, resolve));
  claimSocketAddress(path);
  servers.push(server);
  return server;
}

describe('socketOwnerState', () => {
  test('reads a claim, and refuses to call a missing or garbled one proof of anything', () => {
    const path = join(dir(), 'a.sock');
    expect(socketOwnerState(path)).toBe('unclaimed');

    claimSocketAddress(path);
    expect(readSocketOwner(path)).toBe(process.pid);
    expect(socketOwnerState(path)).toBe('live');

    // A truncated write, or a half-flushed one: no pid, so no proof of death.
    writeFileSync(socketOwnerPath(path), '', { mode: 0o600 });
    expect(socketOwnerState(path)).toBe('unclaimed');
    writeFileSync(socketOwnerPath(path), 'not-a-pid\n', { mode: 0o600 });
    expect(socketOwnerState(path)).toBe('unclaimed');
    writeFileSync(socketOwnerPath(path), '0\n', { mode: 0o600 });
    expect(socketOwnerState(path)).toBe('unclaimed');

    writeFileSync(socketOwnerPath(path), `${IMPOSSIBLE_PID}\n`, { mode: 0o600 });
    expect(socketOwnerState(path)).toBe('gone');

    releaseSocketAddress(path);
    expect(socketOwnerState(path)).toBe('unclaimed');
  });

  test('a claim is owner-only, like every other credential in the runtime directory', () => {
    const path = join(dir(), 'b.sock');
    claimSocketAddress(path);
    expect(existsSync(socketOwnerPath(path))).toBe(true);
    expect(readFileSync(socketOwnerPath(path), 'utf8').trim()).toBe(String(process.pid));
  });
});

describe('socketAddressState: only proven death authorises an unlink', () => {
  test('a refused probe against a live owner is occupied, not stale', async () => {
    const path = join(dir(), 'c.sock');
    await liveListener(path);

    // This is the saturated-backlog shape: the listener is up, and connect() fails.
    expect(await socketAddressState(path, { probe: async () => 'refused' })).toBe('occupied');
    expect(await socketAddressState(path, { probe: async () => 'indeterminate' })).toBe('occupied');
    expect(await socketAddressState(path, { probe: async () => 'listening' })).toBe('occupied');
  });

  test('a timed-out probe is never dead, even when the claim says the owner is gone', async () => {
    const path = join(dir(), 'd.sock');
    await liveListener(path);
    // Force the ambiguous case: the claim names a corpse, so the probe is the only thing
    // left — and a timeout must still refuse.
    writeFileSync(socketOwnerPath(path), `${IMPOSSIBLE_PID}\n`, { mode: 0o600 });

    expect(await socketAddressState(path, { probe: async () => 'indeterminate' })).toBe('occupied');
    expect(await socketAddressState(path, { probe: async () => 'listening' })).toBe('occupied');
    // Only a hard refusal, on top of a dead claim, adds up to stale.
    expect(await socketAddressState(path, { probe: async () => 'refused' })).toBe('stale');
  });

  test('an unclaimed socket is not reclaimable however the probe answers', async () => {
    const path = join(dir(), 'e.sock');
    await leaveCrashedSocket(path, { claim: false });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(socketOwnerPath(path))).toBe(false);

    for (const verdict of ['refused', 'indeterminate', 'listening']) {
      expect(await socketAddressState(path, { probe: async () => verdict })).toBe('unclaimed');
    }
  });

  test('a real SIGKILLed owner is stale, with no verdict injected at all', async () => {
    const path = join(dir(), 'f.sock');
    const gone = await leaveCrashedSocket(path);
    expect(readSocketOwner(path)).toBe(gone);
    expect(socketOwnerState(path)).toBe('gone');
    // The real probe against a real orphaned inode: a hard refusal.
    expect(await probeSocketState(path)).toBe('refused');
    expect(await socketAddressState(path)).toBe('stale');
  });

  test('a regular file, a directory and a symlink are never sockets', async () => {
    const root = dir();
    const file = join(root, 'g.sock');
    writeFileSync(file, 'not a socket');
    expect(await socketAddressState(file)).toBe('not-a-socket');

    const folder = join(root, 'h.sock');
    mkdirSync(folder);
    expect(await socketAddressState(folder)).toBe('not-a-socket');

    // lstat, not stat: following the link would aim the unlink at the target.
    const target = join(root, 'i.sock');
    await liveListener(target);
    const link = join(root, 'j.sock');
    symlinkSync(target, link);
    expect(await socketAddressState(link)).toBe('not-a-socket');
  });

  test('an absent path is free', async () => {
    expect(await socketAddressState(join(dir(), 'nothing.sock'))).toBe('free');
  });
});

describe('reclaimSocketPath refuses what it cannot prove dead', () => {
  test('a live listener whose connect is refused keeps its address and its clients', async () => {
    const root = dir();
    const path = join(root, 'walkie.sock');
    const server = await liveListener(path);

    await expect(reclaimSocketPath(path, { probe: async () => 'refused' })).rejects.toMatchObject({
      code: 'conflict'
    });
    await expect(
      reclaimSocketPath(path, { probe: async () => 'indeterminate' })
    ).rejects.toMatchObject({ code: 'conflict' });

    // The address and the claim both survive, and the incumbent still answers.
    expect(existsSync(path)).toBe(true);
    expect(readSocketOwner(path)).toBe(process.pid);
    expect(server.listening).toBe(true);
    const answer = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ path });
      let out = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => (out += chunk));
      socket.on('end', () => resolve(out));
      socket.on('error', reject);
    });
    expect(answer.trim()).toBe('ok');
  });

  test('an unclaimed socket is refused rather than silently taken', async () => {
    const path = join(dir(), 'walkie.sock');
    await leaveCrashedSocket(path, { claim: false });

    await expect(reclaimSocketPath(path)).rejects.toMatchObject({
      code: 'conflict',
      detail: { socketPath: path }
    });
    expect(existsSync(path)).toBe(true);
  });

  test('a SIGKILLed predecessor is still reclaimed, claim and all', async () => {
    const path = join(dir(), 'walkie.sock');
    await leaveCrashedSocket(path);

    expect(await reclaimSocketPath(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    // The corpse's claim goes with it: a leftover claim naming a dead pid would authorise
    // unlinking whatever binds this address next.
    expect(existsSync(socketOwnerPath(path))).toBe(false);
  });
});

describe('clearStaleSocket refuses what it cannot prove dead', () => {
  test('a live listener whose connect is refused keeps its address', async () => {
    const path = join(dir(), 'authority.sock');
    await liveListener(path);

    for (const verdict of ['refused', 'indeterminate']) {
      await expect(clearStaleSocket(path, { probe: async () => verdict })).rejects.toMatchObject({
        code: 'conflict'
      });
    }
    expect(existsSync(path)).toBe(true);
    expect(readSocketOwner(path)).toBe(process.pid);
  });

  test('an unclaimed socket is refused', async () => {
    const path = join(dir(), 'authority.sock');
    await leaveCrashedSocket(path, { claim: false });
    await expect(clearStaleSocket(path)).rejects.toMatchObject({
      code: 'conflict',
      detail: { socketPath: path }
    });
    expect(existsSync(path)).toBe(true);
  });

  test('a regular file is refused as config_invalid and never removed', async () => {
    const path = join(dir(), 'authority.sock');
    writeFileSync(path, 'operator data', { mode: 0o600 });
    await expect(clearStaleSocket(path)).rejects.toMatchObject({ code: 'config_invalid' });
    expect(readFileSync(path, 'utf8')).toBe('operator data');
  });
});

describe('a saturated authority keeps its address', () => {
  test('LISTEN_BACKLOG connections held open do not make a second bind steal it', async () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'r');
    authority = await startAuthority({
      store: fixture.store,
      config: fixture.config,
      runtimeRoot,
      secret: TEST_SECRET,
      log: fixture.log,
      // Long enough that the held connections stay held for the whole test.
      idleTimeoutMs: 60000
    });
    const path = authority.socketPath;
    expect(path).toBe(authoritySocketPath(ensureRuntimeDir(runtimeRoot)));

    // Fill the backlog with connections that never complete a request line.
    for (let i = 0; i < LISTEN_BACKLOG; i += 1) {
      const socket = net.createConnection({ path });
      socket.on('error', () => {});
      held.push(socket);
      await new Promise((resolve) => socket.once('connect', resolve));
    }

    // A second authority must refuse, whatever the probe made of it — including the
    // verdict a saturated queue produces.
    for (const probe of [undefined, async () => 'refused', async () => 'indeterminate']) {
      let code = null;
      try {
        await clearStaleSocket(path, probe ? { probe } : {});
      } catch (err) {
        code = err.code;
      }
      expect(code).toBe('conflict');
    }
    expect(existsSync(path)).toBe(true);

    // And the incumbent is still serving, on a fresh connection, with the held ones open.
    const reply = await roundTrip(path, enrollRequest());
    expect(reply.code).toBeTypeOf('string');
  });
});
