// A genuinely fresh install, driven only through the shipped CLI.
//
// This file exists because of a specific, repeated failure. For the whole of v0.3 nothing in
// `src/` or `bin/` wrote `<runtimeRoot>/operator.cred`; the only writers were
// `test/helpers/registered-namespace.js` and `test/helpers/stack.js`. 1142 tests were green
// while every operator command except `init`/`start`/`stop`/`status` was unusable on a fresh
// machine, because the fixtures authenticated against a credential production never created.
// That is the third time this suite has been fooled the same way — the authority socket the
// fixture bound itself was the first two.
//
// So the rule for this file, and the reason it is a separate file: it imports NOTHING from
// `test/helpers/registered-namespace.js` or `test/helpers/stack.js`, and it never writes a
// credential, a config, an identity map entry or a runtime artifact itself. It runs
// `collabcast init`, then `collabcast start`, then real authenticated commands as subprocesses
// and asserts what a human would see. Delete the production writer and every test below that
// authenticates goes red.
//
// The only environment it sets is isolation: its own identity map and its own runtime root,
// both inside its own throw-away directory. The runtime root is set to the exact path the
// product would derive anyway (`<root>/.collabcast/run`) purely to neutralise the harness's
// shared `COLLABCAST_RUNTIME_ROOT`, which would otherwise put every project in this file on one
// socket.

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureDir } from '../helpers/fixture-leaks.js';
import { assertDisposable, isolatedEnv } from '../helpers/isolation.js';
import { OPERATOR_CREDENTIAL_FILENAME } from '../../src/authority/paths.js';
import { ROLE_SCOPES } from '../../src/authority/policy.js';
// Used by exactly one test below, to construct an input the shipped CLI deliberately cannot: a
// narrowed `operator` capability. See the comment on that test.
import { storeDir } from '../../src/config/schema.js';
import { openStore } from '../../src/store/db.js';
import { createPrincipal } from '../../src/store/principals.js';
import { issueCapability } from '../../src/store/capabilities.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'collabcast.js');
const NAMESPACE = 'cc-fresh';

/** Every project this file created, so a failed assertion cannot leave a daemon behind. */
const projects = [];

afterEach(async () => {
  while (projects.length > 0) {
    const project = projects.pop();
    await project.cli(['stop']).catch(() => undefined);
    project.remove();
  }
});

/**
 * A directory that has never seen collabcast: no `.collabcast/`, no identity map entry, no
 * runtime artifacts. The starting point a human actually has.
 */
function freshProject() {
  // Kept tiny on purpose: the AF_UNIX limit applies to
  // `<tmp>/<this>/.collabcast/run/collabcast.sock`, and macOS caps `sun_path` at 104 bytes.
  const root = realpathSync(createFixtureDir('cc-fi-'));
  assertDisposable(root, 'fresh install root');

  const identities = join(root, 'identities.json');
  const env = isolatedEnv({
    COLLABCAST_IDENTITIES: identities,
    COLLABCAST_RUNTIME_ROOT: join(root, '.collabcast', 'run'),
    // The harness exports these; a project resolved from cwd must not inherit another one's.
    //
    // COLLABCAST_SOCKET_PATH is the load-bearing one and it was missing. The harness exports a
    // SINGLE socket path for the whole run (test/helpers/isolation.js:170) and propagates it into
    // spawned children (:235), and an explicit socket path overrides the one derived from
    // COLLABCAST_RUNTIME_ROOT. So every project here shared one socket despite having distinct
    // runtime roots: one project's daemon answered another project's `status`, `startDaemon` took
    // its `if (current.running) return current` short-circuit, and `start` exited 0 without ever
    // booting — so the credential-grant check never ran. `readHealth`'s namespace guard could not
    // catch it either, because every project in this file uses the same NAMESPACE. Clearing it
    // lets the socket resolve per project, under the runtime root above.
    COLLABCAST_SOCKET_PATH: undefined,
    COLLABCAST_PROJECT_ROOT: undefined,
    COLLABCAST_NAMESPACE: undefined,
    COLLABCAST_CAPABILITY: undefined
  });

  const project = {
    root,
    env,
    runtimeRoot: join(root, '.collabcast', 'run'),
    credentialPath: join(root, '.collabcast', 'run', OPERATOR_CREDENTIAL_FILENAME),
    /** Run the shipped CLI. Resolves for every exit code; never throws on a refusal. */
    cli(args) {
      return new Promise((resolve) => {
        execFile(
          process.execPath,
          [BIN, ...args],
          { cwd: root, env, encoding: 'utf8' },
          (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })
        );
      });
    },
    remove() {
      assertDisposable(root, 'fresh install root');
      rmSync(root, { recursive: true, force: true });
    }
  };
  projects.push(project);
  return project;
}

/** `init` + `start`, asserting both succeeded so a later failure is not blamed on the boot. */
async function install() {
  const project = freshProject();
  const init = await project.cli([
    'init',
    '--operator',
    'Fresh Tester',
    '--namespace',
    NAMESPACE,
    '--mode',
    'standalone'
  ]);
  expect(init.code, init.stderr).toBe(0);
  // The starting point the bug report describes: initialised, and no credential anywhere.
  expect(existsSync(project.credentialPath)).toBe(false);

  const start = await project.cli(['start']);
  expect(start.code, start.stderr).toBe(0);
  return project;
}

function mode(path) {
  return (statSync(path).mode & 0o777).toString(8);
}

/** `whoami --json`, parsed. */
async function whoami(project) {
  const { code, stdout, stderr } = await project.cli(['whoami', '--json']);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout);
}

describe('a fresh install', () => {
  it(
    'leaves a usable operator credential, so the CLI can authenticate without a fixture',
    async () => {
      const project = await install();

      // The artifact itself: present, owner-only, inside the 0700 runtime directory.
      expect(existsSync(project.credentialPath), 'operator.cred after a fresh start').toBe(true);
      expect(mode(project.credentialPath)).toBe('600');
      expect(mode(project.runtimeRoot)).toBe('700');

      // And it is a real capability, resolved by the service rather than believed from the file.
      const self = await whoami(project);
      expect(self.namespace).toBe(NAMESPACE);
      expect(self.role).toBe('operator');
      expect(self.principalId).toMatch(/^prn_/);
      expect(self.capabilityId).toMatch(/^cap_/);
      expect(self.credentialDrift).toEqual([]);
      expect(self.scopes).toContain('channel:publish');

      // A write command, end to end: authorship is derived from this capability.
      const talk = await project.cli(['talk', 'hello from a fresh install']);
      expect(talk.code, talk.stderr).toBe(0);

      const read = await project.cli(['read', '--limit', '5']);
      expect(read.code, read.stderr).toBe(0);
      expect(read.stdout).toContain('hello from a fresh install');
      expect(read.stdout).toContain(self.principalId);
    },
    30000
  );

  it(
    'never puts the token on stdout, so a shipped log cannot carry the operator credential',
    async () => {
      const project = await install();
      const token = readFileSync(project.credentialPath, 'utf8').trim();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // `start` reports through the same lifecycle output an operator or supervisor reads.
      const status = await project.cli(['status']);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).not.toContain(token);
      expect(status.stderr).not.toContain(token);

      // `whoami` names the capability; it never re-prints the bearer.
      const self = await project.cli(['whoami']);
      expect(self.stdout).not.toContain(token);
    },
    30000
  );

  it(
    'break-glass `enroll --recovery` authenticates with the credential it exists for',
    async () => {
      const project = await install();
      const enroll = await project.cli(['enroll', '--recovery', '--role', 'listener', '--json']);
      expect(enroll.code, enroll.stderr).toBe(0);
      const issued = JSON.parse(enroll.stdout);
      expect(issued.role).toBe('listener');
      expect(issued.scopes).toEqual(['channel:read', 'self:cursor']);
      expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // A delegated capability, not a copy of the operator's own.
      expect(issued.token).not.toBe(readFileSync(project.credentialPath, 'utf8').trim());
    },
    30000
  );

  it(
    'a second start leaves an existing valid credential exactly as it was',
    async () => {
      const project = await install();
      const before = readFileSync(project.credentialPath, 'utf8');
      const first = await whoami(project);

      expect((await project.cli(['stop'])).code).toBe(0);
      const restart = await project.cli(['start']);
      expect(restart.code, restart.stderr).toBe(0);

      // Rotating here would silently invalidate a token a running CLI or script already holds.
      expect(readFileSync(project.credentialPath, 'utf8')).toBe(before);
      const second = await whoami(project);
      expect(second.capabilityId).toBe(first.capabilityId);
      expect(second.principalId).toBe(first.principalId);
    },
    30000
  );
});

describe('a credential the service will not honour', () => {
  it(
    'refuses a wrong-mode credential, names the file and the fix, and does not overwrite it',
    async () => {
      const project = await install();
      expect((await project.cli(['stop'])).code).toBe(0);
      const before = readFileSync(project.credentialPath, 'utf8');
      chmodSync(project.credentialPath, 0o644);

      const start = await project.cli(['start']);
      expect(start.code).not.toBe(0);
      // The operator channel carries the path and the remedy — they are the only party who can act.
      expect(start.stderr).toContain(project.credentialPath);
      expect(start.stderr).toMatch(/readable beyond its owner \(mode 0644\)/);
      expect(start.stderr).toMatch(/revoke/);

      // Silently replacing a credential the operator put there is worse than refusing.
      expect(readFileSync(project.credentialPath, 'utf8')).toBe(before);
      expect(mode(project.credentialPath)).toBe('644');

      chmodSync(project.credentialPath, 0o600);
      expect((await project.cli(['start'])).code, 'usable again once the mode is fixed').toBe(0);
    },
    30000
  );

  it(
    'refuses an unparseable credential and does not overwrite it',
    async () => {
      const project = await install();
      expect((await project.cli(['stop'])).code).toBe(0);
      writeFileSync(project.credentialPath, '[]\n', { mode: 0o600 });

      const start = await project.cli(['start']);
      expect(start.code).not.toBe(0);
      expect(start.stderr).toContain(project.credentialPath);
      expect(start.stderr).toMatch(/could not be parsed/);
      expect(start.stderr).toMatch(/delete that file and restart/);
      expect(readFileSync(project.credentialPath, 'utf8')).toBe('[]\n');
    },
    30000
  );

  it(
    'is a real capability: revoking it locks the CLI out and start will not mint over it',
    async () => {
      const project = await install();
      const self = await whoami(project);
      const before = readFileSync(project.credentialPath, 'utf8');

      const revoke = await project.cli(['revoke', self.capabilityId]);
      expect(revoke.code, revoke.stderr).toBe(0);

      // If this credential were a bypass rather than a capability row, revocation would be theatre.
      const after = await project.cli(['whoami']);
      expect(after.code).toBe(2);
      expect(after.stderr).toMatch(/^collabcast \[unauthenticated]:/);
      expect((await project.cli(['talk', 'should not land'])).code).toBe(2);

      // Nor may a restart quietly re-mint over the token the operator just killed.
      expect((await project.cli(['stop'])).code).toBe(0);
      const start = await project.cli(['start']);
      expect(start.code).not.toBe(0);
      expect(start.stderr).toContain(project.credentialPath);
      expect(start.stderr).toMatch(/revoked, expired, or issued by a store that no longer exists/);
      expect(readFileSync(project.credentialPath, 'utf8')).toBe(before);

      // The documented recovery: delete the file — which needs the operator's own uid — and restart.
      rmSync(project.credentialPath);
      expect((await project.cli(['start'])).code).toBe(0);
      const recovered = await whoami(project);
      expect(recovered.capabilityId).not.toBe(self.capabilityId);
      // Same human, so the same principal: a new one per recovery would scatter their identity.
      expect(recovered.principalId).toBe(self.principalId);
      expect((await project.cli(['talk', 'back in'])).code).toBe(0);
    },
    40000
  );
});

describe('a credential that verifies but does not grant operator authority', () => {
  // For the whole of v0.3 the reuse path asked only whether the token was live, never what it
  // granted — so the file's LOCATION was the authority instead of the credential's grant. A real
  // `listener` or `goal_hub` token pasted into `operator.cred` booted a healthy service with an
  // operator CLI that failed at some arbitrary later command with `scope_required`.
  //
  // The first two tokens below are not hand-forged and not written by a helper: they come out of
  // the shipped `collabcast enroll --recovery`, which is exactly how an operator ends up holding
  // one, and are then pasted where the operator's own credential goes. The last two are inputs no
  // command can produce, and `mintIntoStore` explains itself.

  /** A real delegated token for `role`, minted through the shipped break-glass path. */
  async function recoveryToken(project, role) {
    const enroll = await project.cli(['enroll', '--recovery', '--role', role, '--json']);
    expect(enroll.code, enroll.stderr).toBe(0);
    const issued = JSON.parse(enroll.stdout);
    expect(issued.role).toBe(role);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return issued.token;
  }

  for (const role of ['listener', 'goal_hub']) {
    it(
      `fails the boot closed when operator.cred holds a live '${role}' token`,
      async () => {
        const project = await install();
        const token = await recoveryToken(project, role);
        expect((await project.cli(['stop'])).code).toBe(0);

        writeFileSync(project.credentialPath, `${token}\n`, { mode: 0o600 });
        chmodSync(project.credentialPath, 0o600);

        const start = await project.cli(['start']);
        expect(start.code, 'a boot over a non-operator credential must fail').not.toBe(0);
        // Actionable, in the channel that can act: the path, the role found, the role required.
        expect(start.stderr).toContain(project.credentialPath);
        expect(start.stderr).toContain(`'${role}'`);
        expect(start.stderr).toContain("'operator'");
        expect(start.stderr).toMatch(/delete that file and restart/);
        // And never the bearer itself: `start`'s output is what a supervisor captures.
        expect(start.stdout).not.toContain(token);
        expect(start.stderr).not.toContain(token);

        // Readiness still means "the operator can act", so nothing may be answering.
        const status = await project.cli(['status']);
        expect(status.stdout).toMatch(/is not answering/);

        // Refused, not repaired: a credential the operator placed is never minted over.
        expect(readFileSync(project.credentialPath, 'utf8')).toBe(`${token}\n`);
        expect(mode(project.credentialPath)).toBe('600');

        // The documented recovery, and it is the only one.
        rmSync(project.credentialPath);
        expect((await project.cli(['start'])).code, 'usable again once removed').toBe(0);
        expect((await whoami(project)).role).toBe('operator');
      },
      40000
    );
  }

  /**
   * Mints a live capability straight into the project's store and returns its token.
   *
   * Two of the inputs below cannot come from the shipped CLI, by design: `operator` is not a
   * delegable role, and `root` is not either, so no command produces a narrowed operator
   * capability or a root capability holding every scope. They go in through the store instead.
   * That does not weaken this file's rule — the rule is that nothing here may create the artifact
   * PRODUCTION is supposed to create, and these create deliberately broken ones, exactly as the
   * unparseable-credential case above does. The service is stopped first, so nothing races.
   */
  function mintIntoStore(project, { role, scopes, ref }) {
    const store = openStore({
      path: join(storeDir(project.root), 'collabcast.db'),
      namespace: NAMESPACE
    });
    try {
      return store.tx((tx) => {
        const principal = createPrincipal(tx, { role, displayAlias: null });
        return issueCapability(tx, {
          principalId: principal.id,
          scopes,
          ttlSeconds: 3600,
          attestationKind: 'operator_cli',
          attestationRef: ref
        }).token;
      });
    } finally {
      store.close();
    }
  }

  it(
    "fails the boot closed when operator.cred holds a 'root' token that has every scope",
    async () => {
      // The case a scope-only check waves through, so this is the one that proves the ROLE half
      // gates the boot on its own. The three CLI-minted cases above are caught by either half,
      // which is why neither of them could prove the two checks are independent.
      const project = await install();
      const operatorToken = readFileSync(project.credentialPath, 'utf8').trim();
      expect((await project.cli(['stop'])).code).toBe(0);

      const token = mintIntoStore(project, {
        role: 'root',
        scopes: [...ROLE_SCOPES.operator],
        ref: 'test.root_with_every_scope'
      });
      writeFileSync(project.credentialPath, `${token}\n`, { mode: 0o600 });
      chmodSync(project.credentialPath, 0o600);

      const start = await project.cli(['start']);
      expect(start.code, 'a boot over a root credential must fail').not.toBe(0);
      expect(start.stderr).toContain(project.credentialPath);
      expect(start.stderr).toMatch(/grants the role 'root', not 'operator'/);
      // It holds every scope, so nothing may be reported as missing.
      expect(start.stderr).not.toMatch(/missing/);
      expect(start.stderr).toMatch(/delete that file and restart/);
      expect(start.stderr).not.toContain(token);
      expect(start.stderr).not.toContain(operatorToken);
      expect(start.stdout).not.toContain(token);

      expect((await project.cli(['status'])).stdout).toMatch(/is not answering/);
      expect(readFileSync(project.credentialPath, 'utf8')).toBe(`${token}\n`);
      expect(mode(project.credentialPath)).toBe('600');

      rmSync(project.credentialPath);
      expect((await project.cli(['start'])).code, 'usable again once removed').toBe(0);
      expect((await whoami(project)).role).toBe('operator');
    },
    40000
  );

  it(
    'fails the boot closed when operator.cred holds an operator token with narrowed scopes',
    async () => {
      // The case a role-only check waves through, so this is the one that proves the SCOPE half
      // gates the boot on its own. Completeness is load-bearing: `issueCapability` refuses a
      // child scope the parent lacks, so an operator credential without `listener:consume` cannot
      // mint a working listener through `enroll --recovery` — break-glass would look like it
      // worked and then hand back a crippled capability.
      const project = await install();
      const operatorToken = readFileSync(project.credentialPath, 'utf8').trim();
      expect((await project.cli(['stop'])).code).toBe(0);

      const token = mintIntoStore(project, {
        role: 'operator',
        scopes: [...ROLE_SCOPES.operator].filter((scope) => scope !== 'listener:consume'),
        ref: 'test.narrowed_operator'
      });
      writeFileSync(project.credentialPath, `${token}\n`, { mode: 0o600 });
      chmodSync(project.credentialPath, 0o600);

      const start = await project.cli(['start']);
      expect(start.code, 'a boot over a narrowed operator credential must fail').not.toBe(0);
      expect(start.stderr).toContain(project.credentialPath);
      expect(start.stderr).toContain('listener:consume');
      // The role is right here, so the refusal must be about the grant's completeness.
      expect(start.stderr).not.toMatch(/grants the role/);
      expect(start.stderr).toMatch(/delete that file and restart/);
      expect(start.stderr).not.toContain(token);
      expect(start.stderr).not.toContain(operatorToken);
      expect(start.stdout).not.toContain(token);

      expect((await project.cli(['status'])).stdout).toMatch(/is not answering/);
      expect(readFileSync(project.credentialPath, 'utf8')).toBe(`${token}\n`);

      rmSync(project.credentialPath);
      expect((await project.cli(['start'])).code, 'usable again once removed').toBe(0);
      expect((await whoami(project)).role).toBe('operator');
    },
    40000
  );
});
