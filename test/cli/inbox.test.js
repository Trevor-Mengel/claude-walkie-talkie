import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';
import { spawnDaemon, stopDaemon } from '../helpers/spawn-daemon.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'bin', 'walkie.js');
const runCli = promisify(execFile);

describe('walkie inbox', () => {
  let project, daemon;
  beforeEach(async () => { project = createTmpProject(); daemon = await spawnDaemon(project.wtDir); });
  afterEach(async () => { await stopDaemon(daemon); cleanup(project); });

  test('--format=json returns empty messages when no traffic', async () => {
    const { stdout } = await runCli(process.execPath, [CLI, 'inbox', '--format=json'], { cwd: project.root });
    const parsed = JSON.parse(stdout);
    expect(parsed.messages).toEqual([]);
  });

  test('--format=context prints a hookable preamble', async () => {
    const { clientForProject } = await import('../../src/cli/client.js');
    const client = clientForProject(project.root);
    await client.post({ body: 'hello hooks', fromSessionId: 'operator', fromAlias: 'operator', fromTool: 'operator' });
    const { stdout } = await runCli(process.execPath, [CLI, 'inbox', '--format=context'], { cwd: project.root });
    expect(stdout).toMatch(/walkie-talkie inbox/i);
    expect(stdout).toMatch(/hello hooks/);
  });
});
