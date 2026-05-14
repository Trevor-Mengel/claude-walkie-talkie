import { describe, test, expect } from 'vitest';
import { formatMessage, parseMessage } from '../../src/core/format.js';

const SAMPLE = {
  id: '01J7QXP9R5K8VYZAB3',
  type: 'question',
  fromSessionId: 'cs_abc123',
  fromAlias: 'demo-builder',
  fromTool: 'claude-code',
  mentions: ['slide-designer'],
  replyTo: null,
  autonomous: false,
  revision: null,
  editedAt: null,
  archived: false,
  archivedBy: null,
  archivedReason: null,
  mentionsPending: [],
  timestamp: '2026-05-14T15:32:00.000Z',
  git: { branch: 'main', hash: 'a3f2c1d', userEmail: 'trevor@abstractlabs', userName: 'Trevor' },
  body: 'Hey — Stripe Connect is wired up. Should the slide mention refunds?'
};

describe('format', () => {
  test('formatMessage emits signature, marker, time, git, body, separator', () => {
    const block = formatMessage(SAMPLE);
    expect(block).toMatch(/^## 📡 demo-builder → @slide-designer\n/);
    expect(block).toContain(
      '<!-- walkie:msg id=01J7QXP9R5K8VYZAB3 type=question from=cs_abc123 mentions=slide-designer -->'
    );
    expect(block).toContain('**Time:** 2026-05-14T15:32:00.000Z');
    expect(block).toContain('**Git:** main @ a3f2c1d (trevor@abstractlabs)');
    expect(block).toContain('Stripe Connect is wired up');
    expect(block.trimEnd().endsWith('---')).toBe(true);
  });

  test('round-trip: parseMessage(formatMessage(x)) preserves fields', () => {
    const block = formatMessage(SAMPLE);
    const parsed = parseMessage(block);
    expect(parsed.id).toBe(SAMPLE.id);
    expect(parsed.type).toBe(SAMPLE.type);
    expect(parsed.fromSessionId).toBe(SAMPLE.fromSessionId);
    expect(parsed.fromAlias).toBe(SAMPLE.fromAlias);
    expect(parsed.mentions).toEqual(SAMPLE.mentions);
    expect(parsed.body.trim()).toBe(SAMPLE.body);
  });

  test('formatMessage uses fallback emoji for unknown tool', () => {
    const block = formatMessage({
      ...SAMPLE,
      fromTool: 'codex',
      fromAlias: 'codex-helper',
      mentions: []
    });
    expect(block).toMatch(/^## ⚡ codex-helper → all\n/);
  });

  test('formatMessage shows operator emoji for from=operator', () => {
    const block = formatMessage({
      ...SAMPLE,
      fromSessionId: 'operator',
      fromTool: 'operator',
      fromAlias: 'Trevor',
      mentions: ['demo-builder']
    });
    expect(block).toMatch(/^## 👤 Trevor → @demo-builder\n/);
  });

  test('formatMessage tags autonomous writes', () => {
    const block = formatMessage({ ...SAMPLE, autonomous: true });
    expect(block).toContain('🤖');
    expect(block).toContain('[autonomous]');
  });

  test('formatMessage renders archived banner and collapses body', () => {
    const block = formatMessage({
      ...SAMPLE,
      archived: true,
      archivedBy: 'cs_abc123',
      archivedReason: 'duplicate'
    });
    expect(block).toContain('🗄️ ARCHIVED');
    expect(block).toContain('archived=true');
    expect(block).toContain('archived-reason="duplicate"');
  });

  test('parseMessage returns null for non-message text', () => {
    expect(parseMessage('# Some random heading\n\nNo marker.')).toBeNull();
  });
});
