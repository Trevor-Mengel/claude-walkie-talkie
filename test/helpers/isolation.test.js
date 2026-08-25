import { describe, test, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  REQUIRED_ROOT_ENV,
  assertDisposable,
  installIsolation,
  isolatedEnv,
  isolationVars,
  makeDisposableRoots
} from './isolation.js';
import { attachNotifier } from '../../src/daemon/notify.js';
import { createFixtureDir } from './fixture-leaks.js';

const MAIN_CHECKOUT = '/Users/trev/Projects/development/collabcast';

function envSnapshot() {
  return { ...process.env };
}

describe('assertDisposable', () => {
  test('rejects the real home directory', () => {
    expect(() => assertDisposable(homedir(), 'COLLABCAST_HOME')).toThrow(/live user state/);
  });

  test('rejects the live collabcast state dir', () => {
    expect(() => assertDisposable(join(homedir(), '.collabcast'), 'COLLABCAST_HOME')).toThrow(
      /live user state/
    );
  });

  test('rejects a path inside the live collabcast state dir', () => {
    expect(() =>
      assertDisposable(join(homedir(), '.collabcast', 'registry.json'), 'registry')
    ).toThrow(/live user state/);
  });

  test('rejects the main checkout', () => {
    expect(() => assertDisposable(MAIN_CHECKOUT, 'COLLABCAST_RUNTIME_ROOT')).toThrow();
  });

  test('rejects a bare relative path', () => {
    expect(() => assertDisposable('.collabcast', 'COLLABCAST_HOME')).toThrow(/must be absolute/);
  });

  test('rejects empty and non-string input', () => {
    expect(() => assertDisposable('', 'COLLABCAST_HOME')).toThrow(/non-empty/);
    expect(() => assertDisposable(undefined, 'COLLABCAST_HOME')).toThrow(/non-empty/);
  });

  test('rejects an absolute path outside the OS temp dir', () => {
    expect(() => assertDisposable('/etc/collabcast', 'COLLABCAST_CONFIG')).toThrow(/OS temp dir/);
  });

  test('accepts a mkdtemp path and a not-yet-existing child of it', () => {
    const dir = createFixtureDir('collabcast-iso-probe-');
    try {
      expect(assertDisposable(dir, 'probe')).toContain('collabcast-iso-probe-');
      expect(() => assertDisposable(join(dir, 'nested', 'collabcast.json'), 'probe')).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('makeDisposableRoots', () => {
  test('places every root under one disposable prefix and cleans up', () => {
    const roots = makeDisposableRoots();
    try {
      for (const key of ['home', 'runtime', 'data', 'history', 'config', 'identities', 'socket']) {
        expect(roots[key]).toBeTypeOf('string');
        expect(() => assertDisposable(roots[key], key)).not.toThrow();
        expect(roots[key].startsWith(roots.base)).toBe(true);
      }
      expect(roots.base).toContain('collabcast-iso-');
    } finally {
      roots.cleanup();
    }
    expect(() => assertDisposable(roots.base, 'base')).not.toThrow();
  });

  test('seeds a valid, empty identity map so a bare loader import cannot explode', () => {
    const roots = makeDisposableRoots();
    try {
      const map = JSON.parse(readFileSync(roots.identities, 'utf8'));
      expect(map).toEqual({ schemaVersion: 1, identities: {} });
    } finally {
      roots.cleanup();
    }
  });
});

describe('installIsolation', () => {
  test('passes for the ambient (globalSetup-provided) environment', () => {
    const state = installIsolation();
    expect(() => assertDisposable(state.home, 'home')).not.toThrow();
    expect(() => assertDisposable(state.config, 'config')).not.toThrow();
    expect(() => assertDisposable(state.runtime, 'runtime')).not.toThrow();
    expect(() => assertDisposable(state.history, 'history')).not.toThrow();
    expect(() => assertDisposable(state.identities, 'identities')).not.toThrow();
    expect(readFileSync(state.identities, 'utf8')).toContain('"schemaVersion": 1');
  });

  test.each(REQUIRED_ROOT_ENV)('throws when %s is unset', (key) => {
    const env = envSnapshot();
    delete env[key];
    expect(() => installIsolation({ env })).toThrow(new RegExp(`${key} is not set`));
  });

  test.each(REQUIRED_ROOT_ENV)('throws when %s points at live state', (key) => {
    const env = envSnapshot();
    env[key] = join(homedir(), '.collabcast');
    expect(() => installIsolation({ env })).toThrow(/live user state/);
  });

  test('throws when COLLABCAST_NO_NOTIFY is unset', () => {
    const env = envSnapshot();
    delete env.COLLABCAST_NO_NOTIFY;
    expect(() => installIsolation({ env })).toThrow(/COLLABCAST_NO_NOTIFY is not set/);
  });

  test.each(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'])('throws when %s is not /dev/null', (key) => {
    const unset = envSnapshot();
    delete unset[key];
    expect(() => installIsolation({ env: unset })).toThrow(new RegExp(`${key} must be /dev/null`));

    const wrong = envSnapshot();
    wrong[key] = join(homedir(), '.gitconfig');
    expect(() => installIsolation({ env: wrong })).toThrow(new RegExp(`${key} must be /dev/null`));
  });

  test('throws when the real process environment loses a guard, then recovers', () => {
    const original = process.env.COLLABCAST_NO_NOTIFY;
    try {
      delete process.env.COLLABCAST_NO_NOTIFY;
      expect(() => installIsolation()).toThrow(/COLLABCAST_NO_NOTIFY is not set/);
    } finally {
      process.env.COLLABCAST_NO_NOTIFY = original;
    }
    expect(() => installIsolation()).not.toThrow();
  });
});

describe('isolationVars', () => {
  test('covers every required key plus the notification and git guards', () => {
    const roots = makeDisposableRoots();
    try {
      const vars = isolationVars(roots);
      for (const key of REQUIRED_ROOT_ENV) expect(vars[key]).toBeTruthy();
      expect(vars.COLLABCAST_NO_NOTIFY).toBe('1');
      expect(vars.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(vars.GIT_CONFIG_SYSTEM).toBe('/dev/null');
      expect(() => installIsolation({ env: vars })).not.toThrow();
    } finally {
      roots.cleanup();
    }
  });
});

describe('isolatedEnv', () => {
  test('carries every required key and no live collabcast home', () => {
    const env = isolatedEnv();
    for (const key of REQUIRED_ROOT_ENV) {
      expect(env[key]).toBeTruthy();
      expect(() => assertDisposable(env[key], key)).not.toThrow();
    }
    expect(env.COLLABCAST_NO_NOTIFY).toBeTruthy();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
    expect(env.COLLABCAST_HOME).not.toBe(homedir());
    expect(env.COLLABCAST_HOME.startsWith(homedir() + '/.collabcast')).toBe(false);
    expect(() => assertDisposable(env.HOME, 'HOME')).not.toThrow();
    expect(env.PATH).toBe(process.env.PATH);
  });

  test('applies extras and drops keys set to undefined', () => {
    const env = isolatedEnv({ COLLABCAST_TOOL: 'claude-code', PATH: undefined });
    expect(env.COLLABCAST_TOOL).toBe('claude-code');
    expect('PATH' in env).toBe(false);
  });

  test('rejects a state-root override that is not disposable', () => {
    expect(() => isolatedEnv({ COLLABCAST_HOME: join(homedir(), '.collabcast') })).toThrow(
      /live user state/
    );
  });

  test('a child spawned with it performs a real write into disposable state', () => {
    // realpathSync: initCommand canonicalises cwd, so on macOS an unresolved
    // /var/... mkdtemp path comes back as /private/var/... and the
    // canonicalRoot assertion below would compare two spellings of one path.
    const childHome = realpathSync(createFixtureDir('collabcast-iso-child-'));
    const project = join(childHome, 'demo');
    mkdirSync(project, { recursive: true });
    try {
      const initModule = pathToFileURL(
        join(dirname(fileURLToPath(import.meta.url)), '../../src/cli/init.js')
      ).href;
      // Dropping COLLABCAST_IDENTITIES is what makes this a COLLABCAST_HOME probe:
      // identitiesPath prefers the explicit file and only then falls back to
      // $COLLABCAST_HOME. initCommand reports to stdout, so the probe line goes to
      // stderr to stay parseable.
      const code = [
        `import { initCommand } from ${JSON.stringify(initModule)};`,
        `import { homedir } from 'node:os';`,
        `await initCommand({ operator: 'Iso Probe', name: 'demo' });`,
        `console.error(JSON.stringify({ homedir: homedir(), collabcastHome: process.env.COLLABCAST_HOME }));`
      ].join('\n');
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: project,
        env: isolatedEnv({ COLLABCAST_HOME: childHome, COLLABCAST_IDENTITIES: undefined }),
        encoding: 'utf8'
      });
      expect(res.status, res.stderr).toBe(0);
      const seen = JSON.parse(res.stderr.trim().split('\n').pop());
      expect(seen.collabcastHome).toBe(childHome);
      // HOME follows the override, so even the homedir() fallback is disposable.
      expect(seen.homedir).toBe(childHome);
      const map = JSON.parse(
        readFileSync(join(childHome, '.collabcast', 'identities.json'), 'utf8')
      );
      expect(Object.keys(map.identities)).toEqual(['demo']);
      expect(map.identities.demo.canonicalRoot).toBe(project);
    } finally {
      rmSync(childHome, { recursive: true, force: true });
    }
  });

  test('refuses to build an env when the ambient guard is broken', () => {
    const original = process.env.COLLABCAST_HOME;
    try {
      process.env.COLLABCAST_HOME = join(homedir(), '.collabcast');
      expect(() => isolatedEnv()).toThrow(/live user state/);
    } finally {
      process.env.COLLABCAST_HOME = original;
    }
  });
});

describe('attachNotifier kill-switch', () => {
  test('registers zero listeners while COLLABCAST_NO_NOTIFY is set', () => {
    const events = new EventEmitter();
    attachNotifier({ events, projectName: 'iso' });
    expect(events.listenerCount('message.posted')).toBe(0);
    expect(events.listenerCount('permit.required')).toBe(0);
    expect(events.eventNames()).toEqual([]);
  });

  test('registers listeners when COLLABCAST_NO_NOTIFY is unset', () => {
    const events = new EventEmitter();
    const original = process.env.COLLABCAST_NO_NOTIFY;
    try {
      delete process.env.COLLABCAST_NO_NOTIFY;
      attachNotifier({ events, projectName: 'iso' });
    } finally {
      process.env.COLLABCAST_NO_NOTIFY = original;
    }
    expect(events.listenerCount('message.posted')).toBe(1);
  });

  test('treats an empty COLLABCAST_NO_NOTIFY as unset', () => {
    const events = new EventEmitter();
    const original = process.env.COLLABCAST_NO_NOTIFY;
    try {
      process.env.COLLABCAST_NO_NOTIFY = '';
      attachNotifier({ events, projectName: 'iso' });
    } finally {
      process.env.COLLABCAST_NO_NOTIFY = original;
    }
    expect(events.listenerCount('message.posted')).toBe(1);
  });
});
