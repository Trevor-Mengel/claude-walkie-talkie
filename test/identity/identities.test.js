import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IDENTITIES_SCHEMA_VERSION,
  identitiesPath,
  loadIdentities,
  parseIdentities
} from '../../src/identity/identities.js';
import { cleanup, mkdirp, tmpRoot, writeIdentities } from './tmp-git.js';

let base;
let mapPath;

function map(identities, schemaVersion = IDENTITIES_SCHEMA_VERSION) {
  return { schemaVersion, identities };
}

function load(contents, extraEnv = {}, onWarn) {
  writeIdentities(mapPath, contents);
  const warnings = [];
  const result = loadIdentities({
    env: { COLLABCAST_IDENTITIES: mapPath, ...extraEnv },
    onWarn: onWarn ?? ((m) => warnings.push(m))
  });
  return { result, warnings };
}

function expectConfigInvalid(fn) {
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, 'expected a throw').toBeDefined();
  expect(thrown.name).toBe('CollabcastError');
  expect(thrown.code).toBe('config_invalid');
  return thrown;
}

beforeEach(() => {
  base = tmpRoot('collabcast-identities-');
  mapPath = join(base, 'identities.json');
});

afterEach(() => cleanup(base));

describe('identitiesPath precedence', () => {
  it('prefers COLLABCAST_IDENTITIES, then COLLABCAST_HOME, then HOME', () => {
    expect(
      identitiesPath({
        env: { COLLABCAST_IDENTITIES: '/x/custom.json', COLLABCAST_HOME: '/h', HOME: '/u' }
      })
    ).toEqual({ path: '/x/custom.json', origin: 'COLLABCAST_IDENTITIES' });

    expect(identitiesPath({ env: { COLLABCAST_HOME: '/h', HOME: '/u' } })).toEqual({
      path: '/h/.collabcast/identities.json',
      origin: 'COLLABCAST_HOME'
    });

    expect(identitiesPath({ env: { HOME: '/u' } })).toEqual({
      path: '/u/.collabcast/identities.json',
      origin: 'home'
    });
  });

  it('loads from $COLLABCAST_HOME/.collabcast/identities.json', () => {
    const home = mkdirp(join(base, 'home'));
    const root = mkdirp(join(base, 'proj'));
    writeIdentities(
      join(home, '.collabcast', 'identities.json'),
      map({ 'collabcast': { canonicalRoot: root, registrations: [root] } })
    );
    const loaded = loadIdentities({ env: { COLLABCAST_HOME: home }, onWarn: () => {} });
    expect(loaded.identities['collabcast'].canonicalRoot).toBe(root);
  });
});

describe('loadIdentities', () => {
  it('normalizes, dedupes, and freezes a valid map', () => {
    const root = mkdirp(join(base, 'proj'));
    const alt = mkdirp(join(base, 'checkouts', 'alt'));
    const { result } = load(
      map({
        'collabcast': {
          canonicalRoot: root,
          registrations: [root, alt, alt],
          paseoProjectKey: 'remote:github.com/owner/repo'
        }
      })
    );
    const entry = result.identities['collabcast'];
    expect(entry.namespace).toBe('collabcast');
    expect(entry.canonicalRoot).toBe(root);
    expect(entry.registrations).toEqual([root, alt]);
    expect(entry.paseoProjectKey).toBe('remote:github.com/owner/repo');
    expect(Object.isFrozen(result.identities)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(result.source).toBe(mapPath);
  });

  it('rejects a map whose schemaVersion is not 1', () => {
    const root = mkdirp(join(base, 'proj'));
    const err = expectConfigInvalid(() =>
      load(map({ ns: { canonicalRoot: root, registrations: [root] } }, 2))
    );
    expect(err.message).toMatch(/schemaVersion must be 1/);
  });

  it('rejects namespace keys that do not match the namespace grammar', () => {
    const root = mkdirp(join(base, 'proj'));
    for (const bad of ['Collabcast', '1collabcast', 'collabcast_talkie', '', 'a'.repeat(65)]) {
      expectConfigInvalid(() =>
        load(map({ [bad]: { canonicalRoot: root, registrations: [root] } }))
      );
    }
  });

  it('rejects relative paths', () => {
    const err = expectConfigInvalid(() =>
      load(map({ ns: { canonicalRoot: 'proj', registrations: ['proj'] } }))
    );
    expect(err.message).toMatch(/must be an absolute path/);
  });

  it('rejects a canonicalRoot missing from its own registrations', () => {
    const root = mkdirp(join(base, 'proj'));
    const other = mkdirp(join(base, 'other'));
    const err = expectConfigInvalid(() =>
      load(map({ ns: { canonicalRoot: root, registrations: [other] } }))
    );
    expect(err.message).toMatch(/canonicalRoot must also be listed/);
  });

  it('rejects a path registered under two namespaces, naming both', () => {
    const shared = mkdirp(join(base, 'shared'));
    const other = mkdirp(join(base, 'other'));
    const err = expectConfigInvalid(() =>
      load(
        map({
          alpha: { canonicalRoot: shared, registrations: [shared] },
          beta: { canonicalRoot: other, registrations: [other, shared] }
        })
      )
    );
    expect(err.message).toContain('alpha');
    expect(err.message).toContain('beta');
    expect(err.detail.namespaces).toEqual(['alpha', 'beta']);
    expect(err.detail.path).toBe(shared);
  });

  it('rejects unknown keys and non-object shapes', () => {
    const root = mkdirp(join(base, 'proj'));
    expectConfigInvalid(() =>
      load(map({ ns: { canonicalRoot: root, registrations: [root], nope: 1 } }))
    );
    expectConfigInvalid(() => load({ schemaVersion: 1, identities: {}, extra: true }));
    expectConfigInvalid(() => load(map({ ns: [root] })));
    expectConfigInvalid(() => parseIdentities([1, 2, 3]));
  });

  it('rejects an empty or non-array registrations list', () => {
    const root = mkdirp(join(base, 'proj'));
    expectConfigInvalid(() => load(map({ ns: { canonicalRoot: root, registrations: [] } })));
    expectConfigInvalid(() => load(map({ ns: { canonicalRoot: root, registrations: root } })));
  });

  it('rejects an empty paseoProjectKey but allows it to be absent', () => {
    const root = mkdirp(join(base, 'proj'));
    expectConfigInvalid(() =>
      load(map({ ns: { canonicalRoot: root, registrations: [root], paseoProjectKey: '' } }))
    );
    const { result } = load(map({ ns: { canonicalRoot: root, registrations: [root] } }));
    expect(result.identities.ns.paseoProjectKey).toBeNull();
  });

  it('rejects invalid JSON and a missing map', () => {
    writeFileSync(mapPath, '{ not json');
    expectConfigInvalid(() =>
      loadIdentities({ env: { COLLABCAST_IDENTITIES: mapPath }, onWarn: () => {} })
    );
    const err = expectConfigInvalid(() =>
      loadIdentities({
        env: { COLLABCAST_IDENTITIES: join(base, 'absent.json') },
        onWarn: () => {}
      })
    );
    expect(err.message).toMatch(/no collabcast identity map found/);
  });

  // Writable and readable are different questions, and one mask cannot answer both.
  //
  // This map decides which `canonicalRoot` a namespace resolves to. Someone who can WRITE it
  // repoints a namespace at a tree they control, so that is a refusal. Someone who can merely
  // READ it learns a directory path anyone able to `ls` the checkout already knows, so that is a
  // warning — refusing there would brick a boot on a map that arrived at 0644 from an older
  // version, a copy, a restore, or a plain umask, and buy nothing for it.
  it('refuses a group- or other-WRITABLE map, naming the path and the chmod', () => {
    const root = mkdirp(join(base, 'proj'));
    const contents = map({ ns: { canonicalRoot: root, registrations: [root] } });
    writeIdentities(mapPath, contents);

    // 0620: group-writable but not group-readable. Writability alone is the disqualifier.
    for (const mode of [0o620, 0o664, 0o666, 0o602]) {
      chmodSync(mapPath, mode);
      const err = expectConfigInvalid(() =>
        loadIdentities({ env: { COLLABCAST_IDENTITIES: mapPath }, onWarn: () => {} })
      );
      expect(err.message).toMatch(/group\/other-writable/);
      expect(err.message).toContain(mapPath);
      expect(err.message).toContain(`chmod 600 ${mapPath}`);
      expect(err.detail.mode).toBe(mode.toString(8));
      expect(err.detail.path).toBe(mapPath);
    }
  });

  it('LOADS a group- or other-readable map, with a warning naming the chmod', () => {
    // The assertion that proves the guard is not over-tightened: 0644 is the mode a copy or a
    // default umask produces, and a legitimate install must still boot.
    const root = mkdirp(join(base, 'proj'));
    const contents = map({ ns: { canonicalRoot: root, registrations: [root] } });
    writeIdentities(mapPath, contents);

    for (const mode of [0o640, 0o604, 0o644]) {
      chmodSync(mapPath, mode);
      /** @type {string[]} */
      const warnings = [];
      const loaded = loadIdentities({
        env: { COLLABCAST_IDENTITIES: mapPath },
        onWarn: (m) => warnings.push(m)
      });
      expect(loaded.identities.ns.canonicalRoot).toBe(root);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        new RegExp(`group/other-readable \\(mode 0${mode.toString(8)}\\)`)
      );
      expect(warnings[0]).toContain(`chmod 600 ${mapPath}`);
    }
  });

  it('loads a 0600 map silently — the mode `collabcast init` writes', () => {
    const root = mkdirp(join(base, 'proj'));
    writeIdentities(mapPath, map({ ns: { canonicalRoot: root, registrations: [root] } }));
    chmodSync(mapPath, 0o600);
    /** @type {string[]} */
    const warnings = [];
    expect(
      loadIdentities({ env: { COLLABCAST_IDENTITIES: mapPath }, onWarn: (m) => warnings.push(m) })
    ).toBeTruthy();
    expect(warnings).toEqual([]);
  });
});
