import { describe, test, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChannel } from '../../src/core/channel.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER = join(__dirname, '../helpers/append-worker.js');

function spawnWorker(channelPath, idx) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, channelPath, String(idx)], {
      stdio: 'inherit'
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${idx} exited ${code}`))));
  });
}

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('concurrent append', () => {
  test('10 racing workers all succeed with no torn writes', async () => {
    project = createTmpProject();
    await Promise.all(Array.from({ length: 10 }, (_, i) => spawnWorker(project.channelPath, i)));
    const text = readFileSync(project.channelPath, 'utf8');
    const out = parseChannel(text);
    expect(out.messages.length).toBe(10);
    const ids = new Set(out.messages.map((m) => m.id));
    expect(ids.size).toBe(10);
    expect(text).toContain('<!-- WALKIE:HEADER_END -->');
  }, 30000);
});
