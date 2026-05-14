import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function configCommand(opts) {
  const path = join(process.cwd(), '.walkie-talkie', 'config.json');
  const cfg = JSON.parse(await readFile(path, 'utf8'));
  if (opts.set) {
    const [key, ...rest] = opts.set.split('=');
    const value = rest.join('=');
    if (!key || value === undefined) {
      console.error('Use --set key=value');
      process.exit(1);
    }
    cfg[key] = value;
    await writeFile(path, JSON.stringify(cfg, null, 2));
    console.log(`Set ${key} = ${value}`);
    return;
  }
  console.log(JSON.stringify(cfg, null, 2));
}
