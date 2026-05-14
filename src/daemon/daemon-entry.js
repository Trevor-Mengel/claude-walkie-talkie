import { createServer } from './server.js';
import { startWatcher } from './watcher.js';
import { attachNotifier } from './notify.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { registerProject, deregisterProject } from './registry-machine.js';

const wtDir = process.argv[2];
const projectName = process.argv[3] || 'project';

if (!wtDir) {
  console.error('daemon-entry requires wtDir as first arg');
  process.exit(1);
}

const projectPath = wtDir.replace(/\/\.walkie-talkie$/, '');

const { app, events } = createServer({ wtDir });

const server = app.listen(0, async () => {
  const port = server.address().port;
  writeFileSync(join(wtDir, 'server.port'), String(port));
  writeFileSync(join(wtDir, 'server.pid'), String(process.pid));
  await registerProject({ projectPath, port, pid: process.pid, projectName });
  await startWatcher({ wtDir, events });
  attachNotifier({ events, projectName });
});

function shutdown() {
  deregisterProject(projectPath).catch(() => {});
  try { unlinkSync(join(wtDir, 'server.port')); } catch (_e) {}
  try { unlinkSync(join(wtDir, 'server.pid')); } catch (_e) {}
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
