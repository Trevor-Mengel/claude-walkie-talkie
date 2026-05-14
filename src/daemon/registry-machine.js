import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function registryPath() {
  return join(homedir(), '.walkie-talkie', 'registry.json');
}

async function loadRegistry() {
  const p = registryPath();
  if (!existsSync(p)) return { projects: [] };
  return JSON.parse(await readFile(p, 'utf8'));
}

async function saveRegistry(data) {
  const p = registryPath();
  await mkdir(join(homedir(), '.walkie-talkie'), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2));
}

export async function registerProject({ projectPath, port, pid, projectName }) {
  const r = await loadRegistry();
  r.projects = r.projects.filter((p) => p.projectPath !== projectPath);
  r.projects.push({ projectPath, port, pid, projectName, startedAt: new Date().toISOString() });
  await saveRegistry(r);
}

export async function deregisterProject(projectPath) {
  const r = await loadRegistry();
  r.projects = r.projects.filter((p) => p.projectPath !== projectPath);
  await saveRegistry(r);
}

export async function listProjects() {
  return (await loadRegistry()).projects;
}
