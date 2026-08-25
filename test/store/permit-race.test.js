import { describe, test, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../src/store/db.js';
import { grantPermit, getPermit, listPermits } from '../../src/store/permits.js';
import { sha256 } from '../../src/store/digest.js';
import { createTmpStore, cleanupTmpStore, seedActors } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER = join(__dirname, 'permit-consume-worker.js');

const WORKERS = 10;

/**
 * How long after the last worker reports READY the parent fires the pistol.
 * Every worker is already booted with SQLite open by then, so this only has to
 * absorb the time to wake ten blocked processes — not `spawn` latency, the way
 * v0.3's guessed `Date.now() + 1200` did.
 *
 * Tuning this is safe in a way tuning v0.3's deadline was not, and that is the
 * whole point of the rewrite: there, a runway that ran out degraded SILENTLY to
 * ten serialized consumes that every assertion still accepted. Here a runway
 * that runs out FAILS, loudly, on the spread assertion below. So the runway is
 * sized generously and the property is proved rather than assumed. Measured
 * worst case for waking ten workers with five suites running concurrently on
 * this machine: 94ms.
 */
const LEAD_MS = 750;

/**
 * Ten processes spinning to one absolute instant converge to 0ms of spread when
 * the runway holds — that is the measured value, not a hopeful bound. A missed
 * rendezvous lands 270ms+ out (verified by staggering the workers on purpose),
 * so this sits an order of magnitude clear of both.
 */
const TOLERANCE_MS = 50;

/**
 * Spawns a worker and exposes its two lifecycle points: `ready` (booted, SQLite
 * open, blocked on the pistol) and `done` (exited).
 */
function spawnWorker(argv, idx) {
  const child = spawn(process.execPath, [WORKER, ...argv, String(idx)], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const ready = new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('READY')) resolve(idx);
    });
    child.once('exit', (code) =>
      reject(new Error(`worker ${idx} exited (${code}) before READY: ${stderr.trim()}`))
    );
  });
  const done = new Promise((resolve) => {
    child.once('exit', (code) => resolve({ idx, code, stderr }));
  });
  return { idx, child, ready, done };
}

/** The pre-transaction instant a worker reported, or null when it reported none. */
function firedAt(stderr) {
  const match = /^AT \d+ (\d+)$/m.exec(stderr);
  return match ? Number(match[1]) : null;
}

let fixture;
afterEach(() => {
  cleanupTmpStore(fixture);
  fixture = null;
});

describe('one-use permit under real process concurrency', () => {
  test(`${WORKERS} racing processes: exactly one consumes, the rest get permit_invalid`, async () => {
    fixture = createTmpStore();
    const { hub, approval } = seedActors(fixture.store);
    const digest = sha256('prune-plan');
    const permit = grantPermit(fixture.store, {
      principalId: hub.id,
      operation: 'retention.prune',
      resourceId: 'thread-race',
      contentDigest: digest,
      approvalId: approval.id,
      ttlSeconds: 120
    });
    // Release our connection so the children are the only writers.
    fixture.store.close();

    const argv = [
      fixture.path,
      fixture.namespace,
      permit.id,
      hub.id,
      'retention.prune',
      'thread-race',
      digest.toString('hex')
    ];

    const workers = Array.from({ length: WORKERS }, (_, i) => spawnWorker(argv, i));
    // Phase 1: wait for all ten to boot and open SQLite. Nothing races yet.
    await Promise.all(workers.map((w) => w.ready));
    // Phase 2: fire the pistol. One absolute instant, sent to all ten stdins.
    const target = Date.now() + LEAD_MS;
    for (const w of workers) w.child.stdin.write(`${target}\n`);
    const results = await Promise.all(workers.map((w) => w.done));

    const bugs = results.filter((r) => r.code !== 0 && r.code !== 3);
    expect(bugs.map((b) => `${b.idx}:${b.code}:${b.stderr.trim()}`)).toEqual([]);

    // The load-bearing assertion, and the reason this test exists: the ten
    // UPDATEs actually overlapped. Everything below still holds when the
    // consumes serialize one-by-one, so without this the test proves only that
    // a permit is single-use, not that it is single-use UNDER CONTENTION.
    const fired = results.map((r) => ({ idx: r.idx, at: firedAt(r.stderr) }));
    expect(
      fired.filter((f) => f.at === null).map((f) => f.idx),
      'workers that reported no pre-transaction instant'
    ).toEqual([]);
    const instants = fired.map((f) => f.at);
    expect(
      fired.filter((f) => f.at < target),
      'a worker jumped the rendezvous and fired before the pistol'
    ).toEqual([]);
    const slowest = Math.max(...instants) - target;
    const spread = Math.max(...instants) - Math.min(...instants);
    expect(
      slowest,
      `slowest worker fired ${slowest}ms after the pistol (spread ${spread}ms across ${WORKERS}): ` +
        'the rendezvous was missed, so these consumes did not contend'
    ).toBeLessThanOrEqual(TOLERANCE_MS);

    const winners = results.filter((r) => r.code === 0);
    const losers = results.filter((r) => r.code === 3);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(WORKERS - 1);

    // Reopen and confirm the durable record agrees with exactly one winner.
    const reopened = openStore({ path: fixture.path, namespace: fixture.namespace });
    fixture.store = reopened;
    const stored = getPermit(reopened, permit.id);
    expect(stored.state).toBe('consumed');
    expect(stored.consumedRef).toBe(`worker-${winners[0].idx}`);
    expect(stored.consumedAt).toBeTruthy();
    expect(listPermits(reopened, { state: 'granted' })).toEqual([]);
  }, 60000);
});
