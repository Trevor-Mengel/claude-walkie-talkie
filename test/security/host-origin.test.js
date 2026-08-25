// Hostile Origin / Host handling on the local daemon.
//
// The daemon is reachable over a Unix socket and, optionally, loopback TCP. Loopback is not a
// security boundary against the operator's own browser: a malicious page can pin DNS for a domain
// it controls to 127.0.0.1 and then reach the daemon under its own origin. So the daemon rejects
// anything that looks like it came from a browser.
//
// This file previously asserted two of the defects it now guards against — that a MISSING Host
// header was accepted (the check read `if (host && host !== ...)`, and an absent header is falsy),
// and that `Origin: null` was explicitly whitelisted. Both are rejections now, and the bracketed
// IPv6 form that used to 403 is accepted.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { openStore } from '../../src/store/db.js';
import { createServer, rejectCrossOrigin } from '../../src/daemon/server.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

const NAMESPACE = 'collabcast';

let base;
let store;
let app;

/** Drives the middleware directly for cases a real HTTP client cannot express. */
function runGuard(headers) {
  let status = 'next';
  let body;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
    }
  };
  rejectCrossOrigin({ headers, method: 'GET' }, res, () => {
    status = 'next';
  });
  return { status, body };
}

beforeEach(() => {
  base = createFixtureDir('wk-sec-');
  store = openStore({ path: join(base, 'store', 'collabcast.db'), namespace: NAMESPACE });
  app = createServer({
    store,
    config: { ...DEFAULT_CONFIG, namespace: NAMESPACE },
    namespace: NAMESPACE
  }).app;
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

describe('security: Origin header validation', () => {
  it('rejects a cross-origin Origin header, defanging DNS rebinding', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    expect(res.body.error.message).toMatch(/browser/i);
  });

  it('rejects Origin: null instead of whitelisting it', async () => {
    // A file:// page and a sandboxed iframe both send `Origin: null`. Neither is a client of this
    // daemon, and treating the literal string as "no origin" was a hole.
    const res = await request(app).get('/health').set('Origin', 'null');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('rejects a same-origin-looking localhost Origin too', async () => {
    // No legitimate caller is a browser, so even a loopback origin is refused.
    const res = await request(app).get('/health').set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(403);
  });

  it('rejects an Origin on a POST as well as a GET (app-level middleware)', async () => {
    const res = await request(app)
      .post('/channel/message')
      .set('Origin', 'https://evil.example.com')
      .send({ body: 'hi' });
    expect(res.status).toBe(403);
  });

  it('accepts a request with no Origin header (the normal local client)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('security: Host header validation', () => {
  it('rejects a MISSING Host header instead of letting it through', () => {
    const { status, body } = runGuard({});
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toMatch(/Host/);
  });

  it('rejects an empty Host header', () => {
    expect(runGuard({ host: '' }).status).toBe(403);
    expect(runGuard({ host: '   ' }).status).toBe(403);
  });

  it('rejects a non-loopback Host', async () => {
    for (const host of ['evil.com', 'evil.com:8080', 'collabcast.example.org']) {
      const res = await request(app).get('/health').set('Host', host);
      expect(res.status, host).toBe(403);
      expect(res.body.error.code, host).toBe('forbidden');
    }
  });

  it('accepts Host: 127.0.0.1, with or without a port', async () => {
    for (const host of ['127.0.0.1', '127.0.0.1:12345']) {
      const res = await request(app).get('/health').set('Host', host);
      expect(res.status, host).toBe(200);
    }
  });

  it('accepts Host: localhost, case-insensitively', async () => {
    for (const host of ['localhost', 'localhost:12345', 'LOCALHOST']) {
      const res = await request(app).get('/health').set('Host', host);
      expect(res.status, host).toBe(200);
    }
  });

  it('accepts the bracketed IPv6 loopback, which used to 403', async () => {
    // The old guard split on ':' and compared the first fragment, so `[::1]:1234` became `[`.
    for (const host of ['[::1]', '[::1]:1234']) {
      const res = await request(app).get('/health').set('Host', host);
      expect(res.status, host).toBe(200);
    }
  });

  it('rejects a malformed Host rather than guessing at it', () => {
    for (const host of ['::1:1234', ':8080', '127.0.0.1:notaport', '[]:1', '[::1', 'a:b:c']) {
      expect(runGuard({ host }).status, host).toBe(403);
    }
  });
});

describe('security: /health discloses nothing about the filesystem', () => {
  it('answers with the namespace and mode only', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    // v0.2 answered `{ ok, wtDir }`, handing any caller the project path to attack next.
    expect(Object.keys(res.body).sort()).toEqual(['mode', 'namespace', 'ok', 'schemaVersion']);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(base);
    expect(text).not.toMatch(/\/(?:private\/)?(?:var|tmp|Users|home)\//);
  });
});
