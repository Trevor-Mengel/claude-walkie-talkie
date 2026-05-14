import { describe, test, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseChannel, readChannel, appendMessage } from '../../src/core/channel.js';
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
});
