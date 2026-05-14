import { describe, test, expect } from 'vitest';
import { parseMentions, resolveMentions } from '../../src/core/mentions.js';

describe('mentions', () => {
  test('parseMentions() extracts simple @aliases', () => {
    expect(parseMentions('hi @demo-builder and @slide-designer')).toEqual([
      'demo-builder',
      'slide-designer'
    ]);
  });

  test('parseMentions() returns empty when no mentions', () => {
    expect(parseMentions('plain prose, nothing here')).toEqual([]);
  });

  test('parseMentions() ignores email-like @ inside words', () => {
    expect(parseMentions('contact trevor@cloutdesk.com today')).toEqual([]);
  });

  test('parseMentions() captures special tokens', () => {
    expect(parseMentions('@all please respond')).toEqual(['all']);
    expect(parseMentions('ping @operator')).toEqual(['operator']);
    expect(parseMentions('@claude-code, @claude-cowork')).toEqual([
      'claude-code',
      'claude-cowork'
    ]);
  });

  test('parseMentions() deduplicates', () => {
    expect(parseMentions('@x said @x is here')).toEqual(['x']);
  });

  test('resolveMentions() splits resolved vs unresolved', () => {
    const active = [
      { alias: 'demo-builder', tool: 'claude-code' },
      { alias: 'slide-designer', tool: 'claude-cowork' }
    ];
    const out = resolveMentions(['demo-builder', 'unknown-helper', 'claude-code'], active);
    expect(out.resolved).toEqual(['demo-builder', '@tool:claude-code']);
    expect(out.unresolved).toEqual(['unknown-helper']);
  });

  test('resolveMentions() treats @all and @operator as always resolved', () => {
    const out = resolveMentions(['all', 'operator'], []);
    expect(out.resolved).toEqual(['@all', '@operator']);
    expect(out.unresolved).toEqual([]);
  });
});
