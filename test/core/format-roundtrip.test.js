import { describe, test, expect } from 'vitest';
import { formatMessage, parseMessage } from '../../src/core/format.js';

describe('format/parse round-trip', () => {
  test('preserves fromTool through format → parse', () => {
    const original = {
      id: '01J7QXP9R5K8VYZAB3',
      type: 'broadcast',
      fromSessionId: 'cs_abc123',
      fromAlias: 'demo-builder',
      fromTool: 'claude-code',
      mentions: [],
      timestamp: '2026-05-15T10:00:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'hello'
    };
    const block = formatMessage(original);
    const parsed = parseMessage(block.replace(/^\n/, ''));
    expect(parsed.fromTool).toBe('claude-code');
  });

  test('preserves timestamp through format → parse', () => {
    const original = {
      id: '01J7QXP9R5K8VYZAB4',
      type: 'broadcast',
      fromSessionId: 'cs_abc123',
      fromAlias: 'demo-builder',
      fromTool: 'claude-code',
      mentions: [],
      timestamp: '2026-05-15T10:00:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'hello'
    };
    const block = formatMessage(original);
    const parsed = parseMessage(block.replace(/^\n/, ''));
    expect(parsed.timestamp).toBe('2026-05-15T10:00:00.000Z');
  });

  test('operator tool also round-trips (regression for default rebuild)', () => {
    const original = {
      id: '01J7QXP9R5K8VYZAB5',
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'operator',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-15T10:00:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'hi'
    };
    const parsed = parseMessage(formatMessage(original).replace(/^\n/, ''));
    expect(parsed.fromTool).toBe('operator');
    expect(parsed.timestamp).toBe('2026-05-15T10:00:00.000Z');
  });
});
