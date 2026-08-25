import { describe, test, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  DEFAULT_TIMEOUT_MS,
  readEnrollmentResponse,
  requestEnrollmentCode
} from '../../omp-extension/authority.js';
import { startStubAuthority } from './stub-authority.js';

const CODE = 'Zm9vYmFyYmF6cXV1eDEyMzQ1Njc4OTA';

/** @type {{ stop: () => Promise<void> }[]} */
let running = [];

afterEach(async () => {
  for (const stub of running) await stub.stop();
  running = [];
});

/** @param {Parameters<typeof startStubAuthority>[0]} [options] */
async function stub(options) {
  const started = await startStubAuthority(options);
  running.push(started);
  return started;
}

describe('authority: response reading', () => {
  test('accepts a code', () => {
    expect(readEnrollmentResponse({ code: CODE })).toEqual({ code: CODE });
  });

  test('rejects an error envelope, carrying its code through', () => {
    expect(() =>
      readEnrollmentResponse({ error: { code: 'forbidden', message: 'no approval on file' } })
    ).toThrow(/no approval on file/);
    try {
      readEnrollmentResponse({ error: { code: 'permit_required', message: 'x' } });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('permit_required');
    }
  });

  test('rejects anything that is not an unambiguous success', () => {
    for (const bad of [null, undefined, 42, 'ok', [], {}, { code: '' }, { code: 7 }]) {
      expect(() => readEnrollmentResponse(bad)).toThrow();
    }
  });
});

describe('authority: socket exchange', () => {
  test('sends exactly one request line and returns the code', async () => {
    const server = await stub({ respond: () => ({ code: CODE }) });
    const result = await requestEnrollmentCode({
      socketPath: server.socketPath,
      payload: { op: 'enroll.request', namespace: 'walkie-talkie' }
    });
    expect(result).toEqual({ code: CODE });
    expect(server.state.connections).toBe(1);
    expect(server.state.requests).toEqual([{ op: 'enroll.request', namespace: 'walkie-talkie' }]);
  });

  test('missing socket path fails closed as config_invalid without connecting', async () => {
    await expect(requestEnrollmentCode({ socketPath: '', payload: {} })).rejects.toMatchObject({
      code: 'config_invalid'
    });
    await expect(
      requestEnrollmentCode({ socketPath: undefined, payload: {} })
    ).rejects.toMatchObject({ code: 'config_invalid' });
  });

  test('an unreachable socket fails closed and never names the path', async () => {
    const server = await stub();
    const dead = join(server.dir, 'not-listening.sock');
    await expect(requestEnrollmentCode({ socketPath: dead, payload: {} })).rejects.toMatchObject({
      code: 'internal'
    });
    await requestEnrollmentCode({ socketPath: dead, payload: {} }).catch((err) => {
      expect(err.message).not.toContain(dead);
      expect(err.message).not.toContain('.sock');
    });
  });

  test('a silent authority times out', async () => {
    const server = await stub({ silent: true });
    const started = Date.now();
    await expect(
      requestEnrollmentCode({ socketPath: server.socketPath, payload: {}, timeoutMs: 60 })
    ).rejects.toThrow(/did not respond in time/);
    expect(Date.now() - started).toBeLessThan(DEFAULT_TIMEOUT_MS);
    expect(server.state.connections).toBe(1);
  });

  test('unparseable JSON fails closed', async () => {
    const server = await stub({ respond: () => 'not json at all\n' });
    await expect(
      requestEnrollmentCode({ socketPath: server.socketPath, payload: {} })
    ).rejects.toThrow(/unparseable JSON/);
  });

  test('a reply with no code fails closed', async () => {
    const server = await stub({ respond: () => ({ ok: true }) });
    await expect(
      requestEnrollmentCode({ socketPath: server.socketPath, payload: {} })
    ).rejects.toThrow(/no enrollment code/);
  });

  test('a connection closed without a reply fails closed', async () => {
    const server = await stub({ hangup: true });
    await expect(
      requestEnrollmentCode({ socketPath: server.socketPath, payload: {}, timeoutMs: 2000 })
    ).rejects.toThrow(/closed the connection without replying/);
    expect(server.state.requests).toHaveLength(1);
  });
});
