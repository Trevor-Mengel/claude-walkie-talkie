/**
 * Fixtures for the authority slice.
 *
 * Every fixture lives in its own `mkdtemp` directory with a deliberately short prefix:
 * an AF_UNIX address is capped near 104 bytes, and `/private/var/folders/...` already
 * eats 68 of them on macOS, so a chatty prefix is the difference between a bound socket
 * and ENAMETOOLONG.
 *
 * Not a `*.test.js` file, so vitest treats it as a plain module.
 */

import net from 'node:net';
import { spawn } from 'node:child_process';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../../src/store/db.js';
import { listAudit } from '../../src/store/audit.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

export const NAMESPACE = 'collabcast';

/** A usable hook secret: same shape as a real one, fixed so tests can grep for it. */
export const TEST_SECRET = 'test-hook-secret-000000000000000000000000000';

/**
 * @param {{namespace?:string}} [opts]
 * @returns {{root:string, path:string, namespace:string, store:object,
 *            config:{namespace:string, mode:string}, logs:object[],
 *            log:(entry:object) => void, cleanup:() => void}}
 */
export function createFixture({ namespace = NAMESPACE } = {}) {
  // 'wk-' keeps the socket path inside the AF_UNIX budget.
  const root = createFixtureDir('wk-');
  const path = join(root, 'db');
  const store = openStore({ path, namespace });
  /** @type {object[]} */
  const logs = [];
  return {
    root,
    path,
    namespace,
    store,
    config: { namespace, mode: 'managed' },
    logs,
    log: (entry) => logs.push(entry),
    cleanup() {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** A well-formed enrollment request; override any field to make it malformed. */
export function enrollRequest(overrides = {}) {
  return {
    op: 'enroll.request',
    namespace: NAMESPACE,
    role: 'root',
    scopes: ['channel:read', 'channel:publish', 'self:alias'],
    ttlSeconds: 3600,
    hookSecret: TEST_SECRET,
    ...overrides
  };
}

/**
 * One NDJSON round trip against a real socket, exactly as omp-extension/authority.js
 * does it: connect, write one line, read one line, close.
 *
 * @param {string} socketPath
 * @param {unknown|string} payload a string is written verbatim (no newline added)
 * @param {{timeoutMs?:number, raw?:boolean}} [opts] raw returns the response line
 *   verbatim, so two replies can be compared byte for byte
 * @returns {Promise<object|string|null>} null when the peer closed without replying
 */
export function roundTrip(socketPath, payload, { timeoutMs = 4000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = '';
    let settled = false;
    const settle = (value, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => settle(null, new Error('round trip timed out')), timeoutMs);

    socket.setEncoding('utf8');
    socket.on('error', (err) => settle(null, err));
    socket.on('connect', () => {
      socket.write(typeof payload === 'string' ? payload : `${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      if (raw) {
        settle(line, null);
        return;
      }
      try {
        settle(JSON.parse(line), null);
      } catch (err) {
        settle(null, err);
      }
    });
    socket.on('close', () => settle(null, null));
  });
}

/**
 * Leaves the socket a SIGKILLed authority leaves: an orphaned AF_UNIX inode at `path`
 * plus the owner claim the bind wrote beside it.
 *
 * It has to be a real child. A `net.Server` unlinks its own address on `close()`, so no
 * in-process shutdown produces an orphaned inode, and a claim naming *this* process is a
 * live owner — the one thing that must never be reclaimed. The child calls the
 * production `claimSocketAddress`, so this fixture cannot drift from what a real bind
 * writes.
 *
 * @param {string} path
 * @param {{claim?:boolean}} [opts] `claim: false` leaves a socket with no provenance:
 *   nothing proves its owner dead, so it must be refused rather than reclaimed.
 * @returns {Promise<number>} the pid that is now gone
 */
export async function leaveCrashedSocket(path, { claim = true } = {}) {
  const claimModule = new URL('../../src/authority/socket-claim.js', import.meta.url).href;
  const source =
    "import net from 'node:net';" +
    `const mod = ${claim} ? await import(${JSON.stringify(claimModule)}) : null;` +
    'const s = net.createServer();' +
    's.listen(process.argv[1], () => {' +
    '  if (mod) mod.claimSocketAddress(process.argv[1]);' +
    "  process.stdout.write('up');" +
    '});';
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, path], {
    stdio: ['ignore', 'pipe', 'ignore']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('crashed-socket child never bound')), 5000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve(undefined);
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

/** Every audit row in the store, newest last. */
export function auditRows(store) {
  return listAudit(store, { limit: 500 }).slice().reverse();
}

/** `count(*)` for a table, so a test can assert "nothing was created". */
export function countRows(store, table) {
  return store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

/** Octal permission string, e.g. '600'. */
export function modeOf(path) {
  return (statSync(path).mode & 0o777).toString(8);
}
