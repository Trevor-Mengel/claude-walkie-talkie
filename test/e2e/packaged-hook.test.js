// The packaged SessionStart / UserPromptSubmit hook, executed the way the harness executes it.
//
// This file exists because `hooks/scripts/check-inbox.sh` was dead on every invocation for the
// whole of v0.3 and nothing noticed. It gated on `.collabcast/server.port` — a v0.2 artifact
// that v0.3 never creates — so the guard was false every time and the script exited 0 having
// done nothing; past that guard it passed `--since-last`, an option the CLI does not declare;
// and it ended in `2>/dev/null || true`, which made a broken script, a missing binary and a
// rejected credential all read as "no new messages". A rename pass had edited the strings inside
// it without ever running it. 1182 tests were green while inbound messages reached no agent
// session through the shipped plugin.
//
// So this file's rule, and the reason it is separate from the packaging test: it obtains NOTHING
// from a fixture. No helper writes a credential, a config, an identity-map entry or a runtime
// artifact; nothing here imports `test/helpers/registered-namespace.js` or
// `test/helpers/stack.js`; readiness is never simulated. It runs `collabcast init`, then
// `collabcast start`, then posts through the real CLI, then executes the shipped shell script as
// a subprocess with `CLAUDE_PROJECT_DIR` set — exactly what Claude Code does — and asserts on
// what an agent would actually be shown. Revert the script and every assertion below about
// rendering, quiet, or surfacing goes red.
//
// The hook is deliberately run from a cwd OUTSIDE the project, because that is the harness's
// contract: `CLAUDE_PROJECT_DIR` names the project, not the working directory.
//
// The only environment set is isolation: this file's own identity map and its own runtime root,
// both inside its own throw-away directory. The runtime root is pinned to the exact path the
// product would derive anyway (`<root>/.collabcast/run`) purely to neutralise the harness's
// shared `COLLABCAST_RUNTIME_ROOT`, which would otherwise put every project here on one socket.

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureDir } from '../helpers/fixture-leaks.js';
import { assertDisposable, isolatedEnv } from '../helpers/isolation.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(PACKAGE_ROOT, 'bin', 'collabcast.js');
const HOOK = join(PACKAGE_ROOT, 'hooks', 'scripts', 'check-inbox.sh');
const NAMESPACE = 'cc-hook';

/** Every project this file created, so a failed assertion cannot leave a service behind. */
const projects = [];

afterEach(async () => {
  while (projects.length > 0) {
    const project = projects.pop();
    await project.cli(['stop']).catch(() => undefined);
    project.remove();
  }
});

/** A directory that has never seen collabcast. The starting point a human actually has. */
function freshProject() {
  // Kept tiny on purpose: the AF_UNIX limit applies to
  // `<tmp>/<this>/.collabcast/run/collabcast.sock`, and macOS caps `sun_path` at 104 bytes.
  const root = realpathSync(createFixtureDir('cc-hk-'));
  assertDisposable(root, 'packaged hook project root');

  const runtimeRoot = join(root, '.collabcast', 'run');
  const env = isolatedEnv({
    COLLABCAST_IDENTITIES: join(root, 'identities.json'),
    COLLABCAST_RUNTIME_ROOT: runtimeRoot,
    COLLABCAST_SOCKET_PATH: undefined, // harness exports ONE run-wide socket path and it
    // overrides the runtime-root-derived one, putting every project on one socket
    // The harness exports these; a project resolved from cwd must not inherit another one's.
    COLLABCAST_PROJECT_ROOT: undefined,
    COLLABCAST_NAMESPACE: undefined,
    COLLABCAST_CAPABILITY: undefined
  });

  const project = {
    root,
    env,
    runtimeRoot,
    /** Run the shipped CLI. Resolves for every exit code; never throws on a refusal. */
    cli(args) {
      return new Promise((resolve) => {
        execFile(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' }, (err, stdout, stderr) =>
          resolve({ code: err?.code ?? 0, stdout, stderr })
        );
      });
    },
    /**
     * Run the shipped hook script the way the harness does: no arguments, no stdin it depends
     * on, `CLAUDE_PROJECT_DIR` naming the project, and a cwd that is NOT the project.
     *
     * @param {{script?:string, env?:Record<string,string|undefined>}} [opts]
     */
    hook({ script = HOOK, env: extra = {} } = {}) {
      return new Promise((resolve) => {
        execFile(
          script,
          [],
          {
            cwd: tmpdir(),
            env: { ...env, CLAUDE_PROJECT_DIR: root, ...extra },
            encoding: 'utf8'
          },
          (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })
        );
      });
    },
    remove() {
      assertDisposable(root, 'packaged hook project root');
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
    'Hook Tester',
    '--namespace',
    NAMESPACE,
    '--mode',
    'standalone'
  ]);
  expect(init.code, init.stderr).toBe(0);
  const start = await project.cli(['start']);
  expect(start.code, start.stderr).toBe(0);
  return project;
}

/**
 * Write the two artifacts the old script's readiness logic was built on: a v0.2 `server.port`
 * that v0.3 never creates, and a `collabcast.pid` naming a process that does not exist.
 *
 * Returns a restore function, and callers must use it while a service is running: `collabcast
 * stop` signals the pid THIS file names, so leaving the bogus one in place makes the shutdown
 * time out and orphans the daemon. (Observed: six leaked services before this was a function.)
 */
function plantStaleArtifacts(project) {
  writeFileSync(join(project.root, '.collabcast', 'server.port'), '49573\n');
  mkdirSync(project.runtimeRoot, { recursive: true });
  const pidPath = join(project.runtimeRoot, 'collabcast.pid');
  const previous = existsSync(pidPath) ? readFileSync(pidPath, 'utf8') : null;
  // 2^22 - 1 is above every pid macOS and Linux will hand out, so it cannot name a live process.
  writeFileSync(pidPath, '4194303\n');
  return () => {
    if (previous === null) rmSync(pidPath, { force: true });
    else writeFileSync(pidPath, previous);
  };
}

describe('the packaged hook against a real install', () => {
  it(
    'renders a message posted through the CLI, which is the whole reason it ships',
    async () => {
      const project = await install();

      const talk = await project.cli(['talk', 'the operator says hello']);
      expect(talk.code, talk.stderr).toBe(0);

      const hook = await project.hook();

      // The assertion the finding demands: the hook actually delivers. Against the previous
      // script this is empty, because the `server.port` guard returned before it ever ran.
      expect(hook.code, hook.stderr).toBe(0);
      expect(hook.stdout).toContain('the operator says hello');
      expect(hook.stdout).toMatch(/^collabcast inbox: 1 message\(s\)$/m);
      // And it tells the agent how to acknowledge, since it deliberately did not.
      expect(hook.stdout).toMatch(/acknowledge with `collabcast ack [0-9A-HJKMNP-TV-Z]{26}`/);
      expect(hook.stderr).toBe('');
    },
    40000
  );

  it(
    'renders what a second message adds, so delivery is not a one-shot accident',
    async () => {
      const project = await install();
      expect((await project.cli(['talk', 'first'])).code).toBe(0);
      expect((await project.cli(['talk', 'second'])).code).toBe(0);

      const hook = await project.hook();
      expect(hook.code, hook.stderr).toBe(0);
      expect(hook.stdout).toMatch(/^collabcast inbox: 2 message\(s\)$/m);
      expect(hook.stdout).toContain('first');
      expect(hook.stdout).toContain('second');
    },
    40000
  );

  it(
    'does not acknowledge what it rendered, so an unread message survives the turn',
    async () => {
      const project = await install();
      expect((await project.cli(['talk', 'still unread'])).code).toBe(0);

      // A hook fires whether or not the model ever attends to what it injected. Acking here
      // would record non-delivery as acknowledgement — the exact failure the v0.3 cursor rework
      // existed to remove — so the same message must appear on every turn until acked.
      const first = await project.hook();
      const second = await project.hook();
      expect(first.stdout).toContain('still unread');
      expect(second.stdout).toBe(first.stdout);

      const id = /\[([0-9A-HJKMNP-TV-Z]{26})\]/.exec(first.stdout)[1];
      expect((await project.cli(['ack', id])).code).toBe(0);

      // Only an explicit ack empties it. The hook stays honest about being empty rather than
      // silent: a live channel saying "no new messages" is the only thing that distinguishes it
      // from a channel gone quiet because this hook is broken again.
      const third = await project.hook();
      expect(third.code, third.stderr).toBe(0);
      expect(third.stdout).toContain('(no new messages)');
      expect(third.stdout).not.toContain('still unread');
    },
    40000
  );

  it(
    'is quiet and succeeds when the service is stopped',
    async () => {
      const project = await install();
      expect((await project.cli(['talk', 'posted before the stop'])).code).toBe(0);
      expect((await project.cli(['stop'])).code).toBe(0);

      // A stopped service is the operator's own choice, not a fault, and a hook that nagged
      // about it on every prompt would be worse than useless. Exit 0, nothing on either stream.
      const hook = await project.hook();
      expect(hook.code).toBe(0);
      expect(hook.stdout).toBe('');
      expect(hook.stderr).toBe('');
    },
    40000
  );

  it(
    'is quiet in a directory that has never been initialised',
    async () => {
      const project = freshProject();
      const hook = await project.hook();
      expect(hook.code).toBe(0);
      expect(hook.stdout).toBe('');
      expect(hook.stderr).toBe('');
    },
    20000
  );
});

describe('the packaged hook and stale artifacts', () => {
  it(
    'renders exactly the same thing with a stale server.port and a stale pid file present',
    async () => {
      const project = await install();
      expect((await project.cli(['talk', 'stale files must not matter'])).code).toBe(0);

      const clean = await project.hook();
      expect(clean.stdout).toContain('stale files must not matter');

      const restorePid = plantStaleArtifacts(project);

      // The old script's entire readiness decision was `[ -f .collabcast/server.port ]`. If any
      // of that logic survived, planting the file would change the answer here.
      const stale = await project.hook();
      expect(stale.code, stale.stderr).toBe(0);
      expect(stale.stdout).toBe(clean.stdout);
      expect(stale.stderr).toBe('');

      // The live service is still ours to shut down cleanly.
      restorePid();
    },
    40000
  );

  it(
    'stays quiet with a stale server.port and a stale pid file and no service',
    async () => {
      const project = await install();
      expect((await project.cli(['stop'])).code).toBe(0);
      const restorePid = plantStaleArtifacts(project);

      // The inverse: a leftover port file must not make a dead service look alive either.
      const hook = await project.hook();
      expect(hook.code).toBe(0);
      expect(hook.stdout).toBe('');
      expect(hook.stderr).toBe('');
      restorePid();
    },
    40000
  );
});

describe('the packaged hook reports its own failures', () => {
  it(
    'surfaces a rejected credential instead of reporting an empty inbox',
    async () => {
      const project = await install();
      const whoami = await project.cli(['whoami', '--json']);
      expect(whoami.code, whoami.stderr).toBe(0);
      const { capabilityId } = JSON.parse(whoami.stdout);
      expect((await project.cli(['revoke', capabilityId])).code).toBe(0);

      // The service is answering and refusing us. Under `2>/dev/null || true` this printed
      // nothing and exited 0, so an operator whose capability had been revoked saw a channel
      // that looked healthy and empty forever.
      const hook = await project.hook();
      expect(hook.code, 'a refused read is not a success').not.toBe(0);
      // Never 2: exit 2 blocks the operator's prompt, and collabcast being unwell is not a
      // reason to stop them working.
      expect(hook.code).not.toBe(2);
      expect(hook.stderr).toContain('NOT being delivered');
      // The CLI's own words, not a summary of them.
      expect(hook.stderr).toMatch(/collabcast \[unauthenticated]:/);
      expect(hook.stdout, 'a failure must not be dressed up as an empty inbox').not.toContain(
        'no new messages'
      );
    },
    40000
  );

  it(
    'surfaces an unusable credential file instead of reporting an empty inbox',
    async () => {
      const project = await install();
      // A credential loosened out of band. The CLI refuses to use it; the hook must say so.
      chmodSync(join(project.runtimeRoot, 'operator.cred'), 0o644);

      const hook = await project.hook();
      expect(hook.code).not.toBe(0);
      expect(hook.stderr).toContain('NOT being delivered');
      expect(hook.stderr).toMatch(/readable beyond its owner/);
      expect(hook.stdout).toBe('');
    },
    40000
  );

  it(
    'surfaces an initialised project that has never been started',
    async () => {
      const project = freshProject();
      const init = await project.cli([
        'init',
        '--operator',
        'Hook Tester',
        '--namespace',
        NAMESPACE,
        '--mode',
        'standalone'
      ]);
      expect(init.code, init.stderr).toBe(0);

      // Deliberate, and worth stating: `operator.cred` is written by `start`, so before a first
      // start the CLI's honest first complaint is `unauthenticated` rather than `unavailable`.
      // The hook surfaces it. An `init`-only project is an INCOMPLETE INSTALL — messages will
      // never arrive — and staying silent about it is the very failure this file exists for. The
      // message names the remedy, and one `collabcast start` (or any MCP tool use, which starts
      // the service) ends it. Contrast with the started-then-stopped case above, which is a
      // deliberate operator choice and stays quiet because the credential survives a stop.
      const hook = await project.hook();
      expect(hook.code).not.toBe(0);
      expect(hook.stderr).toContain('NOT being delivered');
      expect(hook.stderr).toMatch(/no operator credential found/);
      expect(hook.stdout).toBe('');
    },
    30000
  );

  it(
    'surfaces a broken install with no CLI on disk or on PATH',
    async () => {
      const project = await install();

      // A package tree with the hook but no `bin/`: what a partial install, a bad `files`
      // entry, or a deleted dependency actually looks like. The hook resolves the CLI relative
      // to itself, so this is the honest way to take the CLI away from it.
      const fakePackage = join(project.root, 'fake-package');
      mkdirSync(join(fakePackage, 'hooks', 'scripts'), { recursive: true });
      const script = join(fakePackage, 'hooks', 'scripts', 'check-inbox.sh');
      copyFileSync(HOOK, script);
      chmodSync(script, 0o755);

      const hook = await project.hook({
        script,
        // No `collabcast` here, and the fixture project has no `node_modules/.bin` either.
        env: { PATH: '/usr/bin:/bin', COLLABCAST_CMD: undefined }
      });
      expect(hook.code).not.toBe(0);
      expect(hook.stderr).toMatch(/no collabcast CLI found/);
      expect(hook.stderr).toContain('NOT being delivered');
      expect(hook.stdout).toBe('');
    },
    40000
  );

  it(
    'surfaces a CLI that cannot be executed',
    async () => {
      const project = await install();

      // Distinct from "absent": something IS resolved and it fails when run. The previous
      // script's `|| true` erased this case entirely.
      const hook = await project.hook({
        env: { COLLABCAST_CMD: join(project.root, 'not-a-real-binary') }
      });
      expect(hook.code).not.toBe(0);
      expect(hook.stderr).toContain('NOT being delivered');
      expect(hook.stdout).toBe('');
    },
    40000
  );
});
