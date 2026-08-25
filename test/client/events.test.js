// The event feed's failure reporting.
//
// `openEventStream` resolves once and then delivers frames for the life of the process, so the
// only thing a consumer can act on is `onError`. A stream that faults and says nothing leaves the
// consumer — `walkie tail`, and the MCP server's resource subscriptions — believing it is still
// subscribed while receiving nothing at all. These tests drive real faults down a real Unix
// socket and assert what reaches the callback.

import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureDir } from '../helpers/fixture-leaks.js';
import { openEventStream } from '../../src/client/events.js';

/** @type {string[]} */
const dirs = [];
/** @type {import('node:net').Server[]} */
const servers = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CONTEXT = Object.freeze({ namespace: 'walkie-talkie', mode: 'standalone' });

/** One well-formed SSE frame, chunk-framed. 0x25 = 37 bytes of payload. */
const EVENT_CHUNK = '25\r\nevent: message.posted\ndata: {"a":1}\n\n\r\n';

/**
 * A listener that speaks just enough HTTP to establish a chunked SSE response and then hands the
 * raw socket to `afterEstablished`.
 *
 * Raw `net`, not `http.createServer`: the faults under test are protocol-level, and Node's own
 * server would never produce them. This is the transport the product actually uses — a Unix
 * socket — so nothing here is a stand-in.
 *
 * @param {(socket:import('node:net').Socket) => void} afterEstablished
 * @returns {Promise<string>} the socket path
 */
function feed(afterEstablished) {
  const dir = createFixtureDir('walkie-events-');
  dirs.push(dir);
  const socketPath = join(dir, 'e.sock');
  const server = net.createServer((socket) => {
    socket.on('error', () => {
      /* the client tearing down mid-exchange is the point of several of these */
    });
    let seen = '';
    socket.on('data', (chunk) => {
      seen += chunk;
      if (!seen.includes('\r\n\r\n')) return;
      socket.write(
        'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n'
      );
      socket.write('9\r\n: hello\n\n\r\n');
      socket.write(EVENT_CHUNK);
      setTimeout(() => afterEstablished(socket), 20);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve(socketPath)));
}

/** A listener that answers with a status and nothing else. */
function refusing(status) {
  const dir = createFixtureDir('walkie-events-');
  dirs.push(dir);
  const socketPath = join(dir, 'e.sock');
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', () => {
      socket.end(`HTTP/1.1 ${status} Nope\r\ncontent-length: 0\r\n\r\n`);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve(socketPath)));
}

function collector() {
  /** @type {Error[]} */
  const errors = [];
  /** @type {Array<[string, unknown]>} */
  const frames = [];
  return {
    errors,
    frames,
    onError: (err) => errors.push(err),
    onEvent: (name, data) => frames.push([name, data])
  };
}

/** Long enough for a socket teardown and every event it produces to land. */
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

describe('openEventStream fault reporting', () => {
  it('reports a post-establishment fault once, naming the real cause', async () => {
    // A malformed chunk header. Node reports this on the REQUEST object as
    // `HPE_INVALID_CHUNK_SIZE`, then tears the socket down and reports the teardown it just
    // caused on the RESPONSE object as `ECONNRESET`. The request-side fault used to be dropped
    // on the floor behind an `if (settled) return`, so the consumer was told the stream had been
    // reset by the peer when in fact the peer had spoken nonsense — and if the response object
    // had produced nothing of its own, it would have been told nothing at all.
    const socketPath = await feed((socket) => socket.write('ZZZZ\r\nnope\r\n'));
    const { errors, frames, onError, onEvent } = collector();

    const stream = await openEventStream({
      endpoint: { socketPath },
      token: 'tok',
      context: CONTEXT,
      onEvent,
      onError
    });
    await settle();
    stream.close();

    expect(frames).toEqual([['message.posted', { a: 1 }]]);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('HPE_INVALID_CHUNK_SIZE');
  });

  it('reports a peer that resets the connection', async () => {
    const socketPath = await feed((socket) => socket.destroy());
    const { errors, onError, onEvent } = collector();

    await openEventStream({ endpoint: { socketPath }, token: 'tok', context: CONTEXT, onEvent, onError });
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('ECONNRESET');
  });

  it('reports a clean server-side close as unavailable', async () => {
    const socketPath = await feed((socket) => socket.end('0\r\n\r\n'));
    const { errors, onError, onEvent } = collector();

    await openEventStream({ endpoint: { socketPath }, token: 'tok', context: CONTEXT, onEvent, onError });
    await settle();

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('unavailable');
    expect(errors[0].message).toMatch(/closed/);
  });

  it('says nothing when the consumer is the one that closed the stream', async () => {
    // `close()` destroys both the response and the request. Those teardowns are the consumer's
    // own doing and must not come back to it as a fault, or every clean unsubscribe looks like
    // a broken feed.
    const socketPath = await feed(() => {});
    const { errors, onError, onEvent } = collector();

    const stream = await openEventStream({
      endpoint: { socketPath },
      token: 'tok',
      context: CONTEXT,
      onEvent,
      onError
    });
    stream.close();
    await settle();

    expect(errors).toEqual([]);
  });

  it('rejects a connect-time failure without also reporting it to onError', async () => {
    // The caller never got a handle, so it has nothing to unsubscribe and no reason to hear
    // about the same failure twice.
    const dir = createFixtureDir('walkie-events-');
    dirs.push(dir);
    const { errors, onError, onEvent } = collector();

    await expect(
      openEventStream({
        endpoint: { socketPath: join(dir, 'absent.sock') },
        token: 'tok',
        context: CONTEXT,
        onEvent,
        onError
      })
    ).rejects.toMatchObject({ code: 'unavailable' });
    await settle(150);

    expect(errors).toEqual([]);
  });

  it('rejects a refused status without also reporting it to onError', async () => {
    const socketPath = await refusing(401);
    const { errors, onError, onEvent } = collector();

    await expect(
      openEventStream({ endpoint: { socketPath }, token: 'tok', context: CONTEXT, onEvent, onError })
    ).rejects.toMatchObject({ code: 'unavailable', detail: { status: 401 } });
    await settle(150);

    expect(errors).toEqual([]);
  });
});
