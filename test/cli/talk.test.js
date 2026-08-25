// `collabcast talk`, driven as a real subprocess against a real service.
//
// Both v0.2 properties survive in spirit, and one of them had to change shape:
//
//   - "posts a broadcast (verified by reading channel.md)" is preserved verbatim, and tightened:
//     the rendered author must be the operator PRINCIPAL. v0.2's CLI sent `fromSessionId:
//     'operator', fromAlias: opts.as, fromTool: 'operator'` in the request body, so the author
//     line was whatever the caller typed and `--as` let the operator post under anyone's alias.
//     Authorship is now derived from the operator capability, so the assertion is about a
//     principal id rather than a string.
//   - "warns about unresolved @mentions and skips invite when --no-invite" keeps the warning half
//     and inverts the flag half: invitations are gone, so there is no invite to skip and
//     `--no-invite` must not exist. An unresolved mention is now information, not a prompt.
//
// The first test boots the service as a real `collabcast-svc` child process rather than in-process:
// two real processes and a Unix socket between them is the shape an operator actually runs, and
// nothing else in this file's slice covers `daemon-entry.js` coming up from its cwd alone.

import { describe, test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStack } from '../helpers/stack.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'collabcast.js');

function collabcast(args, { cwd, env }) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

async function harness(namespace, opts = {}) {
  const stack = await createStack({ namespace, roles: ['root', 'operator'], ...opts });
  stack.writeCredential('operator');
  return {
    stack,
    run: (args) => collabcast(args, { cwd: stack.canonicalRoot, env: stack.childEnv() })
  };
}

describe('collabcast talk', () => {
  test('posts a broadcast through a real collabcast-svc process, verified by reading channel.md', async () => {
    const { stack, run } = await harness('collabcast-clitalk1', { spawn: true });

    const posted = await run(['talk', 'hello', 'from', 'the', 'cli']);
    expect(posted.stderr).toBe('');
    expect(posted.code).toBe(0);
    expect(posted.stdout).toMatch(/^Posted [0-9A-Z]{26}\n$/);

    const text = readFileSync(stack.channelPath, 'utf8');
    expect(text).toContain('hello from the cli');
  }, 30000);

  test('the rendered author is the operator principal, not a string the caller chose', async () => {
    const { stack, run } = await harness('collabcast-clitalk2');
    const operatorId = stack.principals.operator.principalId;

    const renamed = await run(['rename', 'trev']);
    expect(renamed.code).toBe(0);

    const posted = await run(['talk', 'signed, the operator']);
    expect(posted.code).toBe(0);
    const id = posted.stdout.trim().replace('Posted ', '');

    const text = readFileSync(stack.channelPath, 'utf8');
    // The marker's `from` is the principal id: ownership survives a rename. The alias is not
    // in the marker at all — it is presentation, rendered into the heading and parsed back out
    // — which is exactly why a rename cannot reassign authorship.
    expect(text).toMatch(new RegExp(`from=${operatorId}\\b`));
    expect(text).toMatch(/^## .*trev → all$/m);
    // v0.2 wrote the literal string `operator` here. Nothing may claim that any more.
    expect(text).not.toMatch(/from=operator\b/);

    const fetched = await stack.request('GET', `/channel/message/${id}`, {
      token: stack.tokens.root
    });
    expect(fetched.body.message.fromSessionId).toBe(operatorId);
    expect(fetched.body.message.fromAlias).toBe('trev');
    expect(fetched.body.message.fromTool).toBe('operator');
  }, 20000);

  test('warns about unresolved @mentions, and --no-invite no longer exists', async () => {
    const { stack, run } = await harness('collabcast-clitalk3');

    const out = await run(['talk', 'hey @ghost']);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('Posted');
    expect(out.stdout).toContain('@ghost');
    expect(out.stdout).toMatch(/is not a principal on this channel/);

    // The message posted anyway: a dangling mention is information, not a refusal.
    expect(readFileSync(stack.channelPath, 'utf8')).toContain('hey @ghost');

    // Invitations are gone, so there is no flag to skip them with.
    const flagged = await run(['talk', '--no-invite', 'hey @ghost']);
    expect(flagged.code).not.toBe(0);
    expect(flagged.stderr).toMatch(/unknown option/i);
    expect(flagged.stderr).not.toMatch(/^\s+at /m);

    // And no principal was conjured for `@ghost`.
    const roster = await stack.request('GET', '/principals', { token: stack.tokens.root });
    expect(roster.body.principals.some((p) => p.displayAlias === 'ghost')).toBe(false);
  }, 20000);

  test('--as is gone, so an operator cannot post under another principal\'s alias', async () => {
    const { stack, run } = await harness('collabcast-clitalk4');
    await run(['rename', 'trev']);

    const help = await run(['help', 'talk']);
    expect(help.stdout).not.toContain('--as');

    const attempt = await run(['talk', '--as', 'root', 'not me']);
    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toMatch(/unknown option/i);
    expect(readFileSync(stack.channelPath, 'utf8')).not.toContain('not me');
  }, 20000);

  test('--type is honoured and an unknown type is refused without writing', async () => {
    const { stack, run } = await harness('collabcast-clitalk5');

    const question = await run(['talk', '--type', 'question', 'is this a question?']);
    expect(question.code).toBe(0);
    const id = question.stdout.trim().replace('Posted ', '');
    const fetched = await stack.request('GET', `/channel/message/${id}`, {
      token: stack.tokens.root
    });
    expect(fetched.body.message.type).toBe('question');

    const bogus = await run(['talk', '--type', 'decree', 'obey']);
    // `invalid_request` is a caller mistake, not a refusal of authority, so it is exit 1 —
    // only the DENIED_CODES family maps to 2.
    expect(bogus.code).toBe(1);
    expect(bogus.stderr).toMatch(/^collabcast \[invalid_request]/);
    expect(readFileSync(stack.channelPath, 'utf8')).not.toContain('obey');
  }, 20000);

  test('without an operator credential the CLI refuses instead of posting anonymously', async () => {
    const stack = await createStack({ namespace: 'collabcast-clitalk6', roles: ['root'] });
    const attempt = await collabcast(['talk', 'let me in'], {
      cwd: stack.canonicalRoot,
      env: stack.childEnv()
    });
    expect(attempt.code).toBe(2);
    expect(attempt.stdout).toBe('');
    expect(attempt.stderr).toMatch(/^collabcast \[/);
    expect(attempt.stderr).not.toMatch(/^\s+at /m);
    expect(readFileSync(stack.channelPath, 'utf8')).not.toContain('let me in');
  }, 20000);
});
