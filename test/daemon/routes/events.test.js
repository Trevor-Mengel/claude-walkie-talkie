// The SSE event allowlist drifted silently through the P0 cutover: six of its ten
// entries were dead (invitations, sessions and the per-post permit gate all went
// away) while still advertising themselves to every subscriber. Nothing asserted
// the list, so nothing failed.
//
// This file pins the allowlist against the emitters in `src/` by reading the
// source, so adding an emitter without listing it — or retiring one and leaving
// it listed — fails here instead of shipping misleading API surface.
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_TYPES } from '../../../src/daemon/routes/events.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');

/** Every `.js` file under src/, recursively. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith('.js')) out.push(path);
  }
  return out;
}

/**
 * Dotted event names passed to an `emit(...)` call. Deliberately a source scan
 * rather than a runtime capture: a runtime test only sees the events the test
 * itself provokes, which is exactly how six dead entries survived.
 */
function emittedEventNames() {
  const names = new Set();
  for (const path of sourceFiles(SRC)) {
    // `events.js` lists the names; it does not emit them.
    if (path.endsWith(join('routes', 'events.js'))) continue;
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/emit\(\s*(?:req\s*,\s*)?'([a-z]+\.[a-z_]+)'/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

describe('SSE event allowlist', () => {
  test('lists exactly the events src/ emits — no dead entries, no unlisted ones', () => {
    const emitted = emittedEventNames();
    // Sorted both sides so the diff on failure names the offending event.
    expect([...EVENT_TYPES].sort()).toEqual([...emitted].sort());
  });

  test('the retired v0.2 event names are gone', () => {
    // Each of these was live in v0.2 and is unreachable after the cutover.
    for (const dead of [
      'mention.fulfilled',
      'session.joined',
      'session.renamed',
      'permit.granted',
      'permit.revoked',
      'permit.required'
    ]) {
      expect(EVENT_TYPES).not.toContain(dead);
    }
  });

  test('every listed event is a dotted lower-case name', () => {
    for (const name of EVENT_TYPES) expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  test('the list has no duplicates', () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});
