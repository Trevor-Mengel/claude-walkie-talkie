// The operator credential writer, at the unit level.
//
// `test/e2e/fresh-install.test.js` proves the shipped behaviour through the real CLI, which is
// the only test that could have caught the defect this module fixes. This file covers the cases
// that are awkward to reach through a subprocess: the exact shape of the capability that gets
// issued, the two-channel split every refusal must honour, and the publish race.
//
// The rule the whole file pins: an operator-facing report may name the file, and the
// `CollabcastError` envelope may not. `secret.test.js` pins the same boundary for `hook.secret`;
// asserting only one half would let a later change move a runtime path into a structure that
// travels into peers, wire replies and audit rows.

import { afterEach, describe, expect, test } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_ATTESTATION_KIND,
  OPERATOR_ATTESTATION_REF,
  OPERATOR_CREDENTIAL_TTL_SECONDS,
  OPERATOR_ROLE,
  ensureOperatorCredential
} from '../../src/authority/operator-credential.js';
import { operatorCredentialPath } from '../../src/authority/paths.js';
import { ROLE_SCOPES } from '../../src/authority/policy.js';
import { SCOPES, getCapability, revokeCapability, verifyCapability } from '../../src/store/capabilities.js';
import { listPrincipals, revokePrincipal } from '../../src/store/principals.js';
import { MAX_TTL_SECONDS } from '../../src/store/clock.js';
import { auditRows, createFixture, modeOf } from './helpers.js';

let fixture;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

/** A fixture plus an empty, 0700 runtime directory. */
function setup() {
  fixture = createFixture();
  const runtimeRoot = join(fixture.root, 'r');
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  return { store: fixture.store, runtimeRoot, path: operatorCredentialPath(runtimeRoot) };
}

/** Run the writer, collecting the operator-facing channel instead of writing to stderr. */
function ensure({ store, runtimeRoot, path }) {
  /** @type {string[]} */
  const reports = [];
  let result;
  let err;
  try {
    result = ensureOperatorCredential({
      store,
      runtimeRoot,
      path,
      onReport: (msg) => reports.push(msg)
    });
  } catch (caught) {
    err = caught;
  }
  return { result, err, reports };
}

const RACE_WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  'operator-credential-race-worker.js'
);

/** How many services race for one cold namespace. */
const RACERS = 6;

/**
 * How long after the last racer reports READY the parent fires the pistol. Sized to absorb
 * waking six blocked processes, not to absorb `spawn` latency — the READY handshake already
 * covers that, which is why a runway that runs out fails loudly instead of degrading into
 * serialized calls.
 */
const LEAD_MS = 750;

/** Spawns one racer and exposes its `ready` (SQLite open, blocked) and `done` points. */
function spawnRacer(argv, idx) {
  const child = spawn(process.execPath, [RACE_WORKER, ...argv], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('READY')) resolve(idx);
    });
    child.once('exit', (code) =>
      reject(new Error(`racer ${idx} exited (${code}) before READY: ${stderr.trim()}`))
    );
  });
  const done = new Promise((resolve) => {
    child.once('exit', (code) => {
      const match = /^SOURCE (created|file) (\S+)$/m.exec(stdout);
      resolve({
        idx,
        code,
        source: match?.[1] ?? null,
        capability: match?.[2] ?? null,
        stderr: stderr.trim()
      });
    });
  });
  return { idx, child, ready, done };
}

describe('minting', () => {
  test('creates an owner-only credential that resolves to an operator capability', () => {
    const { store, runtimeRoot, path } = setup();
    const { result, err, reports } = ensure({ store, runtimeRoot });

    expect(err).toBeUndefined();
    expect(reports).toEqual([]);
    expect(result.path).toBe(path);
    expect(result.source).toBe('created');
    expect(modeOf(path)).toBe('600');

    const token = readFileSync(path, 'utf8').trim();
    const verified = verifyCapability(store, token);
    expect(verified).not.toBeNull();
    expect(verified.principal.role).toBe(OPERATOR_ROLE);
    expect(verified.capability.id).toBe(result.capabilityId);
    expect(verified.principal.id).toBe(result.principalId);
  });

  test('the returned handle carries the path and never the token', () => {
    // The composition root binds this result into a log line and a service handle. A token in
    // either would be published to every supervisor tailing the service's stdout.
    const { store, runtimeRoot, path } = setup();
    const { result } = ensure({ store, runtimeRoot });
    const token = readFileSync(path, 'utf8').trim();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(Object.keys(result).sort()).toEqual(['capabilityId', 'path', 'principalId', 'source']);
  });

  test('holds the whole operator scope set, which is what makes break-glass delegation work', () => {
    const { store, runtimeRoot } = setup();
    const { result } = ensure({ store, runtimeRoot });
    const capability = getCapability(store, result.capabilityId);

    // Every scope: `issueCapability` refuses a child scope the parent does not hold, so an
    // operator missing `listener:consume` could not mint a working listener with
    // `enroll --recovery`.
    expect(capability.scopes).toEqual([...SCOPES].sort());
    expect([...ROLE_SCOPES[OPERATOR_ROLE]].sort()).toEqual([...SCOPES].sort());
    expect(capability.scopes).toContain('enroll:delegate');
  });

  test('is an ordinary revocable capability with the operator-CLI attestation on it', () => {
    const { store, runtimeRoot } = setup();
    const { result } = ensure({ store, runtimeRoot });
    const capability = getCapability(store, result.capabilityId);

    expect(capability.attestationKind).toBe(OPERATOR_ATTESTATION_KIND);
    expect(capability.attestationRef).toBe(OPERATOR_ATTESTATION_REF);
    // Not derived from anything: it is the root of the manual path, not a delegation.
    expect(capability.parentCapabilityId).toBeNull();
    expect(capability.revokedAt).toBeNull();
  });

  test('is long-lived by design, and bounded by the store ceiling', () => {
    expect(OPERATOR_CREDENTIAL_TTL_SECONDS).toBe(MAX_TTL_SECONDS);
    const { store, runtimeRoot } = setup();
    const { result } = ensure({ store, runtimeRoot });
    const capability = getCapability(store, result.capabilityId);
    const lifetime = Date.parse(capability.expiresAt) - Date.parse(capability.issuedAt);
    expect(Math.round(lifetime / 1000)).toBe(MAX_TTL_SECONDS);
  });

  test('records the mint in the audit trail without the token in it', () => {
    const { store, runtimeRoot, path } = setup();
    const { result } = ensure({ store, runtimeRoot });
    const token = readFileSync(path, 'utf8').trim();

    const row = auditRows(store).find((r) => r.action === 'operator.credential.minted');
    expect(row).toBeDefined();
    expect(row.subject).toBe(result.capabilityId);
    expect(row.outcome).toBe('issued');
    expect(JSON.stringify(row)).not.toContain(token);
  });

  test('creates the runtime directory at 0700 when it does not exist yet', () => {
    fixture = createFixture();
    const runtimeRoot = join(fixture.root, 'fresh');
    expect(existsSync(runtimeRoot)).toBe(false);

    const { err } = ensure({ store: fixture.store, runtimeRoot });
    expect(err).toBeUndefined();
    expect(modeOf(runtimeRoot)).toBe('700');
    expect(modeOf(operatorCredentialPath(runtimeRoot))).toBe('600');
  });

  test('leaves no staging file behind', () => {
    const { store, runtimeRoot } = setup();
    ensure({ store, runtimeRoot });
    expect(readdirSync(runtimeRoot).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });
});

describe('idempotence', () => {
  test('a second call leaves a valid credential byte-identical', () => {
    const { store, runtimeRoot, path } = setup();
    const first = ensure({ store, runtimeRoot });
    const before = readFileSync(path, 'utf8');

    const second = ensure({ store, runtimeRoot });
    expect(second.err).toBeUndefined();
    expect(second.reports).toEqual([]);
    expect(second.result.source).toBe('file');
    expect(second.result.capabilityId).toBe(first.result.capabilityId);
    expect(readFileSync(path, 'utf8')).toBe(before);
    // Rotating would invalidate a token a running CLI or script already holds.
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM capability').get().n).toBe(1);
  });

  test('reuses the live operator principal after the file is deleted and re-minted', () => {
    const { store, runtimeRoot, path } = setup();
    const first = ensure({ store, runtimeRoot });
    writeFileSync(path, '', { mode: 0o600 }); // stand in for `rm`; an empty file is unparseable
    chmodSync(path, 0o600);
    expect(ensure({ store, runtimeRoot }).err?.code).toBe('config_invalid');

    // The real recovery path: remove it.
    rmSync(path);
    const second = ensure({ store, runtimeRoot });

    expect(second.result.principalId).toBe(first.result.principalId);
    expect(second.result.capabilityId).not.toBe(first.result.capabilityId);
    expect(listPrincipals(store, { role: OPERATOR_ROLE })).toHaveLength(1);
  });

  test('a revoked operator PRINCIPAL is not reused: revoking the human starts over', () => {
    const { store, runtimeRoot, path } = setup();
    const first = ensure({ store, runtimeRoot });
    revokePrincipal(store, first.result.principalId);
    rmSync(path);

    const second = ensure({ store, runtimeRoot });
    expect(second.result.principalId).not.toBe(first.result.principalId);
    expect(listPrincipals(store, { role: OPERATOR_ROLE })).toHaveLength(1);
  });
});

describe('a present but unusable credential', () => {
  test('a revoked capability is refused, and never replaced', () => {
    const { store, runtimeRoot, path } = setup();
    const first = ensure({ store, runtimeRoot });
    const before = readFileSync(path, 'utf8');
    revokeCapability(store, first.result.capabilityId, 'operator-revoked');

    const { err, reports } = ensure({ store, runtimeRoot });
    // Minting a replacement here would turn revocation into theatre.
    expect(err?.code).toBe('config_invalid');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(path);
    expect(reports[0]).toMatch(/revoked, expired, or issued by a store that no longer exists/);
    expect(reports[0]).toMatch(/delete that file and restart/);
  });

  test('a token from another store is refused', () => {
    const { store, runtimeRoot, path } = setup();
    writeFileSync(path, 'MmM9xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE\n', { mode: 0o600 });
    expect(ensure({ store, runtimeRoot }).err?.code).toBe('config_invalid');
    expect(readFileSync(path, 'utf8').trim()).toBe('MmM9xLmA9vTbNc4WkYz7RgHjDf1EoUiXaSlBn0MpQwE');
  });

  test('a loose mode is refused as a disclosure, not clamped', () => {
    const { store, runtimeRoot, path } = setup();
    ensure({ store, runtimeRoot });
    const before = readFileSync(path, 'utf8');
    chmodSync(path, 0o644);

    const { err, reports } = ensure({ store, runtimeRoot });
    expect(err?.code).toBe('config_invalid');
    // Quietly chmodding it would hide that the credential was ever world-readable.
    expect(modeOf(path)).toBe('644');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(reports[0]).toMatch(/readable beyond its owner \(mode 0644\)/);
    expect(reports[0]).toMatch(/revoke/);
  });

  test('a directory in its place is refused', () => {
    const { store, runtimeRoot, path } = setup();
    mkdirSync(path, { mode: 0o700 });
    expect(ensure({ store, runtimeRoot }).err?.code).toBe('config_invalid');
  });

  test('unparseable content is refused and left alone', () => {
    const { store, runtimeRoot, path } = setup();
    writeFileSync(path, '{"nope":1}\n', { mode: 0o600 });
    const { err, reports } = ensure({ store, runtimeRoot });
    expect(err?.code).toBe('config_invalid');
    expect(reports[0]).toMatch(/could not be parsed/);
    expect(readFileSync(path, 'utf8')).toBe('{"nope":1}\n');
  });

  test('the operator sees the path; the error envelope never does', () => {
    // Two channels, one failure — the same boundary `secret.test.js` pins for `hook.secret`.
    const { store, runtimeRoot, path } = setup();
    writeFileSync(path, 'not-a-token-in-this-store-000000000000000\n', { mode: 0o600 });
    const { err, reports } = ensure({ store, runtimeRoot });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(path);

    const envelope = JSON.stringify({ message: err.message, detail: err.detail ?? null });
    expect(envelope).not.toContain(path);
    expect(envelope).not.toContain(runtimeRoot);
    expect(err.message).toMatch(/the file and the fix are on stderr/);
  });
});

describe('publishing', () => {
  test('a name that already exists loses the race rather than clobbering the winner', () => {
    // A dangling symlink: `statSync` reports ENOENT so the writer proceeds to mint, then finds
    // the name taken at `link` time. That EEXIST is the same one a racing service produces.
    const { store, runtimeRoot, path } = setup();
    symlinkSync(join(runtimeRoot, 'nothing-here'), path);

    const { err, reports } = ensure({ store, runtimeRoot });
    // The winner's file cannot be read back, so this is a refusal — not a silent overwrite.
    expect(err?.code).toBe('config_invalid');
    expect(reports.some((line) => line.includes(path))).toBe(true);
    expect(readdirSync(runtimeRoot).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  test(
    `${RACERS} racing services publish exactly one credential and one live operator`,
    async () => {
      // The EEXIST branch is only reachable under genuine concurrency, and it is the branch that
      // decides whether a cold double-boot leaves live capabilities nobody holds behind — and,
      // if the loser over-tidies, whether it revokes the identity the WINNER's credential
      // belongs to. `runTx` uses `BEGIN IMMEDIATE`, so all six mint (serialized, one inserting
      // the operator principal and five reusing it) and five then discover at `link` time that
      // they lost.
      const { store, runtimeRoot, path } = setup();
      const workers = Array.from({ length: RACERS }, (_, idx) =>
        spawnRacer([fixture.path, fixture.namespace, runtimeRoot], idx)
      );
      try {
        await Promise.all(workers.map((w) => w.ready));
        const at = Date.now() + LEAD_MS;
        for (const w of workers) w.child.stdin.write(`${at}\n`);
        const outcomes = await Promise.all(workers.map((w) => w.done));

        expect(outcomes.every((o) => o.code === 0), JSON.stringify(outcomes)).toBe(true);
        const created = outcomes.filter((o) => o.source === 'created');
        expect(created, 'exactly one process may publish').toHaveLength(1);

        // Every process ends up reporting the SAME capability: the published one.
        const published = readFileSync(path, 'utf8').trim();
        const verified = verifyCapability(store, published);
        expect(verified).not.toBeNull();
        expect(verified.capability.id).toBe(created[0].capability);
        expect(new Set(outcomes.map((o) => o.capability))).toEqual(new Set([created[0].capability]));

        // And the store holds no orphans and no collateral damage: one live operator principal
        // (never revoked by a losing racer) and exactly one live capability.
        expect(listPrincipals(store, { role: OPERATOR_ROLE })).toHaveLength(1);
        expect(listPrincipals(store, { role: OPERATOR_ROLE, includeRevoked: true })).toHaveLength(1);
        expect(verified.principal.id).toBe(listPrincipals(store, { role: OPERATOR_ROLE })[0].id);
        expect(
          store.db.prepare('SELECT COUNT(*) AS n FROM capability WHERE revoked_at IS NULL').get().n
        ).toBe(1);
        // The losers really did take the EEXIST path: their rows are present and revoked.
        expect(
          store.db.prepare('SELECT COUNT(*) AS n FROM capability WHERE revoked_at IS NOT NULL').get()
            .n
        ).toBe(RACERS - 1);
        expect(readdirSync(runtimeRoot).filter((name) => name.includes('.tmp.'))).toEqual([]);
      } finally {
        for (const w of workers) w.child.kill('SIGKILL');
      }
    },
    60000
  );
});
