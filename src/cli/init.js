// src/cli/init.js
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { isValidOperatorName } from '../core/validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../templates/channel.md');

function gitUserName(cwd) {
  try {
    const out = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const trimmed = out.trim();
    if (!trimmed) return null;
    if (!isValidOperatorName(trimmed)) {
      console.error('(git config user.name is invalid; falling back)');
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function osUsername() {
  try {
    const name = userInfo().username;
    if (!name) return null;
    if (!isValidOperatorName(name)) {
      console.error('(OS username is invalid; falling back)');
      return null;
    }
    return name;
  } catch {
    return null;
  }
}

function inferOperator(cwd) {
  const fromGit = gitUserName(cwd);
  if (fromGit) return { value: fromGit, source: 'git config user.name' };
  const fromOs = osUsername();
  if (fromOs) return { value: fromOs, source: 'OS username' };
  return null;
}

export async function initCommand({ operator, name, force }) {
  const projectRoot = process.cwd();
  const wt = join(projectRoot, '.walkie-talkie');
  if (existsSync(wt) && !force) {
    console.error('.walkie-talkie/ already exists. Use --force to reinitialize.');
    process.exit(1);
  }
  let operatorName = operator;
  let operatorSource = 'flag';
  if (operatorName) {
    if (!isValidOperatorName(operatorName)) {
      console.error("invalid --operator value: contains forbidden characters or exceeds 80 chars; please pass a name matching letters/numbers/spaces/._'-");
      process.exit(1);
    }
  } else {
    const inferred = inferOperator(projectRoot);
    if (!inferred) {
      console.error('Could not infer operator name (no valid git config user.name and no valid OS username). Pass --operator <name>.');
      process.exit(1);
    }
    operatorName = inferred.value;
    operatorSource = inferred.source;
  }
  await mkdir(wt, { recursive: true });
  await mkdir(join(wt, '.sessions'), { recursive: true });
  await mkdir(join(wt, 'logs'), { recursive: true });
  const projectName = name || basename(projectRoot);
  const template = (await readFile(TEMPLATE_PATH, 'utf8'))
    .replace('PROJECT_NAME', projectName)
    .replace('OPERATOR_NAME', operatorName)
    .replace('CREATED_AT', new Date().toISOString());
  await writeFile(join(wt, 'channel.md'), template);
  await writeFile(
    join(wt, 'config.json'),
    JSON.stringify({ operator: operatorName, projectName, permits: [] }, null, 2)
  );
  const sourceNote = operatorSource === 'flag' ? '' : ` (inferred from ${operatorSource})`;
  console.log(`Initialized walkie-talkie channel for "${projectName}" with operator "${operatorName}"${sourceNote}.`);
  console.log(`Next: walkie start`);
}
