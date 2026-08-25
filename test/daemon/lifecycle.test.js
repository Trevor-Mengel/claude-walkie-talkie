// Lifecycle is the module that decides "is a daemon running" and "may I signal it".
//
// v0.2 answered both from a pid file plus `process.kill(pid, 0)`. That predicate is true for ANY
// live process holding that pid, so these tests are written around the two consequences: a
// recycled or forged pid must not be reported as our daemon, and it must not be signalled.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { readHealth, startDaemon, statusDaemon, stopDaemon } from '../../src/daemon/lifecycle.js';
import { COLLABCAST_SOCKET_FILENAME, PID_FILENAME } from '../../src/daemon/transport.js';
import {
  OPERATOR_CREDENTIAL_FILENAME,
  SECRET_FILENAME,
  SERVICE_STDERR_FILENAME,
  SOCKET_FILENAME as AUTHORITY_SOCKET_FILENAME
} from '../../src/authority/index.js';
import { createRegisteredNamespace } from '../helpers/registered-namespace.js';
import { isolatedEnv } from '../helpers/isolation.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

const NAMESPACE = 'collabcast';

let base;
let runtimeRoot;
let socketPath;
let pidPath;
const children = [];
/** Pids of real detached `collabcast-svc` processes, so a failed assertion cannot leak one. */
const detached = [];

function config({ mode = 'standalone' } = {}) {
  return {
    ...DEFAULT_CONFIG,
    namespace: NAMESPACE,
    mode,
    transport: { ...DEFAULT_CONFIG.transport, socketPath }
  };
}

/** Options that pin lifecycle to this fixture instead of resolving a real project. */
function target(overrides = {}) {
  return {
    canonicalRoot: base,
    namespace: NAMESPACE,
    runtimeRoot,
    config: config(),
    ...overrides
  };
}

/**
 * Spawns a stand-in service on the socket that answers `/health` with `namespace`.
 *
 * A child process (rather than an in-process server) is the point: it has a real, distinct pid, so
 * a test can put that pid in the pid file and check whether lifecycle is willing to signal it.
 *
 * @param {{namespace:string}} opts
 */
async function spawnFakeService({ namespace }) {
  const source = [
    "const http=require('node:http');",
    'const [sock,ns]=process.argv.slice(1);',
    'const s=http.createServer((req,res)=>{',
    "  if(req.url==='/health'){",
    "    res.writeHead(200,{'content-type':'application/json'});",
    "    res.end(JSON.stringify({ok:true,namespace:ns,mode:'standalone',schemaVersion:'3'}));",
    '    return;',
    '  }',
    '  res.writeHead(404); res.end();',
    '});',
    "s.listen(sock,()=>process.stdout.write('up'));",
    "process.on('SIGTERM',()=>{s.close(()=>process.exit(0));});"
  ].join('');

  const child = spawn(process.execPath, ['-e', source, socketPath, namespace], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: isolatedEnv()
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake service never bound')), 5000);
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return child;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  base = createFixtureDir('wk-lc-');
  runtimeRoot = join(base, 'run');
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  socketPath = join(runtimeRoot, COLLABCAST_SOCKET_FILENAME);
  pidPath = join(runtimeRoot, PID_FILENAME);
});

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop();
    if (!child.killed && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  while (detached.length > 0) {
    const pid = detached.pop();
    if (alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  rmSync(base, { recursive: true, force: true });
});

describe('readHealth', () => {
  it('returns null when nothing is listening', async () => {
    expect(await readHealth(socketPath, { timeoutMs: 500 })).toBeNull();
  });

  it('returns the health document from a live listener', async () => {
    await spawnFakeService({ namespace: NAMESPACE });
    const health = await readHealth(socketPath);
    expect(health).toMatchObject({ ok: true, namespace: NAMESPACE });
  });
});

describe('statusDaemon', () => {
  it('reports not running when the socket is silent', async () => {
    const status = await statusDaemon(target());
    expect(status.running).toBe(false);
    expect(status.reason).toBe('no_response');
    expect(status.pid).toBeNull();
  });

  it('reports running and the pid once /health confirms the namespace', async () => {
    const child = await spawnFakeService({ namespace: NAMESPACE });
    writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });

    const status = await statusDaemon(target());
    expect(status.running).toBe(true);
    expect(status.pid).toBe(child.pid);
    expect(status.namespace).toBe(NAMESPACE);
  });

  it('does NOT report a pid from a stale file when nothing answers', async () => {
    // The recycled-pid case: pid 1 is always alive, so v0.2's `process.kill(pid, 0)` said running.
    writeFileSync(pidPath, '1\n', { mode: 0o600 });
    const status = await statusDaemon(target());
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it('refuses to claim a listener that serves a different namespace', async () => {
    const child = await spawnFakeService({ namespace: 'someone-elses-project' });
    writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });

    const status = await statusDaemon(target());
    expect(status.running).toBe(false);
    expect(status.reason).toBe('namespace_mismatch');
    expect(status.pid).toBeNull();
  });
});

describe('startDaemon', () => {
  it('refuses in managed mode and names the supervised service', async () => {
    let thrown;
    try {
      await startDaemon(target({ config: config({ mode: 'managed' }) }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('forbidden');
    expect(thrown.message).toMatch(/managed/);
    expect(thrown.message).toMatch(/Paseo/);
    expect(thrown.message).toMatch(/collabcast-svc/);
    expect(thrown.message).toMatch(/standalone/);
    // Nothing was spawned and nothing was written.
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidPath)).toBe(false);
  });

  it('is a no-op when a service for this namespace is already answering', async () => {
    const child = await spawnFakeService({ namespace: NAMESPACE });
    writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });

    const status = await startDaemon(target());
    expect(status.running).toBe(true);
    expect(status.pid).toBe(child.pid);
  });

  it('refuses to start on a socket held by a foreign listener', async () => {
    await spawnFakeService({ namespace: 'someone-elses-project' });
    let thrown;
    try {
      await startDaemon(target());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('conflict');
  });
});

describe('stopDaemon', () => {
  it('signals a service that confirms this namespace', async () => {
    const child = await spawnFakeService({ namespace: NAMESPACE });
    writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });

    const result = await stopDaemon(target());
    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(child.pid);
    expect(existsSync(pidPath)).toBe(false);
  });

  it('REFUSES a pid whose /health namespace does not match, and never signals it', async () => {
    const child = await spawnFakeService({ namespace: 'someone-elses-project' });
    writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });

    let thrown;
    try {
      await stopDaemon(target());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('wrong_namespace');
    expect(thrown.detail).toEqual({
      expected: NAMESPACE,
      found: 'someone-elses-project'
    });

    // The whole point: the foreign process is untouched.
    expect(alive(child.pid)).toBe(true);
    expect(await readHealth(socketPath)).toMatchObject({ namespace: 'someone-elses-project' });
  });

  it('never signals a pid read from a file when nothing is answering', async () => {
    // A forged pid file is an arbitrary-kill primitive if the pid alone is trusted. Point it at
    // this very test process: if lifecycle signals it, the run dies.
    writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });

    const result = await stopDaemon(target());
    expect(result.stopped).toBe(false);
    expect(result.reason).toBe('not_running');
    // The stale file is cleaned up, and we are still here.
    expect(existsSync(pidPath)).toBe(false);
    expect(alive(process.pid)).toBe(true);
  });

  it('refuses when the service answers but its pid file is missing', async () => {
    await spawnFakeService({ namespace: NAMESPACE });
    let thrown;
    try {
      await stopDaemon(target());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('conflict');
    expect(thrown.message).toMatch(/pid file/);
  });

  it('refuses when the pid file names this process', async () => {
    await spawnFakeService({ namespace: NAMESPACE });
    writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
    let thrown;
    try {
      await stopDaemon(target());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('conflict');
    expect(alive(process.pid)).toBe(true);
  });
});

// Everything above uses a stand-in listener, because lifecycle's job is the pid/namespace
// predicate rather than the service. This one spawns the REAL `collabcast-svc`, which is the only
// place in the suite where `collabcast start` is exercised end to end — including the two artifacts
// the OMP hook needs, which a stand-in cannot produce.
describe('startDaemon spawning the real service', () => {
  it('brings up the authority socket and the hook secret, and stopDaemon takes them away', async () => {
    const ns = createRegisteredNamespace({ namespace: 'collabcast-lc-real', mode: 'standalone' });
    const opts = {
      canonicalRoot: ns.canonicalRoot,
      namespace: ns.namespace,
      runtimeRoot: ns.runtimeRoot,
      config: { ...DEFAULT_CONFIG, namespace: ns.namespace, mode: 'standalone' },
      env: isolatedEnv({
        COLLABCAST_IDENTITIES: ns.identitiesPath,
        COLLABCAST_RUNTIME_ROOT: ns.runtimeRoot,
        COLLABCAST_SOCKET_PATH: undefined, // harness exports ONE run-wide socket path and it
        // overrides the runtime-root-derived one, putting every project on one socket
        COLLABCAST_CAPABILITY: undefined,
        COLLABCAST_NAMESPACE: undefined
      })
    };

    const status = await startDaemon(opts);
    if (status.pid) detached.push(status.pid);
    expect(status.running).toBe(true);

    const authoritySocket = join(ns.runtimeRoot, AUTHORITY_SOCKET_FILENAME);
    const secretFile = join(ns.runtimeRoot, SECRET_FILENAME);
    expect(existsSync(authoritySocket)).toBe(true);
    expect(existsSync(secretFile)).toBe(true);
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    expect(statSync(ns.runtimeRoot).mode & 0o777).toBe(0o700);

    const stopped = await stopDaemon(opts);
    expect(stopped.stopped).toBe(true);
    // `stopDaemon` returns as soon as `/health` stops answering, and the transport is torn down
    // before the authority, so wait for the process itself to be gone before asserting on the
    // authority address — otherwise this races the child's own unwind.
    for (let i = 0; i < 200 && alive(stopped.pid); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(alive(stopped.pid)).toBe(false);
    expect(existsSync(authoritySocket)).toBe(false);
    // The secret is operator wiring, not per-boot state.
    expect(existsSync(secretFile)).toBe(true);
  });

  it('quotes the refusal the service wrote instead of a bare timeout', async () => {
    // `stdio: 'ignore'` sent every operator-facing boot refusal to /dev/null, so a one-line fix
    // (a wedged `hook.secret`, a revoked `operator.cred`) reached the operator as
    // `did not begin answering within the startup window` ten seconds later, with nothing in it
    // to act on. The service's stderr is kept now, and a failed start reads it back.
    const ns = createRegisteredNamespace({ namespace: 'collabcast-lc-diag', mode: 'standalone' });
    const opts = {
      canonicalRoot: ns.canonicalRoot,
      namespace: ns.namespace,
      runtimeRoot: ns.runtimeRoot,
      config: { ...DEFAULT_CONFIG, namespace: ns.namespace, mode: 'standalone' },
      env: isolatedEnv({
        COLLABCAST_IDENTITIES: ns.identitiesPath,
        COLLABCAST_RUNTIME_ROOT: ns.runtimeRoot,
        COLLABCAST_SOCKET_PATH: undefined, // harness exports ONE run-wide socket path and it
        // overrides the runtime-root-derived one, putting every project on one socket
        COLLABCAST_CAPABILITY: undefined,
        COLLABCAST_NAMESPACE: undefined
      })
    };
    // An operator credential the service will refuse, which is a deterministic boot failure.
    const credentialPath = join(ns.runtimeRoot, OPERATOR_CREDENTIAL_FILENAME);
    writeFileSync(credentialPath, '[]\n', { mode: 0o600 });

    const started = Date.now();
    let thrown;
    try {
      await startDaemon(opts);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(thrown.message).toContain(credentialPath);
    expect(thrown.message).toMatch(/could not be parsed/);
    expect(thrown.detail.exited).toBe(true);
    // A service that has already exited will never answer, so the full window is not waited out.
    expect(Date.now() - started).toBeLessThan(5000);
    // The diagnostic outlives the failed start, so the operator can still go and read it.
    expect(readFileSync(join(ns.runtimeRoot, SERVICE_STDERR_FILENAME), 'utf8')).toContain(
      credentialPath
    );
  });
});
