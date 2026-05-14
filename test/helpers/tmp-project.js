import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '../../templates/channel.md');

export function createTmpProject({ operator = 'Test Operator', projectName = 'test-project' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'walkie-proj-'));
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
  return { root, wtDir, channelPath: join(wtDir, 'channel.md') };
}

export function cleanup(project) {
  rmSync(project.root, { recursive: true, force: true });
}
