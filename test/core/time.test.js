import { describe, test, expect } from 'vitest';
import { now, relative } from '../../src/core/time.js';

describe('time', () => {
  test('now() returns ISO 8601 UTC string', () => {
    expect(now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test('relative() returns "just now" for current timestamp', () => {
    expect(relative(now())).toBe('just now');
  });

  test('relative() returns seconds for < 1 minute', () => {
    const past = new Date(Date.now() - 45 * 1000).toISOString();
    expect(relative(past)).toBe('45 seconds ago');
  });

  test('relative() returns minutes for < 1 hour', () => {
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(relative(past)).toBe('5 minutes ago');
  });

  test('relative() returns hours for < 1 day', () => {
    const past = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    expect(relative(past)).toBe('3 hours ago');
  });

  test('relative() returns days for >= 1 day', () => {
    const past = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    expect(relative(past)).toBe('2 days ago');
  });

  test('relative() handles future timestamps', () => {
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    expect(relative(future)).toBe('in the future');
  });

  test('relative() handles singular minute', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(relative(past)).toBe('1 minute ago');
  });
});
