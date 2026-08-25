// The installable identity: the strings a user types, the files npm ships, and the version
// three different manifests each declare independently.
//
// Nothing asserted any of this before, and it had already drifted: `SERVER_VERSION` in the MCP
// server said `0.3.0` while `package.json` and `plugin.json` said `0.2.0`, so the handshake
// advertised a version the package did not claim. That is the same silent-drift class this
// suite has been bitten by twice with `SCHEMA_VERSION` — a value duplicated across files with
// nothing proving the copies agree. Duplication is fine; unasserted duplication is not.
//
// The `files` and `bin` checks exist because a dangling entry in either is SHIPPED breakage
// that no other test can see: `npm pack` silently omits a missing `files` path, and a missing
// `bin` target makes the package uninstallable. Both were verified by hand during the rename,
// which is exactly the kind of check that should not depend on someone remembering.
import { describe, expect, test } from 'vitest';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_NAME, SERVER_VERSION } from '../../src/mcp-server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const pkg = read('package.json');
const lock = read('package-lock.json');
const plugin = read('plugin.json');
const marketplace = read('.claude-plugin/marketplace.json');

describe('package identity', () => {
  test('the package, plugin and MCP server all claim the same version', () => {
    // Asserted as one object so a failure names every disagreeing source at once rather
    // than stopping at the first pair.
    expect({
      package: pkg.version,
      plugin: plugin.version,
      lockRoot: lock.version,
      lockSelf: lock.packages[''].version,
      mcpServer: SERVER_VERSION
    }).toEqual({
      package: pkg.version,
      plugin: pkg.version,
      lockRoot: pkg.version,
      lockSelf: pkg.version,
      mcpServer: pkg.version
    });
  });

  test('the lockfile names the same package', () => {
    // `npm ci` fails hard on either mismatch, and CI runs `npm ci`.
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[''].name).toBe(pkg.name);
  });

  test('the MCP server name matches the package name', () => {
    // The server name is half of the namespaced tool id an agent calls
    // (`mcp__<server>_<tool>`), and the OMP hook gate matches on it.
    expect(SERVER_NAME).toBe(pkg.name);
  });

  test('the install string a user types resolves', () => {
    // `/plugin install <plugins[].name>@<name>`. If either half drifts from the package
    // name the documented command silently installs nothing.
    expect(marketplace.name).toBe(pkg.name);
    expect(marketplace.plugins.map((p) => p.name)).toEqual([pkg.name]);
    for (const p of marketplace.plugins) {
      expect(existsSync(join(ROOT, p.source, 'plugin.json')), `${p.name} source`).toBe(true);
    }
  });

  test('every shipped path in `files` exists', () => {
    const missing = pkg.files.filter((f) => !existsSync(join(ROOT, f)));
    expect(missing, 'listed in package.json `files` but absent from the tree').toEqual([]);
  });

  test('every `bin` target exists and is executable', () => {
    const broken = Object.entries(pkg.bin).filter(([, target]) => {
      const path = join(ROOT, target);
      if (!existsSync(path)) return true;
      try {
        accessSync(path, constants.X_OK);
        return false;
      } catch {
        return true;
      }
    });
    expect(broken, 'bin entries missing or not executable').toEqual([]);
  });

  test('no metadata still advertises a single-harness product', () => {
    // The entire reason for the rename away from `claude-walkie-talkie` is that the product
    // is harness-agnostic, so a `claude-*` keyword or a name carrying `walkie` is now a
    // false claim rather than a stale one.
    const suspect = (s) => /claude|walkie/i.test(s);
    expect(pkg.keywords.filter(suspect), 'package.json keywords').toEqual([]);
    expect([pkg.name, plugin.name, marketplace.name].filter(suspect)).toEqual([]);
    expect(Object.keys(pkg.bin).filter(suspect), 'bin names').toEqual([]);
  });
});
