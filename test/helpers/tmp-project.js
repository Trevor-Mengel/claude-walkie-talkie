import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { assertDisposable } from './isolation.js';
import { createFixtureDir } from './fixture-leaks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '../../templates/channel.md');

/**
 * Create a throw-away project checkout with a scaffolded `.walkie-talkie/`.
 *
 * Cleanup is registered with `onTestFinished` (which runs after `afterEach`,
 * so explicit `cleanup(project)` calls still win) so that a throwing
 * `beforeEach` cannot leak the directory. Pass `autoCleanup: false` to opt out.
 */
export function createTmpProject({
  operator = 'Test Operator',
  projectName = 'test-project',
  autoCleanup = true
} = {}) {
  const root = createFixtureDir('walkie-proj-');
  assertDisposable(root, 'tmp project root');
  const wtDir = join(root, '.walkie-talkie');
  mkdirSync(wtDir, { recursive: true });
  mkdirSync(join(wtDir, '.sessions'), { recursive: true });
  mkdirSync(join(wtDir, 'logs'), { recursive: true });
  const template = readFileSync(TEMPLATE_PATH, 'utf8')
    .replace('PROJECT_NAME', projectName)
    .replace('OPERATOR_NAME', operator)
    .replace('CREATED_AT', new Date().toISOString());
  writeFileSync(join(wtDir, 'channel.md'), template);
  writeFileSync(
    join(wtDir, 'config.json'),
    JSON.stringify({ operator, projectName, permits: [] }, null, 2)
  );
  const project = { root, wtDir, channelPath: join(wtDir, 'channel.md') };
  if (autoCleanup) {
    try {
      onTestFinished(() => cleanup(project));
    } catch (_e) {
      // Called outside a test context (e.g. beforeAll); caller owns cleanup.
    }
  }
  return project;
}

export function cleanup(project) {
  if (!project?.root) return;
  assertDisposable(project.root, 'tmp project root');
  rmSync(project.root, { recursive: true, force: true });
}
