// The enrollment contract has three surfaces — policy, the tool schema and SKILL.md — and a
// fresh agent reads two of them to satisfy the third. All three drifted apart silently:
//
//   - `collabcast_enroll`'s input schema had no `required` array at all, so `{}` was an
//     advertised-legal call and the operator got an approval dialog describing nothing.
//   - its only `role` example was `listener`, which `assertEnrollable` refuses with `forbidden`.
//     The schema's sole hint named the one answer that cannot work.
//   - SKILL.md still documented `collabcast permit <session-id> --once`, a CLI command deleted
//     in P0, and told the agent to expect `permit_required` from `collabcast_talk`.
//
// A rename pass or a doc edit cannot catch any of that, because nothing compared the surfaces.
// This file compares them, treating `src/authority/policy.js` as the source of truth. The schema
// is read off a LIVE `listTools` from a spawned child, not imported, so what is asserted is what
// ships to a model.

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegisteredNamespace } from '../helpers/registered-namespace.js';
import { spawnMockClient } from '../helpers/mock-mcp-client.js';
import { ENROLL_ROLE, ENROLLABLE_ROLES, ROLE_SCOPES } from '../../src/authority/policy.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL_PATH = join(PKG_ROOT, 'skills', 'collabcast', 'SKILL.md');

/**
 * The subset of JSON Schema these tool schemas actually use, applied generically so the check
 * is driven by the published document rather than by a copy of it. Deleting `required` from the
 * schema makes the omission cases pass, which is what makes this test load-bearing.
 *
 * @param {Record<string, any>} schema
 * @param {unknown} value
 * @returns {string[]} one reason per violation; empty means the schema accepts the value
 */
function violations(schema, value) {
  const out = [];
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['not an object'];
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) out.push(`missing ${key}`);
    }
    for (const [key, held] of Object.entries(value)) {
      const property = props[key];
      if (!property) {
        if (schema.additionalProperties === false) out.push(`unexpected ${key}`);
        continue;
      }
      out.push(...violations(property, held).map((reason) => `${key}: ${reason}`));
    }
    return out;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return ['not an array'];
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push(`fewer than ${schema.minItems} items`);
    }
    if (schema.items) {
      for (const item of value) out.push(...violations(schema.items, item));
    }
    return out;
  }
  if (schema.type === 'string' && typeof value !== 'string') out.push('not a string');
  if (schema.type === 'number' && typeof value !== 'number') out.push('not a number');
  if (schema.type === 'boolean' && typeof value !== 'boolean') out.push('not a boolean');
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    out.push(`${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  return out;
}

/** Every backtick-quoted span in a Markdown document. */
function codeSpans(markdown) {
  return [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

/** The commander subcommands `bin/collabcast.js` actually registers. */
function cliCommands() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'cli', 'index.js'), 'utf8');
  const names = [...source.matchAll(/\.command\('([a-z][a-z-]*)/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error('found no CLI commands; the parse has drifted');
  return new Set(names);
}

describe('the published collabcast_enroll schema', () => {
  /** @type {Awaited<ReturnType<typeof spawnMockClient>>} */
  let client;
  /** @type {ReturnType<typeof createRegisteredNamespace>} */
  let ns;
  /** @type {Record<string, any>} */
  let schema;
  /** @type {string[]} */
  let toolNames;

  beforeAll(async () => {
    // Managed mode with nothing listening: serving the inventory needs no service at all, and
    // this asserts the shipped document rather than the module's private object.
    // `autoCleanup` is off because `onTestFinished` is unavailable in a `beforeAll` hook, and a
    // silently unregistered cleanup leaks a temp dir the drift guard then fails the run over.
    ns = createRegisteredNamespace({ mode: 'managed', autoCleanup: false });
    client = await spawnMockClient({ env: ns.env, cwd: ns.canonicalRoot, name: 'schema-reader' });
    const tools = await client.listTools();
    toolNames = tools.map((t) => t.name);
    schema = tools.find((t) => t.name === 'collabcast_enroll').inputSchema;
  }, 30000);

  afterAll(async () => {
    await client?.close();
    ns?.cleanup();
  });

  test('requires namespace, role and scopes', () => {
    expect([...(schema.required ?? [])].sort()).toEqual(['namespace', 'role', 'scopes']);
  });

  test('refuses a call that omits any of the three', () => {
    const complete = { namespace: 'collabcast-demo', role: ENROLL_ROLE, scopes: ['channel:read'] };
    expect(violations(schema, complete)).toEqual([]);

    // The call a model could make against the old schema: nothing to show the operator.
    expect(violations(schema, {})).toEqual(
      expect.arrayContaining(['missing namespace', 'missing role', 'missing scopes'])
    );
    for (const key of ['namespace', 'role', 'scopes']) {
      const partial = { ...complete };
      delete partial[key];
      expect(violations(schema, partial), key).toContain(`missing ${key}`);
    }
    // An empty scope list is no more describable than a missing one.
    expect(violations(schema, { ...complete, scopes: [] })).toContain('scopes: fewer than 1 items');
  });

  test('advertises exactly the roles policy will enroll', () => {
    expect(schema.properties.role.enum).toEqual([...ENROLLABLE_ROLES]);
    for (const role of Object.keys(ROLE_SCOPES)) {
      const enrollable = ENROLLABLE_ROLES.includes(role);
      expect(violations(schema, { namespace: 'n', role, scopes: ['channel:read'] }), role).toEqual(
        enrollable ? [] : expect.arrayContaining([expect.stringContaining('is not one of')])
      );
    }
  });

  test('never offers a non-enrollable role as an example', () => {
    // `role: { description: '… e.g. listener' }` was the whole defect: the one worked example
    // named a role `assertEnrollable` refuses. Any prose naming such a role is a repeat.
    const prose = [
      schema.properties.role.description ?? '',
      schema.properties.scopes.description ?? '',
      schema.properties.namespace.description ?? ''
    ].join(' ');
    for (const role of Object.keys(ROLE_SCOPES).filter((r) => !ENROLLABLE_ROLES.includes(r))) {
      expect(prose, role).not.toMatch(new RegExp(`e\\.g\\.[^.]*\\b${role}\\b`, 'i'));
    }
    expect(schema.properties.role.description).toContain(ENROLL_ROLE);
  });

  test('still keeps enrollmentCode out of the model surface', () => {
    expect(Object.keys(schema.properties)).not.toContain('enrollmentCode');
    expect(schema.required).not.toContain('enrollmentCode');
    expect(schema.additionalProperties).toBe(false);
    // The comment explaining why is part of the guarantee: it is what stops a future "the
    // handler reads it, so the schema should declare it" edit.
    const source = readFileSync(join(PKG_ROOT, 'src', 'mcp-server', 'tools.js'), 'utf8');
    expect(source).toMatch(/`enrollmentCode` is deliberately absent: it is not a model input\./);
  });

  test('SKILL.md names only tools and CLI commands that exist', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');

    const referencedTools = [...new Set([...skill.matchAll(/collabcast_[a-z_]+/g)].map((m) => m[0]))];
    expect(referencedTools.length).toBeGreaterThan(0);
    expect(referencedTools.filter((name) => !toolNames.includes(name))).toEqual([]);

    const commands = cliCommands();
    const invoked = codeSpans(skill)
      .map((span) => /^collabcast\s+([a-z][a-z-]*)/.exec(span))
      .filter(Boolean)
      .map((m) => m[1]);
    expect(invoked.filter((name) => !commands.has(name))).toEqual([]);
  });

  test('SKILL.md documents the enrollment contract policy actually implements', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');

    // The deleted per-post permit workflow, and the auto-join claim that replaced nothing.
    expect(skill).not.toMatch(/permit\s+<|--once|--duration|--always/);
    expect(skill).not.toMatch(/join automatically|auto-join(?!:)/i);
    // `collabcast_talk` never answers permit_required; only `collabcast_enroll` does.
    expect(skill).not.toMatch(/collabcast_talk` returns `\{ status: "permit_required"/);

    // The real contract, in the terms the code uses.
    expect(skill).toMatch(/unauthenticated/);
    expect(skill).toMatch(/scope_required/);
    // A narrow capability is narrow, not broken.
    expect(skill).toMatch(/narrow capability is narrow, not invalid/);
    // Fail-closed with no UI, and the code/token never reaching the model.
    expect(skill).toMatch(/No operator UI is a denial, never a bypass/);
    expect(skill).toMatch(/never author, see or receive that code/);
    // Reads do not mutate; acknowledgement is explicit.
    expect(skill).toMatch(/collabcast_ack/);
    expect(skill).toMatch(/Neither moves a cursor/);
    // The only enrollable role, and where the others come from.
    expect(skill).toMatch(new RegExp(`\`${ENROLL_ROLE}\``));
    expect(skill).toMatch(/delegated\*\* by an already-enrolled root, never enrolled/);
  });
});
