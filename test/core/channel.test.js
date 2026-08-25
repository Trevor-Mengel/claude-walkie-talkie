import { describe, test, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChannel, readChannel, appendMessage, editMessage, archiveMessage } from '../../src/core/channel.js';
import { readHistory } from '../../src/core/history.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('channel parse', () => {
  test('parseChannel returns header text and empty messages for fresh template', () => {
    project = createTmpProject({ projectName: 'cloutdesk', operator: 'Trevor Mengel' });
    const text = readFileSync(project.channelPath, 'utf8');
    const out = parseChannel(text);
    expect(out.header).toContain('Walkie-Talkie Channel: cloutdesk');
    expect(out.header).toContain('Operator:** Trevor Mengel');
    expect(out.headerEndIdx).toBeGreaterThan(0);
    expect(out.messages).toEqual([]);
  });

  test('parseChannel throws when WALKIE:HEADER_END marker is missing', () => {
    expect(() => parseChannel('no marker here')).toThrow(/HEADER_END/);
  });

  test('readChannel reads and parses from a path', async () => {
    project = createTmpProject();
    const out = await readChannel(project.channelPath);
    expect(out.messages).toEqual([]);
  });
});

describe('channel append', () => {
  test('appendMessage inserts a new block immediately below the header marker', async () => {
    project = createTmpProject();
    const msg = {
      id: '01J7QXP9R5K8VYZAB3',
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-14T15:32:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'Hello, world.'
    };
    await appendMessage(project.channelPath, msg);
    const text = readFileSync(project.channelPath, 'utf8');
    const markerIdx = text.indexOf('<!-- WALKIE:HEADER_END -->');
    const blockIdx = text.indexOf('## 👤 Trevor → all');
    expect(blockIdx).toBeGreaterThan(markerIdx);
    expect(text).toContain('Hello, world.');
  });

  test('appendMessage places newer messages above older ones', async () => {
    project = createTmpProject();
    const base = {
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      git: { branch: null, hash: null, userName: null, userEmail: null }
    };
    await appendMessage(project.channelPath, {
      ...base,
      id: 'A',
      timestamp: '2026-05-14T15:30:00.000Z',
      body: 'first'
    });
    await appendMessage(project.channelPath, {
      ...base,
      id: 'B',
      timestamp: '2026-05-14T15:31:00.000Z',
      body: 'second'
    });
    const text = readFileSync(project.channelPath, 'utf8');
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('first'));
  });

  test('appendMessage is atomic (no torn write under cancellation simulation)', async () => {
    project = createTmpProject();
    const msg = {
      id: 'C',
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-14T15:32:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'atomic'
    };
    await appendMessage(project.channelPath, msg);
    const text = readFileSync(project.channelPath, 'utf8');
    expect(text).toContain('<!-- WALKIE:HEADER_END -->');
    expect(text).toContain('atomic');
  });

  // A cursor is a message id, so an id minted below an id already in the channel is a
  // message below every reader's cursor: never delivered, to anyone, with no error. Within
  // one process `monotonicFactory` prevents that; across a restart with a clock that stepped
  // backwards it does not. So the id is minted under the channel write lock and floored on
  // the highest id the file already holds, which makes ordering structural.
  test('a generated id always exceeds the highest id already in the channel', async () => {
    project = createTmpProject();
    const base = {
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-14T15:30:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null }
    };
    // An id far in the future — indistinguishable, to the append path, from a clock that
    // has since been corrected backwards.
    const future = '0K000000000000000000000000';
    await appendMessage(project.channelPath, { ...base, id: future, body: 'from the future' });

    const minted = await appendMessage(project.channelPath, { ...base, body: 'now' });
    expect(minted > future, `${minted} > ${future}`).toBe(true);

    const again = await appendMessage(project.channelPath, { ...base, body: 'later' });
    expect(again > minted, `${again} > ${minted}`).toBe(true);

    const { messages } = await readChannel(project.channelPath);
    expect(messages.map((m) => m.id)).toEqual([again, minted, future]);
  });

  // A block whose marker was corrupted still carries its `id=`, and a reader's cursor may
  // be sitting on it. The floor scan is deliberately wider than the parser for that reason.
  test('a corrupt block still raises the floor for the next id', async () => {
    project = createTmpProject();
    const future = '0K000000000000000000000000';
    await appendMessage(project.channelPath, {
      id: future,
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-14T15:30:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'from the future'
    });
    // Duplicate the id token: the marker no longer parses, so the block vanishes from
    // readChannel while remaining in the file.
    writeFileSync(
      project.channelPath,
      readFileSync(project.channelPath, 'utf8').replace(
        new RegExp(`(<!-- walkie:msg [^\\n]*\\bid=${future}\\b)`),
        `$1 id=${future}`
      ),
      'utf8'
    );
    expect((await readChannel(project.channelPath)).messages).toEqual([]);

    const minted = await appendMessage(project.channelPath, {
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-14T15:31:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'now'
    });
    expect(minted > future, `${minted} > ${future}`).toBe(true);
  });
});

describe('channel edit', () => {
  test('editMessage rewrites body, bumps revision, writes prior body to history', async () => {
    project = createTmpProject();
    const id = await appendMessage(project.channelPath, {
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-14T15:32:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'original body'
    });
    const result = await editMessage(project.channelPath, id, 'updated body', 'operator');
    expect(result.revision).toBe(1);
    const text = readFileSync(project.channelPath, 'utf8');
    expect(text).toContain('updated body');
    expect(text).not.toMatch(/^original body$/m);
    expect(text).toContain(`revision=1`);
    const history = await readHistory(join(project.wtDir, '.sessions'), id);
    expect(history.length).toBe(1);
    expect(history[0].body).toBe('original body');
  });

  test('editMessage throws for unknown message id', async () => {
    project = createTmpProject();
    await expect(
      editMessage(project.channelPath, '01NOTHERE', 'x', 'operator')
    ).rejects.toThrow(/not found/i);
  });
});

describe('channel archive', () => {
  test('archiveMessage marks the marker and inserts ARCHIVED banner', async () => {
    project = createTmpProject();
    const id = await appendMessage(project.channelPath, {
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-14T15:32:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'old content'
    });
    await archiveMessage(project.channelPath, id, 'operator', 'duplicate');
    const fs = await import('node:fs');
    const text = fs.readFileSync(project.channelPath, 'utf8');
    expect(text).toContain('archived=true');
    expect(text).toContain('archived-by=operator');
    expect(text).toContain('archived-reason="duplicate"');
    expect(text).toContain('🗄️ ARCHIVED');
  });

  test('archiveMessage throws for unknown id', async () => {
    project = createTmpProject();
    await expect(
      archiveMessage(project.channelPath, '01NONE', 'operator', null)
    ).rejects.toThrow(/not found/i);
  });
});
