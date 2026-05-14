import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export async function logsCommand(opts) {
  const dir = join(process.cwd(), '.walkie-talkie', 'logs');
  if (!existsSync(dir)) {
    console.log('(no logs)');
    return;
  }
  const files = (await readdir(dir)).sort();
  if (!files.length) {
    console.log('(no logs)');
    return;
  }
  const latest = files[files.length - 1];
  const content = await readFile(join(dir, latest), 'utf8');
  if (opts.tail) {
    const lines = content.split('\n');
    console.log(lines.slice(-Number(opts.tail)).join('\n'));
  } else {
    console.log(content);
  }
}
