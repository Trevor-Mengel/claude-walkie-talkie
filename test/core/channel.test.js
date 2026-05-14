import { describe, test, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseChannel, readChannel } from '../../src/core/channel.js';
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
