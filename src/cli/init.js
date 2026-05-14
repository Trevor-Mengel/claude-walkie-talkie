// src/cli/init.js
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../templates/channel.md');

export async function initCommand({ operator, name, force }) {
  const projectRoot = process.cwd();
  const wt = join(projectRoot, '.walkie-talkie');
  if (existsSync(wt) && !force) {
    console.error('.walkie-talkie/ already exists. Use --force to reinitialize.');
    process.exit(1);
  }
  await mkdir(wt, { recursive: true });
  await mkdir(join(wt, '.sessions'), { recursive: true });
  await mkdir(join(wt, 'logs'), { recursive: true });
  const projectName = name || basename(projectRoot);
  const template = (await readFile(TEMPLATE_PATH, 'utf8'))
    .replace('PROJECT_NAME', projectName)
    .replace('OPERATOR_NAME', operator)
    .replace('CREATED_AT', new Date().toISOString());
  await writeFile(join(wt, 'channel.md'), template);
  await writeFile(
    join(wt, 'config.json'),
    JSON.stringify({ operator, projectName, permits: [] }, null, 2)
  );
  console.log(`Initialized walkie-talkie channel for "${projectName}" with operator "${operator}".`);
  console.log(`Next: walkie start`);
}
