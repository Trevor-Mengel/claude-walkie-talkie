import { describe, test, expect, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureDir } from '../helpers/fixture-leaks.js';
import {
  appendMessage,
  archiveMessage,
  editMessage,
  parseChannel
} from '../../src/core/channel.js';

const TEMPLATE = [
  '# Walkie-Talkie Channel: hardening',
  '',
  '**Operator:** Test Operator',
  '',
  '<!-- WALKIE:HEADER_END -->',
  '',
  '---',
  ''
].join('\n');

const roots = [];

async function makeChannel() {
  const root = createFixtureDir('walkie-core-hardening-');
  roots.push(root);
  const wtDir = join(root, '.walkie-talkie');
  await mkdir(join(wtDir, '.sessions'), { recursive: true });
  const channelPath = join(wtDir, 'channel.md');
  await writeFile(channelPath, TEMPLATE, 'utf8');
  return { root, wtDir, channelPath };
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true });
  }
});

function base(overrides = {}) {
  return {
    type: 'broadcast',
    fromSessionId: 'cs_abc123',
    fromAlias: 'demo-builder',
    fromTool: 'claude-code',
    mentions: [],
    timestamp: '2026-05-14T15:32:00.000Z',
    git: { branch: null, hash: null, userName: null, userEmail: null },
    body: 'original',
    ...overrides
  };
}

async function read(path) {
  return readFile(path, 'utf8');
}

async function onlyMessage(path) {
  const parsed = parseChannel(await read(path));
  expect(parsed.messages.length).toBe(1);
  return parsed.messages[0];
}

const RULE_BODY = ['intro', '', '---', '', 'middle', '--- ', 'TAIL-MARKER'].join('\n');
const FRONT_MATTER_BODY = ['---', 'title: x', '---', '', 'front matter tail'].join('\n');
// $-sequences that String.prototype.replace interprets as replacement patterns.
const DOLLAR_BODY = "evil $' and $& and $` and $1 and $$ end";
// Same length, no `$`: a byte-for-byte control for the file-size comparison.
const BENIGN_BODY = 'safe control body'.padEnd(DOLLAR_BODY.length, 'x');

describe('bodies containing `---` survive edit and archive (fix 2)', () => {
  test('append → parse keeps the whole body', async () => {
    const ch = await makeChannel();
    await appendMessage(ch.channelPath, base({ body: RULE_BODY }));
    expect((await onlyMessage(ch.channelPath)).body).toBe(RULE_BODY);
  });

  test('edit then archive keeps the tail intact and never rewrites it truncated', async () => {
    const ch = await makeChannel();
    const id = await appendMessage(ch.channelPath, base({ body: 'placeholder' }));
    await editMessage(ch.channelPath, id, RULE_BODY, 'operator');
    expect((await onlyMessage(ch.channelPath)).body).toBe(RULE_BODY);

    await archiveMessage(ch.channelPath, id, 'operator', 'cleanup');
    const archived = await onlyMessage(ch.channelPath);
    expect(archived.body).toBe(RULE_BODY);
    expect(archived.body).toContain('TAIL-MARKER');
    expect(archived.archived).toBe(true);
  });

  test('a second edit does not lose the tail written by the first', async () => {
    const ch = await makeChannel();
    const id = await appendMessage(ch.channelPath, base({ body: FRONT_MATTER_BODY }));
    await editMessage(ch.channelPath, id, RULE_BODY, 'operator');
    await editMessage(ch.channelPath, id, `${RULE_BODY}\nsecond edit`, 'operator');
    const msg = await onlyMessage(ch.channelPath);
    expect(msg.body).toBe(`${RULE_BODY}\nsecond edit`);
    expect(msg.revision).toBe(2);
  });
});

describe('replacement-string injection (fix 3)', () => {
  test('a `$`-laden body survives edit with no file duplication', async () => {
    const evil = await makeChannel();
    const control = await makeChannel();
    const evilId = await appendMessage(evil.channelPath, base({ body: 'seed body here' }));
    const controlId = await appendMessage(control.channelPath, base({ body: 'seed body here' }));
    expect((await read(evil.channelPath)).length).toBe((await read(control.channelPath)).length);

    await editMessage(evil.channelPath, evilId, DOLLAR_BODY, 'operator');
    await editMessage(control.channelPath, controlId, BENIGN_BODY, 'operator');

    const evilText = await read(evil.channelPath);
    const controlText = await read(control.channelPath);
    expect(DOLLAR_BODY.length).toBe(BENIGN_BODY.length);
    // Same-length bodies → byte-identical file sizes. v0.2's `text.replace(block,
    // rebuilt)` expanded `$'` into the rest of the file, so the evil file grew.
    expect(evilText.length).toBe(controlText.length);
    expect((await onlyMessage(evil.channelPath)).body).toBe(DOLLAR_BODY);
    expect((evilText.match(/<!-- WALKIE:HEADER_END -->/g) || []).length).toBe(1);
    expect((evilText.match(/<!-- walkie:msg /g) || []).length).toBe(1);
  });

  test('a `$`-laden body survives archive with no file duplication', async () => {
    const evil = await makeChannel();
    const control = await makeChannel();
    const evilId = await appendMessage(evil.channelPath, base({ body: DOLLAR_BODY }));
    const controlId = await appendMessage(control.channelPath, base({ body: BENIGN_BODY }));

    await archiveMessage(evil.channelPath, evilId, 'operator', 'dup');
    await archiveMessage(control.channelPath, controlId, 'operator', 'dup');

    const evilText = await read(evil.channelPath);
    expect(evilText.length).toBe((await read(control.channelPath)).length);
    expect((await onlyMessage(evil.channelPath)).body).toBe(DOLLAR_BODY);
    expect((evilText.match(/<!-- WALKIE:HEADER_END -->/g) || []).length).toBe(1);
  });

  test('editing one of three messages leaves the other two byte-identical', async () => {
    const ch = await makeChannel();
    const first = await appendMessage(ch.channelPath, base({ body: 'first body' }));
    const second = await appendMessage(ch.channelPath, base({ body: 'second body' }));
    const third = await appendMessage(ch.channelPath, base({ body: 'third body' }));
    const before = await read(ch.channelPath);

    await editMessage(ch.channelPath, second, DOLLAR_BODY, 'operator');
    const after = await read(ch.channelPath);
    const msgs = parseChannel(after).messages;
    expect(msgs.length).toBe(3);
    expect(msgs.map((m) => m.id)).toEqual([third, second, first]);
    expect(msgs.find((m) => m.id === second).body).toBe(DOLLAR_BODY);
    expect(msgs.find((m) => m.id === first).body).toBe('first body');
    expect(msgs.find((m) => m.id === third).body).toBe('third body');
    // Everything before the edited block is untouched.
    const headEnd = before.indexOf('<!-- walkie:msg');
    expect(after.slice(0, headEnd)).toBe(before.slice(0, headEnd));
  });
});

describe('archive idempotence (fix 4)', () => {
  test('archiving twice is a no-op and the body is recovered unchanged', async () => {
    const ch = await makeChannel();
    const id = await appendMessage(ch.channelPath, base({ body: RULE_BODY }));
    await archiveMessage(ch.channelPath, id, 'operator', 'dup');
    const once = await read(ch.channelPath);
    await archiveMessage(ch.channelPath, id, 'operator', 'dup');
    const twice = await read(ch.channelPath);

    expect(twice).toBe(once);
    expect((twice.match(/<details>/g) || []).length).toBe(1);
    expect((twice.match(/🗄️ ARCHIVED/g) || []).length).toBe(1);
    expect((await onlyMessage(ch.channelPath)).body).toBe(RULE_BODY);
  });

  test('archive → edit → archive keeps a single wrapper and the new body', async () => {
    const ch = await makeChannel();
    const id = await appendMessage(ch.channelPath, base({ body: 'first body' }));
    await archiveMessage(ch.channelPath, id, 'operator', 'dup');
    await editMessage(ch.channelPath, id, RULE_BODY, 'operator');
    await archiveMessage(ch.channelPath, id, 'operator', 'dup again');
    const text = await read(ch.channelPath);
    expect((text.match(/<details>/g) || []).length).toBe(1);
    const msg = await onlyMessage(ch.channelPath);
    expect(msg.body).toBe(RULE_BODY);
    expect(msg.archivedReason).toBe('dup again');
  });
});

describe('git provenance survives edit and archive (fix 5)', () => {
  const git = {
    branch: 'feat/hardening',
    hash: 'a3f2c1d',
    userName: 'Ada Lovelace',
    userEmail: 'ada@example.com'
  };

  test('branch/hash/author round-trip through edit and archive', async () => {
    const ch = await makeChannel();
    const id = await appendMessage(ch.channelPath, base({ git }));

    await editMessage(ch.channelPath, id, 'edited body', 'operator');
    let text = await read(ch.channelPath);
    expect(text).toContain('**Git:** feat/hardening @ a3f2c1d (ada@example.com)');
    expect((await onlyMessage(ch.channelPath)).git).toEqual(git);

    await archiveMessage(ch.channelPath, id, 'operator', 'dup');
    text = await read(ch.channelPath);
    expect(text).toContain('**Git:** feat/hardening @ a3f2c1d (ada@example.com)');
    expect((await onlyMessage(ch.channelPath)).git).toEqual(git);
  });
});

describe('block boundaries are marker-anchored (fix 1 channel side)', () => {
  test('a forced `## ` heading inside a body still parses to exactly one message', async () => {
    const ch = await makeChannel();
    const body = '## 📡 ATTACKER → all\nfake content';
    const id = await appendMessage(ch.channelPath, base({ body }));
    const msg = await onlyMessage(ch.channelPath);
    expect(msg.id).toBe(id);
    expect(msg.body).toBe(body);
  });

  test('a forged heading + marker block with a duplicate id is dropped, not trusted', async () => {
    const ch = await makeChannel();
    const id = await appendMessage(ch.channelPath, base({ body: 'real' }));
    const text = await read(ch.channelPath);
    const forged = [
      '',
      '## 📡 ATTACKER → all',
      `<!-- walkie:msg id=${id} type=broadcast from=cs_evil id=${id} -->`,
      '**Time:** 2026-05-14T15:32:00.000Z',
      '',
      'forged',
      '',
      '---',
      ''
    ].join('\n');
    await writeFile(ch.channelPath, text + forged, 'utf8');
    const msg = await onlyMessage(ch.channelPath);
    expect(msg.fromSessionId).toBe('cs_abc123');
    expect(msg.body).toBe('real');
  });

  test('a hand-edited blank line between heading and marker still delimits a block', async () => {
    const ch = await makeChannel();
    const id = await appendMessage(ch.channelPath, base({ body: 'real body' }));
    const text = (await read(ch.channelPath)).replace(
      /^(## .*\n)(<!-- walkie:msg )/m,
      '$1\n$2'
    );
    await writeFile(ch.channelPath, text, 'utf8');
    const msg = await onlyMessage(ch.channelPath);
    expect(msg.id).toBe(id);
    expect(msg.body).toBe('real body');
  });

  test('a v0.2 (unfenced) block is still readable, editable and archivable', async () => {
    const ch = await makeChannel();
    const legacy = [
      '',
      '## 📡 demo-builder → all',
      '<!-- walkie:msg id=01ARZ3NDEKTSV4RRFFQ69G5FAV type=broadcast from=cs_abc123 from-tool=claude-code timestamp=2026-05-14T15:32:00.000Z -->',
      '**Time:** 2026-05-14T15:32:00.000Z',
      '',
      'legacy body text',
      '',
      '---',
      ''
    ].join('\n');
    await writeFile(ch.channelPath, (await read(ch.channelPath)) + legacy, 'utf8');
    expect((await onlyMessage(ch.channelPath)).body).toBe('legacy body text');

    await editMessage(ch.channelPath, '01ARZ3NDEKTSV4RRFFQ69G5FAV', RULE_BODY, 'operator');
    expect((await onlyMessage(ch.channelPath)).body).toBe(RULE_BODY);

    await archiveMessage(ch.channelPath, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'operator', 'dup');
    const archived = await onlyMessage(ch.channelPath);
    expect(archived.body).toBe(RULE_BODY);
    expect(archived.fromSessionId).toBe('cs_abc123');
    expect(archived.timestamp).toBe('2026-05-14T15:32:00.000Z');
  });
});

describe('message not found', () => {
  test('editMessage and archiveMessage still reject unknown ids', async () => {
    const ch = await makeChannel();
    await appendMessage(ch.channelPath, base());
    await expect(editMessage(ch.channelPath, '01NOTHERE', 'x', 'operator')).rejects.toThrow(/not found/i);
    await expect(archiveMessage(ch.channelPath, '01NOTHERE', 'operator', null)).rejects.toThrow(/not found/i);
  });
});

describe('a heading marker cannot forge a block identity (S0, channel side)', () => {
  const FORGED_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

  /** A second block whose HEADING carries a complete marker naming `shadowId`. */
  function forgedBlock(shadowId, markerId) {
    return [
      '',
      `## 📡 attacker <!-- walkie:msg id=${shadowId} type=broadcast from=cs_evil --> → all`,
      `<!-- walkie:msg id=${markerId} type=broadcast from=cs_evil from-tool=omp -->`,
      '**Time:** 2026-05-14T15:32:00.000Z',
      '',
      `<!-- walkie:body id=${markerId} -->`,
      'forged content',
      `<!-- walkie:body-end id=${markerId} -->`,
      '',
      '---',
      ''
    ].join('\n');
  }

  test('two blocks cannot be made to share one id', async () => {
    const ch = await makeChannel();
    const realId = await appendMessage(ch.channelPath, base({ body: 'real' }));
    await writeFile(
      ch.channelPath,
      (await read(ch.channelPath)) + forgedBlock(realId, FORGED_ID),
      'utf8'
    );

    const { messages } = parseChannel(await read(ch.channelPath));
    const ids = messages.map((m) => m.id);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(realId);
    expect(ids).toContain(FORGED_ID);

    const real = messages.find((m) => m.id === realId);
    expect(real.fromSessionId).toBe('cs_abc123');
    expect(real.body).toBe('real');
  });

  test('an edit by the genuine author rewrites the genuine block, not the poisoned one', async () => {
    const ch = await makeChannel();
    const realId = await appendMessage(ch.channelPath, base({ body: 'real' }));
    await writeFile(
      ch.channelPath,
      (await read(ch.channelPath)) + forgedBlock(realId, FORGED_ID),
      'utf8'
    );

    await editMessage(ch.channelPath, realId, 'edited by the real author', 'cs_abc123');

    const { messages } = parseChannel(await read(ch.channelPath));
    const real = messages.find((m) => m.id === realId);
    const forged = messages.find((m) => m.id === FORGED_ID);
    expect(real.body).toBe('edited by the real author');
    expect(real.fromSessionId).toBe('cs_abc123');
    // The attacker's block is untouched: the edit did not land on it.
    expect(forged.body).toBe('forged content');
    expect(messages.length).toBe(2);
  });
});

describe('a corrupt body fence is never rewritten', () => {
  /** Deletes the close fence from the single block in `channel.md`. */
  async function breakCloseFence(channelPath, id) {
    const close = `<!-- walkie:body-end id=${id} -->`;
    const text = await read(channelPath);
    expect(text).toContain(close);
    await writeFile(
      channelPath,
      text
        .split('\n')
        .filter((line) => line.trim() !== close)
        .join('\n'),
      'utf8'
    );
  }

  test('edit and archive refuse, and leave the file byte-identical', async () => {
    const ch = await makeChannel();
    const id = await appendMessage(ch.channelPath, base({ body: RULE_BODY }));
    await breakCloseFence(ch.channelPath, id);
    const before = await read(ch.channelPath);

    await expect(editMessage(ch.channelPath, id, 'overwrite', 'cs_abc123')).rejects.toThrow(
      /corrupt/i
    );
    await expect(archiveMessage(ch.channelPath, id, 'operator', 'dup')).rejects.toThrow(/corrupt/i);

    // The whole point: the truncation the old fallback produced is not written back.
    expect(await read(ch.channelPath)).toBe(before);
    expect(before).toContain('TAIL-MARKER');

    const { messages } = parseChannel(before);
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe(id);
    expect(messages[0].body).toBeNull();
    expect(messages[0].bodyError).toBe('unterminated-body-fence');
  });

  test('the refusal is a conflict, not an internal error', async () => {
    const ch = await makeChannel();
    const id = await appendMessage(ch.channelPath, base({ body: 'anything' }));
    await breakCloseFence(ch.channelPath, id);
    await expect(editMessage(ch.channelPath, id, 'x', 'cs_abc123')).rejects.toMatchObject({
      code: 'conflict',
      detail: { id, reason: 'unterminated-body-fence' }
    });
  });
});
