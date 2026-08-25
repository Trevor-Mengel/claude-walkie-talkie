/**
 * Server-sent-events reader for the walkie event feed, over the same authenticated transport
 * as everything else.
 *
 * v0.2 read the feed with `fetch('http://127.0.0.1:<port>/events')` and no credential at all.
 * Here the stream carries `Authorization: Bearer` like every other request, runs over the Unix
 * socket, and a connection that is refused reports the same `unavailable` guidance as a normal
 * call rather than a bare status number.
 */

import http from 'node:http';
import { unavailableError } from './api.js';
import { walkieError } from '../identity/errors.js';

const FRAME_SEPARATOR = '\n\n';

/**
 * Open the feed and invoke `onEvent(name, data)` per frame.
 *
 * @param {object} opts
 * @param {{socketPath?:string, host?:string, port?:number}} opts.endpoint
 * @param {string|null} opts.token
 * @param {{namespace:string, mode:string}} opts.context
 * @param {(name:string, data:unknown)=>void} opts.onEvent
 * @param {(err:Error)=>void} [opts.onError]
 * @returns {Promise<{close:()=>void}>} resolves once the stream is established
 */
export function openEventStream({ endpoint, token, context, onEvent, onError }) {
  const headers = { accept: 'text/event-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  const options = endpoint.socketPath
    ? { socketPath: endpoint.socketPath, path: '/events', method: 'GET', headers }
    : { host: endpoint.host, port: endpoint.port, path: '/events', method: 'GET', headers };

  return new Promise((resolve, reject) => {
    let settled = false;
    let established = false;
    let closed = false;
    let reported = false;

    /**
     * Reports a post-establishment fault to the consumer, exactly once.
     *
     * Exactly once matters in both directions. A stream that faults mid-flight produces more
     * than one signal for the same event — a chunked-framing fault arrives on the request as
     * `HPE_INVALID_CHUNK_SIZE`, and only then on the response as the `ECONNRESET` Node
     * synthesizes while tearing the socket down — and the first one is the accurate cause. In
     * the other direction, a fault that already surfaced as a rejection from this function must
     * not also reach a callback the caller never got a handle to use, so nothing is reported
     * until the stream was actually handed over.
     *
     * @param {Error} err
     */
    const fail = (err) => {
      if (!established || closed || reported) return;
      reported = true;
      onError?.(err);
    };
    const req = http.request(options, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        res.resume();
        settled = true;
        reject(
          walkieError('unavailable', `the walkie event feed refused the connection (HTTP ${status})`, {
            namespace: context.namespace,
            status
          })
        );
        return;
      }
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf(FRAME_SEPARATOR)) !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + FRAME_SEPARATOR.length);
          if (frame.startsWith(':')) continue;
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!name || data === undefined) continue;
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          onEvent(name, parsed);
        }
      });
      res.on('error', (err) => fail(err));
      res.on('end', () => fail(walkieError('unavailable', 'the walkie event feed closed')));
      settled = true;
      established = true;
      resolve({
        close() {
          // A consumer that closed the stream asked for it to end. The teardown errors that
          // follow are its own doing, not a fault to report back to it.
          closed = true;
          res.destroy();
          req.destroy();
        }
      });
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(unavailableError(context));
        return;
      }
      // A request-level fault after establishment is the accurate cause of a stream that has
      // stopped delivering: a chunked-framing fault lands here, and Node reports only the
      // socket teardown it then triggers — `ECONNRESET` — on the response object. Dropping
      // this left the consumer mis-diagnosed at best, and told nothing at all whenever the
      // response object produced no signal of its own.
      fail(err);
    });
    req.end();
  });
}
