// Path traversal / local-file-inclusion through a route parameter.
//
// `:id` and `:ulid` are the only caller-controlled values that reach a
// filesystem path: `GET /channel/message/:id` reads
// `<wtDir>/.sessions/<id>.history.md`. If the parameter were used before it were
// validated, `..%2F..%2Fsecret` would name any file the daemon can read.
//
// Every case here survives the v0.3 cutover unchanged in intent; what changed is
// that each request now carries a capability token, because there is no
// unauthenticated write (or read) surface any more. Two properties are asserted
// on top of the v0.2 set:
//
//   - an unauthenticated traversal attempt is 401, i.e. the parameter is never
//     even parsed for a caller with no token, and
//   - the planted decoy file is neither read into a response nor modified.
//
// The v0.2 file also had a broken `afterEach`: `decoyDir` was assigned in a
// `beforeEach` that threw at `createServer(...)`, so cleanup ran with `undefined`
// and turned every failure into a second, misleading ERR_INVALID_ARG_TYPE.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { createFixture, mintActor, cleanupFixtures } from '../daemon/routes/helpers.js';
import { createFixtureDir } from '../helpers/fixture-leaks.js';

const DECOY_CONTENT =
  '## Revision 1\nEdited at: 2026-05-15\nEdited by: attacker\n\nSECRET-CONTENT-LEAKED\n\n---\n';

/** A well-formed ULID that was never written. */
const ABSENT_ULID = '01J7QXP9R5K8VYZAB3CDEFGHJK';

let fx;
let actor;
let decoyDir = null;
let decoyFile = null;

beforeEach(() => {
  // The decoy is planted first, so a `createFixture` failure cannot leave the
  // cleanup hook holding `undefined`.
  decoyDir = createFixtureDir('collabcast-lfi-');
  decoyFile = join(decoyDir, 'secret.history.md');
  writeFileSync(decoyFile, DECOY_CONTENT, 'utf8');

  fx = createFixture();
  actor = mintActor(fx.store, { alias: 'lfi-probe' });
});

afterEach(() => {
  cleanupFixtures();
  if (decoyDir) rmSync(decoyDir, { recursive: true, force: true });
  decoyDir = null;
  decoyFile = null;
});

/** Every rejection of a malformed id is the same 400 with the same code. */
function expectBadId(res) {
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('invalid_request');
  expect(res.body.error.message).toMatch(/ulid/i);
  expect(JSON.stringify(res.body)).not.toContain('SECRET-CONTENT-LEAKED');
}

describe('security: LFI / path traversal on :id route params (H1)', () => {
  test('rejects ..%2F path traversal on GET /channel/message/:id', async () => {
    const malicious = encodeURIComponent('../../../etc/hostname');
    const res = await request(fx.app)
      .get(`/channel/message/${malicious}`)
      .set('Authorization', actor.bearer);
    expectBadId(res);
  });

  test('rejects a traversal aimed at the planted decoy history file', async () => {
    // The decoy lives outside the project entirely, so a successful traversal
    // would have to escape `<wtDir>/.sessions`. Assert both that the request is
    // refused and that the decoy is untouched on disk.
    const escape = encodeURIComponent(join(decoyDir, 'secret'));
    const res = await request(fx.app)
      .get(`/channel/message/${escape}`)
      .set('Authorization', actor.bearer);
    expectBadId(res);
    expect(readFileSync(decoyFile, 'utf8')).toBe(DECOY_CONTENT);
  });

  test('rejects non-ULID strings on GET /channel/message/:id (e.g., spaces, dots)', async () => {
    const res = await request(fx.app)
      .get(`/channel/message/${encodeURIComponent('foo.bar')}`)
      .set('Authorization', actor.bearer);
    expectBadId(res);
  });

  test('rejects ULIDs containing forbidden Crockford-base32 chars (I/L/O/U)', async () => {
    // Crockford base32 omits I, L, O and U so a human cannot transcribe an id
    // into a different one. A 26-char string that uses them is not a ULID.
    for (const fake of [
      '01HXFAKEUUUUUUUUUUUUUUUUUU',
      '01HXFAKEIIIIIIIIIIIIIIIIII',
      '01HXFAKELLLLLLLLLLLLLLLLLL',
      '01HXFAKEOOOOOOOOOOOOOOOOOO'
    ]) {
      expect(fake).toHaveLength(26);
      const res = await request(fx.app)
        .get(`/channel/message/${fake}`)
        .set('Authorization', actor.bearer);
      expectBadId(res);
    }
  });

  test("legitimate well-formed ULID returns 404 (not 400) when message doesn't exist", async () => {
    const res = await request(fx.app)
      .get(`/channel/message/${ABSENT_ULID}`)
      .set('Authorization', actor.bearer);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  test('PATCH /channel/message/:id rejects non-ULID id (defense in depth)', async () => {
    const res = await request(fx.app)
      .patch(`/channel/message/${encodeURIComponent('../../etc/passwd')}`)
      .set('Authorization', actor.bearer)
      .send({ body: 'edited' });
    expectBadId(res);
  });

  test('POST /channel/message/:id/archive rejects non-ULID id (defense in depth)', async () => {
    const res = await request(fx.app)
      .post(`/channel/message/${encodeURIComponent('../etc/x')}/archive`)
      .set('Authorization', actor.bearer)
      .send({ reason: 'cleanup' });
    expectBadId(res);
  });

  test('GET /channel/since/:ulid rejects non-ULID values', async () => {
    const res = await request(fx.app)
      .get(`/channel/since/${encodeURIComponent('not-a-ulid')}`)
      .set('Authorization', actor.bearer);
    expectBadId(res);
  });

  test('an unauthenticated traversal attempt is 401, never 400', async () => {
    // Ordering matters: the capability gate is mounted before every router, so a
    // caller with no token cannot reach the parameter at all. A 400 here would
    // mean the id was parsed — and therefore reachable — without a credential.
    for (const [method, path] of [
      ['get', `/channel/message/${encodeURIComponent('../../../etc/hostname')}`],
      ['patch', `/channel/message/${encodeURIComponent('../../etc/passwd')}`],
      ['post', `/channel/message/${encodeURIComponent('../etc/x')}/archive`],
      ['get', `/channel/since/${encodeURIComponent('not-a-ulid')}`]
    ]) {
      const res = await request(fx.app)[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    }
  });

  test('legitimate POST + GET round-trip still works', async () => {
    const post = await request(fx.app)
      .post('/channel/message')
      .set('Authorization', actor.bearer)
      .send({ body: 'hi' });
    expect(post.status).toBe(201);
    expect(post.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const get = await request(fx.app)
      .get(`/channel/message/${post.body.id}`)
      .set('Authorization', actor.bearer);
    expect(get.status).toBe(200);
    expect(get.body.message.body.trim()).toBe('hi');
  });
});
