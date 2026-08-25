import { describe, test, expect } from 'vitest';
import {
  APPROVE_OPTION,
  DEFAULT_ALLOWED_SERVERS,
  DENY_OPTION,
  ENROLL_TOOL,
  SELECT_OPTIONS,
  classifyToolName,
  decide,
  expectedToolNames,
  gateStage,
  normalizeSelection
} from '../../omp-extension/gate.js';

describe('gate: tool-name classification', () => {
  test('the MCP-namespaced name from an allowlisted server is the enrollment tool', () => {
    expect(classifyToolName('mcp__collabcast_collabcast_enroll')).toBe('enroll');
  });

  test('the bare name is the enrollment tool (non-MCP invocation)', () => {
    expect(classifyToolName(ENROLL_TOOL)).toBe('enroll');
  });

  test('an enrollment-shaped name from a non-allowlisted server is foreign, not passed', () => {
    expect(classifyToolName('mcp__evil_collabcast_enroll')).toBe('foreign');
    expect(classifyToolName('mcp__collabcast-evil_collabcast_enroll')).toBe('foreign');
    expect(classifyToolName('spoofed-collabcast_enroll')).toBe('foreign');
  });

  test('a name that merely contains collabcast_enroll mid-string is a different tool', () => {
    expect(classifyToolName('collabcast_enroll_status')).toBe('unrelated');
    expect(classifyToolName('mcp__collabcast_collabcast_enroll_status')).toBe('unrelated');
  });

  test('unrelated tools are unrelated', () => {
    for (const name of ['read', 'bash', 'collabcast_talk', 'mcp__collabcast_collabcast_talk']) {
      expect(classifyToolName(name)).toBe('unrelated');
    }
  });

  test('non-string and empty tool names are unrelated, never a crash', () => {
    for (const name of [undefined, null, '', 42, {}, []]) {
      expect(classifyToolName(name)).toBe('unrelated');
    }
  });

  test('the allowlist is honoured and generated exactly, not parsed', () => {
    expect(classifyToolName('mcp__evil_collabcast_enroll', ['evil'])).toBe('enroll');
    expect(classifyToolName('mcp__collabcast_collabcast_enroll', ['evil'])).toBe('foreign');
    // A server name containing '_' is unambiguous under generation.
    expect(classifyToolName('mcp__evil_collabcast_collabcast_enroll', ['evil_collabcast'])).toBe('enroll');
    expect(classifyToolName('mcp__evil_collabcast_enroll', ['evil_collabcast'])).toBe('foreign');
  });

  test('expectedToolNames covers the bare name plus one per allowlisted server', () => {
    expect(expectedToolNames(['a', 'b'])).toEqual(
      new Set([ENROLL_TOOL, 'mcp__a_collabcast_enroll', 'mcp__b_collabcast_enroll'])
    );
    expect(expectedToolNames()).toEqual(
      new Set([ENROLL_TOOL, 'mcp__collabcast_collabcast_enroll'])
    );
    // Junk entries are dropped rather than widening the match surface.
    expect(expectedToolNames(['', '  ', null, 7])).toEqual(new Set([ENROLL_TOOL]));
    expect(expectedToolNames('not-an-array')).toEqual(new Set([ENROLL_TOOL]));
  });

  test('Deny is first so it is the pre-selected default', () => {
    expect(SELECT_OPTIONS).toEqual([DENY_OPTION, APPROVE_OPTION]);
    expect(SELECT_OPTIONS[0]).toBe('Deny');
    expect(DEFAULT_ALLOWED_SERVERS).toEqual(['collabcast']);
  });
});

describe('gate: selection normalisation', () => {
  test('strings pass through; rich selector objects are unwrapped', () => {
    expect(normalizeSelection('Approve')).toBe('Approve');
    expect(normalizeSelection({ value: 'Approve' })).toBe('Approve');
    expect(normalizeSelection({ label: 'Deny' })).toBe('Deny');
  });

  test('anything unrecognisable normalises to undefined (a denial)', () => {
    for (const value of [undefined, null, 0, false, [], {}, () => 'Approve']) {
      expect(normalizeSelection(value)).toBeUndefined();
    }
  });
});

describe('gate: gateStage', () => {
  test('prompt only for a genuine enrollment call in a session with a UI', () => {
    expect(gateStage({ toolName: ENROLL_TOOL, hasUI: true })).toEqual({ action: 'prompt' });
  });

  test('no UI blocks before any prompt is possible', () => {
    const verdict = gateStage({ toolName: ENROLL_TOOL, hasUI: false });
    expect(verdict.action).toBe('block');
    expect(verdict.code).toBe('forbidden');
    expect(verdict.reason).toMatch(/delegated capability/);
  });

  test('foreign server blocks even with a UI', () => {
    const verdict = gateStage({ toolName: 'mcp__evil_collabcast_enroll', hasUI: true });
    expect(verdict.action).toBe('block');
    expect(verdict.reason).toMatch(/unrecognised MCP server/);
  });

  test('unrelated tools pass regardless of UI', () => {
    expect(gateStage({ toolName: 'read', hasUI: true })).toEqual({ action: 'pass' });
    expect(gateStage({ toolName: 'read', hasUI: false })).toEqual({ action: 'pass' });
  });
});

/**
 * Exhaustive truth table. The expectation is spelled out independently of the
 * implementation so the two have to agree by meaning, not by shared code.
 *
 * @param {{ toolName: unknown, hasUI: unknown, selection: unknown }} input
 */
function expectedAction({ toolName, hasUI, selection }) {
  const allowed = ['collabcast_enroll', 'mcp__collabcast_collabcast_enroll'];
  const shaped = typeof toolName === 'string' && toolName.endsWith('collabcast_enroll');
  if (!shaped) return 'pass';
  if (!allowed.includes(toolName)) return 'block';
  if (!hasUI) return 'block';
  let picked;
  if (typeof selection === 'string') picked = selection;
  else if (selection && typeof selection === 'object') {
    if (typeof selection.value === 'string') picked = selection.value;
    else if (typeof selection.label === 'string') picked = selection.label;
  }
  return picked === 'Approve' ? 'inject' : 'block';
}

describe('gate: decide truth table', () => {
  const toolNames = [
    'mcp__collabcast_collabcast_enroll',
    'collabcast_enroll',
    'mcp__evil_collabcast_enroll',
    'spoofed-collabcast_enroll',
    'collabcast_enroll_status',
    'read',
    '',
    undefined
  ];
  const uiStates = [true, false, undefined];
  const selections = [
    'Approve',
    'Deny',
    undefined,
    null,
    '',
    'approve',
    'Approve ',
    { value: 'Approve' },
    { value: 'Deny' },
    { label: 'Approve' },
    0,
    true
  ];

  test(`covers every combination (${toolNames.length}x${uiStates.length}x${selections.length})`, () => {
    let checked = 0;
    for (const toolName of toolNames) {
      for (const hasUI of uiStates) {
        for (const selection of selections) {
          const verdict = decide({ toolName, hasUI, selection });
          const label = `${String(toolName)} | hasUI=${String(hasUI)} | sel=${JSON.stringify(selection)}`;
          expect(verdict.action, label).toBe(expectedAction({ toolName, hasUI, selection }));
          if (verdict.action === 'block') {
            expect(typeof verdict.reason, label).toBe('string');
            expect(verdict.reason.length, label).toBeGreaterThan(0);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBe(toolNames.length * uiStates.length * selections.length);
  });

  test('only an exact Approve injects', () => {
    const base = { toolName: ENROLL_TOOL, hasUI: true };
    expect(decide({ ...base, selection: 'Approve' })).toEqual({ action: 'inject' });
    for (const selection of ['Deny', undefined, 'approve', 'APPROVE', 'Approve\n', 'yes']) {
      expect(decide({ ...base, selection }).action).toBe('block');
    }
  });

  test('blocked verdicts never leak a secret-looking payload into the reason', () => {
    const verdict = decide({ toolName: 'mcp__evil_collabcast_enroll', hasUI: true, selection: 'x' });
    expect(verdict.reason).not.toMatch(/secret|token|sock/i);
  });
});
