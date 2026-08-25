import { describe, test, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { createEvents } from '../../src/daemon/events.js';
import { startWatcher } from '../../src/daemon/watcher.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
let stop;
afterEach(async () => {
  if (stop) await stop();
  stop = null;
  if (project) cleanup(project);
  project = null;
});

describe('watcher', () => {
  test('emits channel.external_edit when channel.md changes outside collabcast-core', async () => {
    project = createTmpProject();
    const events = createEvents();
    const got = new Promise((resolve) => events.once('channel.external_edit', resolve));
    stop = await startWatcher({ wtDir: project.wtDir, events });
    await new Promise((r) => setTimeout(r, 100));
    const text = readFileSync(project.channelPath, 'utf8');
    writeFileSync(project.channelPath, text + '\nhand-edit\n');
    const payload = await Promise.race([
      got,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))
    ]);
    expect(payload).toHaveProperty('mtime');
  });
});
