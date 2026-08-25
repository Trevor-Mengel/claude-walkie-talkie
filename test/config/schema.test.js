import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  TRANSPORT_LIMITS,
  defaultHistoryDir,
  storeDir,
  validateConfig
} from '../../src/config/schema.js';
import { cleanup, tmpRoot } from '../identity/tmp-git.js';

let root;

function base(overrides = {}) {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, namespace: 'collabcast', ...overrides };
}

function validate(raw, opts = {}) {
  return validateConfig(raw, { canonicalRoot: root, ...opts });
}

function expectInvalid(raw, opts = {}) {
  let thrown;
  try {
    validate(raw, opts);
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `expected config_invalid for ${JSON.stringify(raw)}`).toBeDefined();
  expect(thrown.name).toBe('CollabcastError');
  expect(thrown.code).toBe('config_invalid');
  return thrown;
}

beforeEach(() => {
  root = tmpRoot('collabcast-config-');
});

afterEach(() => cleanup(root));

describe('DEFAULT_CONFIG owns every default', () => {
  it('pins the documented defaults', () => {
    expect(DEFAULT_CONFIG.retention.hotDays).toBe(90);
    expect(DEFAULT_CONFIG.retention.snapshotGenerations).toBe(30);
    expect(DEFAULT_CONFIG.retention.pruneCadence).toBe('weekly');
    expect(DEFAULT_CONFIG.schemaVersion).toBe(3);
    expect(DEFAULT_CONFIG.mode).toBe('managed');
    expect(DEFAULT_CONFIG.transport).toEqual({
      unixSocket: true,
      socketPath: null,
      maxBodyBytes: 1048576,
      tcp: { enabled: false, host: '127.0.0.1', port: 0 }
    });
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.retention)).toBe(true);
  });

  it('is the only place a retention default literal appears', () => {
    const consuming = [
      join('src', 'config', 'load.js'),
      ...readdirSync(join('src', 'identity')).map((f) => join('src', 'identity', f))
    ];
    const offenders = consuming.filter((file) =>
      /(?<![\w.])(90|30|weekly)(?![\w.])/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it('applies every default for a minimal config', () => {
    expect(validate(base())).toEqual({
      schemaVersion: 3,
      namespace: 'collabcast',
      mode: DEFAULT_CONFIG.mode,
      transport: {
        unixSocket: true,
        socketPath: null,
        maxBodyBytes: DEFAULT_CONFIG.transport.maxBodyBytes,
        tcp: { enabled: false, host: '127.0.0.1', port: 0 }
      },
      retention: {
        hotDays: DEFAULT_CONFIG.retention.hotDays,
        snapshotGenerations: DEFAULT_CONFIG.retention.snapshotGenerations,
        pruneCadence: DEFAULT_CONFIG.retention.pruneCadence,
        historyDir: defaultHistoryDir(root)
      },
      routing: { root: null, hubs: {} }
    });
  });
});

describe('retention validation', () => {
  it('rejects out-of-range, non-integer, and non-number hotDays', () => {
    for (const hotDays of [0, -1, 3651, '90', 90.5, null, true]) {
      expectInvalid(base({ retention: { hotDays } }));
    }
  });

  it('accepts the boundary hotDays values', () => {
    expect(validate(base({ retention: { hotDays: 1 } })).retention.hotDays).toBe(1);
    expect(validate(base({ retention: { hotDays: 3650 } })).retention.hotDays).toBe(3650);
  });

  it('requires snapshotGenerations >= 2', () => {
    expectInvalid(base({ retention: { snapshotGenerations: 1 } }));
    expectInvalid(base({ retention: { snapshotGenerations: 0 } }));
    expectInvalid(base({ retention: { snapshotGenerations: 2.5 } }));
    expect(
      validate(base({ retention: { snapshotGenerations: 2 } })).retention.snapshotGenerations
    ).toBe(2);
  });

  it('rejects an unknown pruneCadence', () => {
    expectInvalid(base({ retention: { pruneCadence: 'hourly' } }));
    expectInvalid(base({ retention: { pruneCadence: 'Weekly' } }));
    for (const pruneCadence of ['daily', 'weekly', 'monthly']) {
      expect(validate(base({ retention: { pruneCadence } })).retention.pruneCadence).toBe(
        pruneCadence
      );
    }
  });

  it('rejects an unknown retention key', () => {
    expectInvalid(base({ retention: { coldDays: 5 } }));
  });
});

describe('historyDir containment', () => {
  it('rejects a historyDir outside canonicalRoot', () => {
    const outside = tmpRoot('collabcast-outside-');
    try {
      const err = expectInvalid(base({ retention: { historyDir: join(outside, 'history') } }));
      expect(err.message).toMatch(/must be inside canonicalRoot/);
    } finally {
      cleanup(outside);
    }
  });

  it('rejects a historyDir equal to canonicalRoot', () => {
    const err = expectInvalid(base({ retention: { historyDir: root } }));
    expect(err.message).toMatch(/must not be the canonicalRoot itself/);
  });

  it('rejects a historyDir that contains, equals, or nests under the live store dir', () => {
    const live = storeDir(root);
    for (const historyDir of [join(root, '.collabcast'), live, join(live, 'nested')]) {
      const err = expectInvalid(base({ retention: { historyDir } }));
      expect(err.message).toMatch(/must not overlap the live store directory/);
    }
  });

  it('accepts a sibling history dir and resolves a relative one', () => {
    expect(
      validate(base({ retention: { historyDir: join(root, 'snapshots') } })).retention.historyDir
    ).toBe(join(root, 'snapshots'));
    expect(
      validate(base({ retention: { historyDir: '.collabcast/history' } })).retention.historyDir
    ).toBe(defaultHistoryDir(root));
  });

  it('honours an explicit storeDir override', () => {
    const err = expectInvalid(base({ retention: { historyDir: join(root, 'snapshots') } }), {
      storeDir: join(root, 'snapshots', 'db')
    });
    expect(err.message).toMatch(/must not overlap the live store directory/);
  });
});

describe('transport validation', () => {
  it('rejects a non-loopback host when tcp is enabled', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', 'localhost', '::']) {
      expectInvalid(base({ transport: { tcp: { enabled: true, host } } }));
    }
  });

  it('accepts loopback hosts when tcp is enabled', () => {
    for (const host of ['127.0.0.1', '::1']) {
      expect(validate(base({ transport: { tcp: { enabled: true, host } } })).transport.tcp).toEqual({
        enabled: true,
        host,
        port: 0
      });
    }
  });

  it('does not police the host while tcp is disabled', () => {
    expect(
      validate(base({ transport: { tcp: { enabled: false, host: '0.0.0.0' } } })).transport.tcp.host
    ).toBe('0.0.0.0');
  });

  it('rejects non-boolean flags and unknown transport keys', () => {
    expectInvalid(base({ transport: { unixSocket: 'yes' } }));
    expectInvalid(base({ transport: { tcp: { enabled: 1 } } }));
    expectInvalid(base({ transport: { http: true } }));
  });

  it('validates tcp.port as an integer in 0..65535', () => {
    expectInvalid(base({ transport: { tcp: { port: -1 } } }));
    expectInvalid(base({ transport: { tcp: { port: 65536 } } }));
    expectInvalid(base({ transport: { tcp: { port: 8080.5 } } }));
    expectInvalid(base({ transport: { tcp: { port: '8080' } } }));
    expect(validate(base({ transport: { tcp: { port: 65535 } } })).transport.tcp.port).toBe(65535);
  });

  // Port 0 asks the kernel for an ephemeral port. With no Unix socket and no port file,
  // `resolveClientContext` hands every client `{ host, port: 0 }`, so the service binds,
  // reports healthy, and every call fails `unavailable` — telling the operator to run
  // `collabcast start` for a service that is already running.
  it('rejects a tcp-only transport left on the ephemeral port', () => {
    const err = expectInvalid(
      base({ transport: { unixSocket: false, tcp: { enabled: true, port: 0 } } })
    );
    expect(err.message).toMatch(/transport\.tcp\.port/);
    expect(err.message).toMatch(/non-zero/);
    expect(err.detail).toMatchObject({ port: 0, unixSocket: false });
  });

  it('rejects it whether or not tcp says it is enabled, and by default', () => {
    expectInvalid(base({ transport: { unixSocket: false, tcp: { enabled: false, port: 0 } } }));
    // tcp.port defaults to 0, so an operator who only turns the socket off lands here too.
    expectInvalid(base({ transport: { unixSocket: false } }));
  });

  it('accepts a tcp-only transport on a fixed port', () => {
    expect(
      validate(base({ transport: { unixSocket: false, tcp: { enabled: true, port: 8123 } } }))
        .transport
    ).toMatchObject({ unixSocket: false, tcp: { enabled: true, host: '127.0.0.1', port: 8123 } });
  });

  it('still allows the ephemeral port while the Unix socket is serving', () => {
    // With the socket on, tcp is only ever an extra listener nobody has to find.
    expect(
      validate(base({ transport: { unixSocket: true, tcp: { enabled: true, port: 0 } } })).transport
        .tcp.port
    ).toBe(0);
  });

  it('bounds maxBodyBytes', () => {
    expectInvalid(base({ transport: { maxBodyBytes: 1023 } }));
    expectInvalid(base({ transport: { maxBodyBytes: TRANSPORT_LIMITS.maxBodyBytesMax + 1 } }));
    expectInvalid(base({ transport: { maxBodyBytes: '1mb' } }));
    expect(validate(base({ transport: { maxBodyBytes: 4096 } })).transport.maxBodyBytes).toBe(4096);
  });

  it('requires socketPath to be absolute when set', () => {
    expectInvalid(base({ transport: { socketPath: 'collabcast.sock' } }));
    expectInvalid(base({ transport: { socketPath: '' } }));
    expectInvalid(base({ transport: { socketPath: 42 } }));
    expect(validate(base({ transport: { socketPath: null } })).transport.socketPath).toBeNull();
  });

  it('rejects a socketPath whose existing parent directory is not owner-only', () => {
    const loose = join(root, 'loose-run');
    mkdirSync(loose, { recursive: true });
    chmodSync(loose, 0o755);
    expectInvalid(base({ transport: { socketPath: join(loose, 'collabcast.sock') } }));
    chmodSync(loose, 0o700);
    expect(
      validate(base({ transport: { socketPath: join(loose, 'collabcast.sock') } })).transport.socketPath
    ).toBe(join(loose, 'collabcast.sock'));
  });

  it('accepts a socketPath whose parent does not exist yet', () => {
    const path = join(root, 'not-yet', 'collabcast.sock');
    expect(validate(base({ transport: { socketPath: path } })).transport.socketPath).toBe(path);
  });
});

describe('envelope-level validation', () => {
  it('requires schemaVersion 3', () => {
    expectInvalid({ schemaVersion: 2, namespace: 'collabcast' });
    expectInvalid({ namespace: 'collabcast' });
    expectInvalid({ schemaVersion: '3', namespace: 'collabcast' });
  });

  it('requires a well-formed namespace and rejects a mismatch with the resolved one', () => {
    expectInvalid(base({ namespace: 'Collabcast' }));
    expectInvalid({ schemaVersion: 3 });
    const err = expectInvalid(base(), { expectNamespace: 'other-ns' });
    expect(err.message).toMatch(/resolves to other-ns/);
    expect(validate(base(), { expectNamespace: 'collabcast' }).namespace).toBe('collabcast');
  });

  it('rejects unknown top-level keys, bad modes, and non-objects', () => {
    expectInvalid(base({ retentionn: {} }));
    expectInvalid(base({ mode: 'yolo' }));
    expectInvalid([]);
    expectInvalid(null);
    for (const mode of ['managed', 'standalone']) {
      expect(validate(base({ mode })).mode).toBe(mode);
    }
  });

  it('requires an absolute canonicalRoot', () => {
    expect(() => validateConfig(base(), { canonicalRoot: 'relative/path' })).toThrow(
      /canonicalRoot must be an absolute path/
    );
    expect(() => validateConfig(base(), {})).toThrow(/canonicalRoot must be an absolute path/);
  });

  it('validates routing targets', () => {
    expectInvalid(base({ routing: { root: {} } }));
    expectInvalid(base({ routing: { hubs: { alpha: { paseoAgentId: '' } } } }));
    expectInvalid(base({ routing: { hubs: { alpha: { agent: 'x' } } } }));
    expect(
      validate(
        base({
          routing: { root: { paseoAgentId: 'agt_1' }, hubs: { alpha: { paseoAgentId: 'agt_2' } } }
        })
      ).routing
    ).toEqual({ root: { paseoAgentId: 'agt_1' }, hubs: { alpha: { paseoAgentId: 'agt_2' } } });
  });
});
