// Launching the real `collabcast-svc` process.
//
// v0.2 called `spawn(node, [ENTRY, wtDir, projectName])` and then polled for `server.port` and
// `server.pid` inside `.collabcast/`. Every part of that is gone:
//
//   - `daemon-entry.js` takes NO arguments. It derives the namespace from the directory it was
//     started in (via the host identity map) and the config from that namespace's
//     `.collabcast/config.json`. Passing `wtDir` as argv[2] is silently ignored, which is
//     worse than an error: the child came up in whatever namespace owned the test runner's cwd.
//   - there is no port file. The socket path IS the address and the namespace claim, so
//     readiness is "something accepts a connection on the socket AND `/health` names the
//     namespace we asked for" — a file existing proves neither.
//
// The SIGKILL escalation and the try/finally no-leak guarantee are kept: a child that never
// becomes ready, or a poll that throws, must not outlive the call.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, '..', '..', 'src', 'daemon', 'daemon-entry.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** `GET /health` over the socket, resolving null when nothing is listening yet. */
function probeHealth(socketPath, timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, method: 'GET', path: '/health', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * Spawn `collabcast-svc` for one namespace and wait until it is genuinely serving.
 *
 * @param {object} opts
 * @param {string} opts.cwd a directory the identity map registers to `namespace`
 * @param {Record<string,string>} opts.env a complete, isolated child environment
 * @param {string} opts.socketPath where the child is expected to bind
 * @param {string} opts.namespace the namespace `/health` must report
 * @param {number} [opts.attempts]
 * @param {number} [opts.intervalMs]
 * @returns {Promise<{child:import('node:child_process').ChildProcess, socketPath:string,
 *   namespace:string, stderr:() => string, stop:() => Promise<void>}>}
 */
export async function spawnDaemon({
  cwd,
  env,
  socketPath,
  namespace,
  attempts = 200,
  intervalMs = 25
}) {
  for (const [key, value] of Object.entries({ cwd, env, socketPath, namespace })) {
    if (!value) throw new Error(`spawnDaemon requires ${key}`);
  }

  const child = spawn(process.execPath, [ENTRY], {
    cwd,
    env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  let stdout = '';
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });

  const handle = {
    child,
    socketPath,
    namespace,
    stderr: () => stderr,
    stdout: () => stdout,
    stop: () => stopDaemon(handle)
  };

  let ready = false;
  try {
    for (let i = 0; i < attempts; i += 1) {
      if (exited(child)) {
        throw new Error(
          `collabcast-svc exited before becoming ready (code ${child.exitCode}, signal ` +
            `${child.signalCode}): ${stderr.trim() || '(no stderr)'}`
        );
      }
      if (existsSync(socketPath)) {
        const health = await probeHealth(socketPath);
        if (health && health.namespace === namespace) {
          ready = true;
          return handle;
        }
        if (health && health.namespace !== namespace) {
          throw new Error(
            `collabcast-svc came up in namespace ${health.namespace}, expected ${namespace}`
          );
        }
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `collabcast-svc never answered /health on ${socketPath}: ${stderr.trim() || '(no stderr)'}`
    );
  } finally {
    // Covers the timeout, the namespace mismatch and any throw from the poll itself: never
    // leak a child process.
    if (!ready && !exited(child)) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/** SIGTERM, then SIGKILL if it will not go. Safe to call on an already-dead child. */
export async function stopDaemon(daemon) {
  const child = daemon?.child;
  if (!child) return;
  if (exited(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 40; i += 1) {
    if (exited(child)) return;
    await sleep(25);
  }
  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }
  for (let i = 0; i < 40; i += 1) {
    if (exited(child)) return;
    await sleep(25);
  }
}
