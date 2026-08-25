// The shipped hook surface: the scripts `hooks/hooks.json` names, and whether they can run.
//
// This file exists because of a P0 that nothing in the suite could see. `hooks/` is listed in
// `package.json` `files`, so everything under it is SHIPPED, but no test ever executed or even
// parsed `check-inbox.sh`. It therefore accumulated three faults that were each individually
// fatal and collectively invisible:
//
//   * it gated on `.collabcast/server.port`, a v0.2 artifact that v0.3 does not create, so the
//     guard was false on every run and the hook exited 0 having done nothing;
//   * it passed `collabcast inbox --since-last`, an option the CLI has never declared;
//   * it ended in `2>/dev/null || true`, so all three faults looked exactly like "no new
//     messages".
//
// A rename pass had rewritten the strings inside that script without ever invoking it. So the
// checks here are deliberately the cheap, static, always-run kind that a rename cannot fool:
// the file resolves, it is executable, `bash` can parse it, every long option it passes is one
// the CLI actually declares, and the one CLI constant it duplicates matches its source.
//
// It extends `test/packaging/identity.test.js`'s pattern — a dangling entry in a shipped
// manifest is shipped breakage no other test can see — rather than inventing a new one. The
// behavioural half lives in `test/e2e/packaged-hook.test.js`.

import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgram, EXIT_UNAVAILABLE } from '../../src/cli/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));

const HOOK_SCRIPT = join(ROOT, 'hooks', 'scripts', 'check-inbox.sh');
const source = readFileSync(HOOK_SCRIPT, 'utf8');

/**
 * The script text with comment-only lines removed, so an assertion about what the script DOES
 * is not satisfied (or broken) by what its header SAYS. The header names the v0.2 artifacts and
 * the bogus flag on purpose, to explain why they are gone.
 */
const body = source
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/**
 * Every `command` string in `hooks.json`, paired with the script path it resolves to.
 * `$CLAUDE_PLUGIN_ROOT` is the installed plugin's root, which for the package under test is
 * this repository.
 */
function declaredCommands() {
  const out = [];
  for (const [event, matchers] of Object.entries(manifest.hooks)) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        const first = hook.command.trim().split(/\s+/)[0];
        const resolved = first.replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/, ROOT);
        out.push({ event, command: hook.command, path: resolved });
      }
    }
  }
  return out;
}

const commands = declaredCommands();

describe('shipped hooks', () => {
  test('the manifest declares the two events the product documents', () => {
    // Not a style check: `SessionStart` is how a resuming agent learns what it missed, and
    // `UserPromptSubmit` is how it learns mid-session. Losing either silently halves delivery.
    expect(Object.keys(manifest.hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(commands.length).toBeGreaterThan(0);
  });

  test('every script a hook names exists and is executable', () => {
    // npm preserves the executable bit through `npm pack`, so a script committed without it
    // ships unrunnable and the harness reports nothing but a non-zero hook.
    const broken = commands.filter(({ path }) => {
      if (!existsSync(path)) return true;
      try {
        accessSync(path, constants.X_OK);
        return false;
      } catch {
        return true;
      }
    });
    expect(
      broken.map((c) => `${c.event}: ${c.command}`),
      'hook commands that do not resolve to an executable file'
    ).toEqual([]);
  });

  test('every script a hook names is shipped by `files`', () => {
    // `hooks/` being in `files` is the only reason any of this reaches a user. A script placed
    // outside a shipped path works in the repo and is absent from the installed package.
    const shipped = new Set(pkg.files);
    const unshipped = commands.filter(({ path }) => {
      const top = relative(ROOT, path).split('/')[0];
      return !shipped.has(top);
    });
    expect(
      unshipped.map((c) => relative(ROOT, c.path)),
      'referenced by hooks.json but not under any package.json `files` entry'
    ).toEqual([]);
  });

  test('every script a hook names parses', () => {
    // `bash -n` is the cheapest possible proof that a shell script is not gibberish, and it is
    // more than this file had before.
    for (const { path } of commands) {
      expect(() => execFileSync('bash', ['-n', path], { stdio: 'pipe' }), path).not.toThrow();
    }
  });

  test('the inbox hook is the script both events run', () => {
    expect(commands.map((c) => c.path)).toEqual([HOOK_SCRIPT, HOOK_SCRIPT]);
  });
});

describe('the inbox hook agrees with the CLI it drives', () => {
  test('every long option it passes is one the CLI declares', () => {
    // This is the assertion that would have caught `--since-last`, which was passed for the
    // whole of v0.3 and does not exist. Comments are stripped first: the header names the dead
    // flag deliberately.
    const declared = new Set();
    const program = buildProgram();
    for (const option of program.options) if (option.long) declared.add(option.long);
    for (const command of program.commands) {
      for (const option of command.options) if (option.long) declared.add(option.long);
    }

    const passed = [...new Set(body.match(/--[a-z][a-z0-9-]*/g) ?? [])];
    expect(passed.length, 'the hook should still be invoking the CLI').toBeGreaterThan(0);
    expect(
      passed.filter((flag) => !declared.has(flag)),
      'options the hook passes that `collabcast --help` does not declare'
    ).toEqual([]);
  });

  test('it reads the inbox and does not acknowledge it', () => {
    // `GET /inbox` is non-mutating and acknowledgement is a separate act. A hook fires whether
    // or not the model ever attends to what it injected, so acking here would record
    // non-delivery as acknowledgement — the failure the v0.3 cursor rework existed to remove.
    expect(body).toMatch(/\binbox\b/);
    expect(body, 'a hook must not move a cursor').not.toMatch(/\back\b/);
    expect(body).not.toMatch(/cursor/);
  });

  test('its unavailable-exit constant matches the CLI', () => {
    // A constant duplicated in bash with nothing proving the copies agree is how this project
    // has been bitten before. Duplication is fine; unasserted duplication is not.
    const declared = body.match(/^EXIT_UNAVAILABLE=(\d+)$/m);
    expect(declared, 'the hook should name the exit code it treats as "service not running"')
      .not.toBeNull();
    expect(Number(declared[1])).toBe(EXIT_UNAVAILABLE);
  });

  test('it reads no runtime artifact, so a stale one cannot change its behaviour', () => {
    // The original fault: gating on `.collabcast/server.port`, which v0.3 never writes. Readiness
    // is the CLI's answer now, not a file this script stats. `collabcast.pid` is equally
    // off-limits — it outlives the process it names.
    expect(body, 'server.port is a v0.2 artifact v0.3 never creates').not.toMatch(/server\.port/);
    expect(body, 'a pid file is not evidence that a service is answering').not.toMatch(
      /collabcast\.pid/
    );
    expect(body, 'a socket file on disk is not evidence that anything is listening').not.toMatch(
      /\.sock/
    );
  });

  test('it does not blanket-swallow failures', () => {
    // `2>/dev/null || true` made a broken hook, a missing binary and a rejected credential all
    // indistinguishable from an empty inbox. Both halves of that idiom are banned outright.
    expect(body).not.toMatch(/2>\s*\/dev\/null/);
    expect(body).not.toMatch(/\|\|\s*true/);
  });
});
