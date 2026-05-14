import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function tailCommand() {
  const portFile = join(process.cwd(), '.walkie-talkie', 'server.port');
  if (!existsSync(portFile)) {
    console.error('Daemon is not running. Run `walkie start` first.');
    process.exit(1);
  }
  const port = Number(readFileSync(portFile, 'utf8').trim());
  const url = `http://127.0.0.1:${port}/events`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    console.error(`Cannot connect: HTTP ${res.status}`);
    process.exit(1);
  }
  console.log(`Tailing ${url}. Ctrl-C to exit.`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = block.split('\n');
      let event = 'message';
      let data = '';
      for (const l of lines) {
        if (l.startsWith('event: ')) event = l.slice(7);
        else if (l.startsWith('data: ')) data += l.slice(6);
      }
      if (event && !event.startsWith(':')) {
        console.log(`[${event}] ${data}`);
      }
    }
  }
}
