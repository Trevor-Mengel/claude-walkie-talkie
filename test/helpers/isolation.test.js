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

const MAIN_CHECKOUT = '/Users/trev/Projects/development/claude-walkie-talkie';

function envSnapshot() {
  return { ...process.env };
}

describe('assertDisposable', () => {
  test('rejects the real home directory', () => {
    expect(() => assertDisposable(homedir(), 'WALKIE_HOME')).toThrow(/live user state/);
  });

  test('rejects the live walkie state dir', () => {
    expect(() => assertDisposable(join(homedir(), '.walkie-talkie'), 'WALKIE_HOME')).toThrow(
      /live user state/
    );
  });

  test('rejects a path inside the live walkie state dir', () => {
    expect(() =>
      assertDisposable(join(homedir(), '.walkie-talkie', 'registry.json'), 'registry')
    ).toThrow(/live user state/);
  });

  test('rejects the main checkout', () => {
    expect(() => assertDisposable(MAIN_CHECKOUT, 'WALKIE_RUNTIME_ROOT')).toThrow();
  });

  test('rejects a bare relative path', () => {
    expect(() => assertDisposable('.walkie-talkie', 'WALKIE_HOME')).toThrow(/must be absolute/);
  });

  test('rejects empty and non-string input', () => {
    expect(() => assertDisposable('', 'WALKIE_HOME')).toThrow(/non-empty/);
    expect(() => assertDisposable(undefined, 'WALKIE_HOME')).toThrow(/non-empty/);
  });

  test('rejects an absolute path outside the OS temp dir', () => {
    expect(() => assertDisposable('/etc/walkie', 'WALKIE_CONFIG')).toThrow(/OS temp dir/);
  });

  test('accepts a mkdtemp path and a not-yet-existing child of it', () => {
    const dir = createFixtureDir('walkie-iso-probe-');
    try {
      expect(assertDisposable(dir, 'probe')).toContain('walkie-iso-probe-');
      expect(() => assertDisposable(join(dir, 'nested', 'walkie.json'), 'probe')).not.toThrow();
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
      expect(roots.base).toContain('walkie-iso-');
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
    env[key] = join(homedir(), '.walkie-talkie');
    expect(() => installIsolation({ env })).toThrow(/live user state/);
  });

  test('throws when WALKIE_NO_NOTIFY is unset', () => {
    const env = envSnapshot();
    delete env.WALKIE_NO_NOTIFY;
    expect(() => installIsolation({ env })).toThrow(/WALKIE_NO_NOTIFY is not set/);
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
    const original = process.env.WALKIE_NO_NOTIFY;
    try {
      delete process.env.WALKIE_NO_NOTIFY;
      expect(() => installIsolation()).toThrow(/WALKIE_NO_NOTIFY is not set/);
    } finally {
      process.env.WALKIE_NO_NOTIFY = original;
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
      expect(vars.WALKIE_NO_NOTIFY).toBe('1');
      expect(vars.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(vars.GIT_CONFIG_SYSTEM).toBe('/dev/null');
      expect(() => installIsolation({ env: vars })).not.toThrow();
    } finally {
      roots.cleanup();
    }
  });
});

describe('isolatedEnv', () => {
  test('carries every required key and no live walkie home', () => {
    const env = isolatedEnv();
    for (const key of REQUIRED_ROOT_ENV) {
      expect(env[key]).toBeTruthy();
      expect(() => assertDisposable(env[key], key)).not.toThrow();
    }
    expect(env.WALKIE_NO_NOTIFY).toBeTruthy();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
    expect(env.WALKIE_HOME).not.toBe(homedir());
    expect(env.WALKIE_HOME.startsWith(homedir() + '/.walkie-talkie')).toBe(false);
    expect(() => assertDisposable(env.HOME, 'HOME')).not.toThrow();
    expect(env.PATH).toBe(process.env.PATH);
  });

  test('applies extras and drops keys set to undefined', () => {
    const env = isolatedEnv({ WALKIE_TOOL: 'claude-code', PATH: undefined });
    expect(env.WALKIE_TOOL).toBe('claude-code');
    expect('PATH' in env).toBe(false);
  });

  test('rejects a state-root override that is not disposable', () => {
    expect(() => isolatedEnv({ WALKIE_HOME: join(homedir(), '.walkie-talkie') })).toThrow(
      /live user state/
    );
  });

  test('a child spawned with it performs a real write into disposable state', () => {
    // realpathSync: initCommand canonicalises cwd, so on macOS an unresolved
    // /var/... mkdtemp path comes back as /private/var/... and the
    // canonicalRoot assertion below would compare two spellings of one path.
    const childHome = realpathSync(createFixtureDir('walkie-iso-child-'));
    const project = join(childHome, 'demo');
    mkdirSync(project, { recursive: true });
    try {
      const initModule = pathToFileURL(
        join(dirname(fileURLToPath(import.meta.url)), '../../src/cli/init.js')
      ).href;
      // Dropping WALKIE_IDENTITIES is what makes this a WALKIE_HOME probe:
      // identitiesPath prefers the explicit file and only then falls back to
      // $WALKIE_HOME. initCommand reports to stdout, so the probe line goes to
      // stderr to stay parseable.
      const code = [
        `import { initCommand } from ${JSON.stringify(initModule)};`,
        `import { homedir } from 'node:os';`,
        `await initCommand({ operator: 'Iso Probe', name: 'demo' });`,
        `console.error(JSON.stringify({ homedir: homedir(), walkieHome: process.env.WALKIE_HOME }));`
      ].join('\n');
      const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: project,
        env: isolatedEnv({ WALKIE_HOME: childHome, WALKIE_IDENTITIES: undefined }),
        encoding: 'utf8'
      });
      expect(res.status, res.stderr).toBe(0);
      const seen = JSON.parse(res.stderr.trim().split('\n').pop());
      expect(seen.walkieHome).toBe(childHome);
      // HOME follows the override, so even the homedir() fallback is disposable.
      expect(seen.homedir).toBe(childHome);
      const map = JSON.parse(
        readFileSync(join(childHome, '.walkie-talkie', 'identities.json'), 'utf8')
      );
      expect(Object.keys(map.identities)).toEqual(['demo']);
      expect(map.identities.demo.canonicalRoot).toBe(project);
    } finally {
      rmSync(childHome, { recursive: true, force: true });
    }
  });

  test('refuses to build an env when the ambient guard is broken', () => {
    const original = process.env.WALKIE_HOME;
    try {
      process.env.WALKIE_HOME = join(homedir(), '.walkie-talkie');
      expect(() => isolatedEnv()).toThrow(/live user state/);
    } finally {
      process.env.WALKIE_HOME = original;
    }
  });
});

describe('attachNotifier kill-switch', () => {
  test('registers zero listeners while WALKIE_NO_NOTIFY is set', () => {
    const events = new EventEmitter();
    attachNotifier({ events, projectName: 'iso' });
    expect(events.listenerCount('message.posted')).toBe(0);
    expect(events.listenerCount('permit.required')).toBe(0);
    expect(events.eventNames()).toEqual([]);
  });

  test('registers listeners when WALKIE_NO_NOTIFY is unset', () => {
    const events = new EventEmitter();
    const original = process.env.WALKIE_NO_NOTIFY;
    try {
      delete process.env.WALKIE_NO_NOTIFY;
      attachNotifier({ events, projectName: 'iso' });
    } finally {
      process.env.WALKIE_NO_NOTIFY = original;
    }
    expect(events.listenerCount('message.posted')).toBe(1);
  });

  test('treats an empty WALKIE_NO_NOTIFY as unset', () => {
    const events = new EventEmitter();
    const original = process.env.WALKIE_NO_NOTIFY;
    try {
      process.env.WALKIE_NO_NOTIFY = '';
      attachNotifier({ events, projectName: 'iso' });
    } finally {
      process.env.WALKIE_NO_NOTIFY = original;
    }
    expect(events.listenerCount('message.posted')).toBe(1);
  });
});
