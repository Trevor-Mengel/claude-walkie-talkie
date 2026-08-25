// `walkie inbox`, driven as a real subprocess against a real service.
//
// The two v0.2 properties are preserved: `--format=json` reports an empty queue when there is no
// traffic, and the default `context` format prints a hook-friendly preamble containing the
// message. What changed is everything underneath the assertion:
//
//   - v0.2 seeded the channel with `clientForProject(root).post({ fromSessionId: 'operator',
//     fromAlias: 'operator', fromTool: 'operator' })`. Authorship was a string in a request body
//     that any local process could send. The seed now authenticates with a real capability.
//   - v0.2 spawned the daemon with `spawnDaemon(project.wtDir)` and the CLI reached it through a
//     port file. The CLI now resolves the namespace that owns its cwd and connects to that
//     namespace's Unix socket with the operator credential.
//
// And the property v0.2 had no way to state, because its inbox route consumed the read cursor:
// printing the inbox acknowledges NOTHING. A hook runs `walkie inbox` on every prompt; if that
// advanced a cursor, the operator's queue would be drained by their own tooling.

import { describe, test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStack } from '../helpers/stack.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'walkie.js');

/** Run the CLI and resolve with its outcome, never throwing on a non-zero exit. */
function walkie(args, { cwd, env }) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

/** A stack with an operator credential on disk, which is what the CLI authenticates with. */
async function harness(namespace, opts = {}) {
  const stack = await createStack({ namespace, roles: ['root', 'operator'], ...opts });
  stack.writeCredential('operator');
  return {
    stack,
    run: (args) => walkie(args, { cwd: stack.canonicalRoot, env: stack.childEnv() })
  };
}

async function postAsRoot(stack, body, type) {
  const payload = { body };
  if (type !== undefined) payload.type = type;
  const res = await stack.request('POST', '/channel/message', {
    token: stack.tokens.root,
    body: payload
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('walkie inbox', () => {
  test('--format=json returns empty messages when no traffic', async () => {
    const { run } = await harness('walkie-cliinbox1');
    const { code, stdout, stderr } = await run(['inbox', '--format=json']);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      messages: [],
      mentionedForMe: [],
      lastReadId: '',
      lastAckedId: '',
      // Both views' marks, because acking one does not move the other and a client that
      // cannot see the other one reads its own unread memory-updates as a lost message.
      cursors: {
        default: { lastReadId: '', lastAckedId: '' },
        withMemoryUpdates: { lastReadId: '', lastAckedId: '' }
      }
    });
  }, 20000);

  test('--format=context prints a hookable preamble', async () => {
    const { stack, run } = await harness('walkie-cliinbox2');
    await postAsRoot(stack, 'hello hooks');

    const { code, stdout } = await run(['inbox', '--format=context']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/walkie-talkie inbox/i);
    expect(stdout).toMatch(/hello hooks/);
    // The preamble names the explicit follow-up rather than implying the read did it,
    // and names the id of the last message shown rather than the current cursor.
    expect(stdout).toMatch(/walkie ack 0[0-9A-HJKMNP-TV-Z]{25}/);
  }, 20000);

  // The reachability half of the S1 fix. A server-side flag no CLI can set would be a fix
  // whose feature does not exist, so this drives the real subprocess end to end: hidden by
  // default, still there after an ordinary ack, and the printed hint carries the flag so
  // following it lands on the right view's mark rather than the other one.
  test('--include-memory-updates is its own view with its own cursor', async () => {
    const { stack, run } = await harness('walkie-cliinbox4');
    const one = await postAsRoot(stack, 'one');
    const noted = await postAsRoot(stack, 'remember this', 'memory-update');
    const three = await postAsRoot(stack, 'three');
    const operatorId = stack.principals.operator.principalId;

    const plain = JSON.parse((await run(['inbox', '--format=json'])).stdout);
    expect(plain.messages.map((m) => m.id)).toEqual([one, three]);

    // Ack exactly what was shown — the ordinary path, and the one that used to bury
    // `noted` below a single shared mark.
    await run(['ack', three]);
    expect(JSON.parse((await run(['inbox', '--format=json'])).stdout).messages).toEqual([]);
    expect(stack.cursors(operatorId)).toEqual({ read: three, ack: three });

    const inclusive = JSON.parse(
      (await run(['inbox', '--format=json', '--include-memory-updates'])).stdout
    );
    expect(inclusive.messages.map((m) => m.id)).toContain(noted);
    expect(inclusive.cursors).toEqual({
      default: { lastReadId: three, lastAckedId: three },
      withMemoryUpdates: { lastReadId: '', lastAckedId: '' }
    });

    // The hint has to carry the flag: without it the operator would ack the default view
    // again and the memory-updates just printed would stay unacknowledged forever.
    const hint = await run(['inbox', '--include-memory-updates']);
    expect(hint.stdout).toContain(`walkie ack ${three} --include-memory-updates`);

    await run(['ack', three, '--include-memory-updates']);
    expect(
      JSON.parse((await run(['inbox', '--format=json', '--include-memory-updates'])).stdout).messages
    ).toEqual([]);
  }, 30000);

  test('printing the inbox acknowledges nothing: two runs are identical', async () => {
    const { stack, run } = await harness('walkie-cliinbox3');
    await postAsRoot(stack, 'first');
    await postAsRoot(stack, 'second');
    const operatorId = stack.principals.operator.principalId;

    const first = await run(['inbox', '--format=json']);
    const second = await run(['inbox', '--format=json']);
    const third = await run(['inbox', '--format=context']);

    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout).messages.map((m) => m.body.trim())).toEqual([
      'first',
      'second'
    ]);
    // Byte-identical: not merely non-empty.
    expect(second.stdout).toBe(first.stdout);
    expect(third.stdout).toMatch(/2 message\(s\)/);
    expect(stack.cursors(operatorId)).toEqual({ read: '', ack: '' });

    // `walkie ack` is the only thing that moves it.
    const second_ = JSON.parse(second.stdout).messages[1].id;
    const acked = await run(['ack', second_]);
    expect(acked.code).toBe(0);
    expect(acked.stdout).toMatch(
      new RegExp(`Acknowledged through ${second_} \\(read cursor ${second_}\\)`)
    );
    expect(stack.cursors(operatorId)).toEqual({ read: second_, ack: second_ });

    const after = await run(['inbox', '--format=json']);
    expect(JSON.parse(after.stdout).messages).toEqual([]);
  }, 25000);

  test('--limit caps what is printed without changing what is acknowledged', async () => {
    const { stack, run } = await harness('walkie-cliinbox4');
    for (const body of ['a', 'b', 'c']) await postAsRoot(stack, body);

    const { code, stdout } = await run(['inbox', '--format=json', '--limit', '2']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    // The most recent two, since an inbox is oldest-first and the tail is what matters.
    expect(parsed.messages.map((m) => m.body.trim())).toEqual(['b', 'c']);
    expect(parsed.lastAckedId).toBe('');
    expect(stack.cursors(stack.principals.operator.principalId)).toEqual({ read: '', ack: '' });
  }, 20000);

  test('without an operator credential the CLI refuses cleanly instead of reading anonymously', async () => {
    const stack = await createStack({ namespace: 'walkie-cliinbox5', roles: ['root'] });
    const { code, stdout, stderr } = await walkie(['inbox', '--format=json'], {
      cwd: stack.canonicalRoot,
      env: stack.childEnv()
    });
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^walkie \[/);
    // One line for a human, never a stack trace.
    expect(stderr).not.toMatch(/^\s+at /m);
  }, 20000);
});
