import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function registryRoot() {
  return process.env.WALKIE_HOME || homedir();
}

function registryPath() {
  return join(registryRoot(), '.walkie-talkie', 'registry.json');
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function prune(projects) {
  return projects.filter((p) => pidAlive(p.pid));
}

async function loadRegistry() {
  const p = registryPath();
  if (!existsSync(p)) return { projects: [] };
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return { projects: [] };
  }
}

async function saveRegistry(data) {
  await mkdir(join(registryRoot(), '.walkie-talkie'), { recursive: true });
  await writeFile(registryPath(), JSON.stringify(data, null, 2));
}

export async function registerProject({ projectPath, port, pid, projectName }) {
  const r = await loadRegistry();
  const others = r.projects.filter((p) => p.projectPath !== projectPath);
  const alive = prune(others);
  alive.push({ projectPath, port, pid, projectName, startedAt: new Date().toISOString() });
  r.projects = alive;
  await saveRegistry(r);
}

export async function deregisterProject(projectPath) {
  const r = await loadRegistry();
  const remaining = r.projects.filter((p) => p.projectPath !== projectPath);
  r.projects = prune(remaining);
  await saveRegistry(r);
}

export async function listProjects() {
  const r = await loadRegistry();
  const alive = prune(r.projects);
  if (alive.length !== r.projects.length) {
    r.projects = alive;
    await saveRegistry(r);
  }
  return alive;
}
