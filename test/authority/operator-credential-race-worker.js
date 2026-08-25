// Spawned by operator-credential.test.js. One process trying to mint the operator credential
// for a namespace that has none, released at the same instant as its siblings.
//
// It prints its outcome on stdout — `SOURCE created|file <capabilityId>` — and exits 0, or exits
// 3 on a refusal. The rendezvous is the two-phase handshake `permit-consume-worker.js`
// established: announce READY once SQLite is open, block on stdin, and let the parent fire the
// pistol once every sibling is booted. A guessed wall-clock deadline degrades silently into
// serialized calls, and serialized calls satisfy every assertion the parent makes while proving
// nothing about the property under test.

import { createInterface } from 'node:readline';
import { openStore } from '../../src/store/db.js';
import { ensureOperatorCredential } from '../../src/authority/operator-credential.js';

const [, , dbPath, namespace, runtimeRoot] = process.argv;

function awaitGoSignal() {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin });
    let received = false;
    lines.on('line', (line) => {
      received = true;
      lines.close();
      const at = Number(line.trim());
      if (Number.isFinite(at)) resolve(at);
      else reject(new Error(`unusable go signal: ${line}`));
    });
    // `close` also fires as a consequence of the line above, so it only means failure when no
    // line ever arrived.
    lines.on('close', () => {
      if (!received) reject(new Error('stdin closed before the go signal'));
    });
  });
}

const store = openStore({ path: dbPath, namespace });
process.stdout.write('READY\n');

const at = await awaitGoSignal();
while (Date.now() < at) {
  // Spin, deliberately: setTimeout would land these calls tens of milliseconds apart.
}

try {
  const result = ensureOperatorCredential({
    store,
    runtimeRoot,
    onReport: (msg) => process.stderr.write(`REPORT ${msg}\n`)
  });
  process.stdout.write(`SOURCE ${result.source} ${result.capabilityId}\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`REFUSED ${err?.code ?? 'unknown'}\n`);
  process.exit(3);
}
