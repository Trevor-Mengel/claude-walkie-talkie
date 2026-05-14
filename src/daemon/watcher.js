import chokidar from 'chokidar';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { isInternalWrite } from '../core/channel.js';

export async function startWatcher({ wtDir, events }) {
  const channelPath = join(wtDir, 'channel.md');
  const watcher = chokidar.watch(channelPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 }
  });
  watcher.on('change', (path) => {
    if (isInternalWrite(path)) return;
    const stat = statSync(path);
    events.emit('channel.external_edit', { mtime: stat.mtime.toISOString(), size: stat.size });
  });
  return () => watcher.close();
}
