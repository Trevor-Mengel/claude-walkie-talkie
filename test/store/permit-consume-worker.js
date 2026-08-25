// Spawned by permit-race.test.js. Attempts to consume ONE shared permit and
// exits with a status that encodes the outcome:
//   0 -> won the race (permit consumed)
//   3 -> permit_invalid (lost the race, or the permit was already burnt)
//   1 -> anything else (a bug: SQLITE_BUSY, wrong error code, throw)
//
// The rendezvous is a two-phase handshake, not a guessed wall-clock deadline.
// v0.3 spawned every worker with a fixed `startAt = Date.now() + 1200` and let a
// worker that booted after that instant skip the barrier entirely: under load,
// spawning ten node processes can outrun 1200ms, every worker fires on arrival,
// and the ten consumes SERIALIZE. All the parent's assertions still hold under
// full serialization, so the test passed while proving nothing about
// concurrency — the single property it exists for. Now the worker announces
// READY once SQLite is open, blocks on stdin, and the parent releases all ten at
// one absolute instant it picks after the last READY. The pre-transaction
// timestamp is reported so the parent can FAIL when the rendezvous is missed.
import { createInterface } from 'node:readline';
import { openStore } from '../../src/store/db.js';
import { consumePermit } from '../../src/store/permits.js';

const [
  ,
  ,
  dbPath,
  namespace,
  permitId,
  principalId,
  operation,
  resourceId,
  digestHex,
  idx
] = process.argv;

const WON = 0;
const LOST = 3;
const BUG = 1;

/** Resolves with the absolute ms instant the parent wants every worker to fire at. */
function awaitGoSignal() {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin });
    // `readline.close()` emits 'close' SYNCHRONOUSLY, so the promise must be
    // settled before the interface is torn down or the EOF path wins the race
    // against the line we just read.
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    lines.once('line', (line) => {
      const target = Number(line.trim());
      if (Number.isFinite(target)) settle(resolve, target);
      else settle(reject, new Error(`bad go signal ${JSON.stringify(line)}`));
      lines.close();
    });
    lines.once('close', () => settle(reject, new Error('stdin closed before the go signal')));
  });
}

async function main() {
  const store = openStore({ path: dbPath, namespace });
  const args = {
    permitId,
    namespace,
    principalId,
    operation,
    resourceId,
    contentDigest: Buffer.from(digestHex, 'hex'),
    consumedRef: `worker-${idx}`
  };
  // The reader attaches BEFORE READY so the pistol cannot arrive on a stdin
  // nobody is listening to.
  const go = awaitGoSignal();
  // Phase 1: booted, SQLite open, nothing left to do but the UPDATE.
  process.stdout.write('READY\n');
  // Phase 2: every worker spins to the same absolute instant, so the UPDATEs
  // genuinely collide instead of queueing behind each other's process startup.
  const target = await go;
  while (Date.now() < target) {
    // tight spin: the last few ms, with no scheduler hand-off to lose
  }

  // Reported so the parent can prove the rendezvous held. A worker that never
  // waited shows up here as an outlier and fails the test.
  process.stderr.write(`AT ${idx} ${Date.now()}\n`);

  try {
    store.tx((tx) => consumePermit(tx, args));
    store.close();
    return WON;
  } catch (err) {
    store.close();
    if (err && err.code === 'permit_invalid') return LOST;
    process.stderr.write(`worker-${idx} unexpected: ${err && err.code} ${err && err.message}\n`);
    return BUG;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`worker-${idx} fatal: ${err && err.message}\n`);
    process.exit(BUG);
  }
);
