// test/cli/talk.test.js
import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnDaemon } from '../helpers/spawn-daemon.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../../bin/walkie.js');

let project;
let daemon;
afterEach(async () => {
  if (daemon?.child) {
    daemon.child.kill();
    await new Promise((r) => setTimeout(r, 50));
  }
  if (project) cleanup(project);
  project = null;
  daemon = null;
});

describe('walkie talk', () => {
  test('walkie talk posts a broadcast (verified by reading channel.md)', async () => {
    project = createTmpProject();
    daemon = await spawnDaemon(project.wtDir);
    execFileSync(process.execPath, [BIN, 'talk', 'hello from the cli'], { cwd: project.root });
    const text = readFileSync(project.channelPath, 'utf8');
    expect(text).toContain('hello from the cli');
  });

  test('walkie talk warns about unresolved @mentions and skips invite when --no-invite', async () => {
    project = createTmpProject();
    daemon = await spawnDaemon(project.wtDir);
    const out = execFileSync(
      process.execPath,
      [BIN, 'talk', '--no-invite', 'hey @ghost'],
      { cwd: project.root, encoding: 'utf8' }
    );
    expect(out).toContain('Posted');
    expect(out).toContain('@ghost');
  });
});
