/**
 * A throwaway Unix-socket stand-in for the Collabcast authority, used by the hook tests so
 * they never touch a real daemon, a real socket path, or real operator state.
 *
 * Not a `*.test.js` file, so vitest treats it as a plain module.
 */

import net from 'node:net';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

/**
 * @param {object} [options]
 * @param {(request: unknown) => unknown|string} [options.respond] reply for one request;
 *   a string is written verbatim, anything else is JSON + newline.
 * @param {boolean} [options.silent] accept the connection and never reply (timeout probe).
 * @param {boolean} [options.hangup] read the request then close without replying.
 */
export async function startStubAuthority({ respond, silent = false, hangup = false } = {}) {
  const dir = createFixtureDir('wk-hook-');
  const socketPath = join(dir, 'a.sock');
  const state = { connections: 0, requests: [] };

  const server = net.createServer((socket) => {
    state.connections += 1;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = { unparseable: line };
      }
      state.requests.push(parsed);
      if (hangup) {
        socket.end();
        return;
      }
      if (silent) return;
      const reply = respond ? respond(parsed) : { code: 'stub-code' };
      socket.write(typeof reply === 'string' ? reply : `${JSON.stringify(reply)}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(undefined));
  });

  return {
    socketPath,
    dir,
    state,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** A tmp dir for hook log files; returns `{ logPath, cleanup }`. */
export async function createLogSink() {
  const dir = createFixtureDir('wk-log-');
  return {
    logPath: join(dir, 'hook.jsonl'),
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
