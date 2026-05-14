import { statusDaemon } from '../daemon/lifecycle.js';
import { listProjects } from '../daemon/registry-machine.js';

export async function statusCommand({ all }) {
  if (all) {
    const projects = await listProjects();
    if (!projects.length) {
      console.log('No walkie projects currently running.');
      return;
    }
    for (const p of projects) {
      console.log(`- ${p.projectName} (${p.projectPath}) → http://127.0.0.1:${p.port} pid ${p.pid} since ${p.startedAt}`);
    }
    return;
  }
  const status = await statusDaemon(process.cwd());
  if (!status.running) {
    console.log('Daemon is not running here. Run `walkie start`.');
    return;
  }
  console.log(`Running on http://127.0.0.1:${status.port} (pid ${status.pid}).`);
}
