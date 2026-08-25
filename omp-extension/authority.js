/**
 * Newline-delimited-JSON client for the Collabcast authority's enrollment socket.
 *
 * One connection, one request line, one response line, then close. Everything that is
 * not an unambiguous success — connect error, timeout, truncated stream, malformed JSON,
 * an error envelope, a response missing the code — rejects, so the caller fails closed.
 *
 * No error raised here carries the socket path, the shared secret, or the enrollment
 * code: the hook surfaces these messages to a model-visible `reason`.
 */

import net from 'node:net';

/** Hard cap on the response we are willing to buffer before giving up. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Default round-trip budget for the whole exchange. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * @param {string} code one of the shared error-envelope codes
 * @param {string} message
 */
function authorityError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Pull `{ code }` out of a parsed authority response, or throw.
 * @param {unknown} parsed
 * @returns {{ code: string }}
 */
export function readEnrollmentResponse(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw authorityError('internal', 'authority returned a malformed response');
  }
  const envelope = /** @type {Record<string, unknown>} */ (parsed);
  if (envelope.error !== undefined && envelope.error !== null) {
    const detail = typeof envelope.error === 'object' ? envelope.error : {};
    const code = typeof detail.code === 'string' && detail.code !== '' ? detail.code : 'internal';
    const message =
      typeof detail.message === 'string' && detail.message !== ''
        ? detail.message.slice(0, 200)
        : 'authority refused the enrollment request';
    throw authorityError(code, message);
  }
  if (typeof envelope.code !== 'string' || envelope.code === '') {
    throw authorityError('internal', 'authority response carried no enrollment code');
  }
  return { code: envelope.code };
}

/**
 * Exchange one enrollment request for one enrollment code.
 *
 * @param {object} options
 * @param {string} options.socketPath Unix socket the authority listens on.
 * @param {Record<string, unknown>} options.payload request object, sent as one JSON line.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ code: string }>}
 */
export function requestEnrollmentCode({ socketPath, payload, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof socketPath !== 'string' || socketPath === '') {
    return Promise.reject(
      authorityError('config_invalid', 'authority socket is not configured for this session')
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket = net.createConnection({ path: socketPath });

    const timer = setTimeout(() => {
      settle(null, authorityError('internal', 'authority did not respond in time'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    /**
     * @param {{ code: string }|null} value
     * @param {Error|null} err
     */
    function settle(value, err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(/** @type {{ code: string }} */ (value));
    }

    socket.on('error', () => {
      settle(null, authorityError('internal', 'could not reach the collabcast authority'));
    });

    socket.on('connect', () => {
      let line;
      try {
        line = `${JSON.stringify(payload)}\n`;
      } catch {
        settle(null, authorityError('invalid_request', 'enrollment request is not serializable'));
        return;
      }
      socket.write(line);
    });

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        if (buffer.length > MAX_RESPONSE_BYTES) {
          settle(null, authorityError('internal', 'authority response exceeded the size limit'));
        }
        return;
      }
      const raw = buffer.slice(0, newline);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        settle(null, authorityError('internal', 'authority returned unparseable JSON'));
        return;
      }
      try {
        settle(readEnrollmentResponse(parsed), null);
      } catch (err) {
        settle(null, /** @type {Error} */ (err));
      }
    });

    socket.on('close', () => {
      settle(null, authorityError('internal', 'authority closed the connection without replying'));
    });
  });
}
