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
