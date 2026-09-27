import { describe, it, expect } from 'vitest';
import {
  capList,
  isTooLargeForBlame,
  MAX_BLAME_CHARS,
  MAX_BLAME_LINES,
  MessageDeduper,
  truncationMessage,
} from '../../src/limits';

describe('isTooLargeForBlame', () => {
  it('allows ordinary files', () => {
    expect(isTooLargeForBlame(500, 20_000)).toBe(false);
    expect(isTooLargeForBlame(MAX_BLAME_LINES, MAX_BLAME_CHARS)).toBe(false);
  });

  it('rejects files over the line threshold', () => {
    expect(isTooLargeForBlame(MAX_BLAME_LINES + 1, 10)).toBe(true);
  });

  it('rejects files over the size threshold even with few lines', () => {
    expect(isTooLargeForBlame(1, MAX_BLAME_CHARS + 1)).toBe(true);
  });
});

describe('capList', () => {
  it('returns everything when under the cap', () => {
    expect(capList([1, 2, 3], 5)).toEqual({ shown: [1, 2, 3], total: 3, truncated: false });
  });

  it('returns everything when exactly at the cap', () => {
    expect(capList([1, 2, 3], 3)).toEqual({ shown: [1, 2, 3], total: 3, truncated: false });
  });

  it('truncates over the cap and reports the total', () => {
    expect(capList([1, 2, 3, 4], 2)).toEqual({ shown: [1, 2], total: 4, truncated: true });
  });
});

describe('truncationMessage', () => {
  it('formats both counts with thousands separators', () => {
    expect(truncationMessage(5000, 12345)).toBe('Showing the first 5,000 of 12,345 changed files.');
  });
});

describe('MessageDeduper', () => {
  it('shows a message once per window', () => {
    const deduper = new MessageDeduper(1000);
    expect(deduper.shouldShow('boom', 0)).toBe(true);
    expect(deduper.shouldShow('boom', 500)).toBe(false);
    expect(deduper.shouldShow('boom', 999)).toBe(false);
    expect(deduper.shouldShow('boom', 1500)).toBe(true);
  });

  it('tracks different messages independently', () => {
    const deduper = new MessageDeduper(1000);
    expect(deduper.shouldShow('a', 0)).toBe(true);
    expect(deduper.shouldShow('b', 0)).toBe(true);
  });

  it('can be reset', () => {
    const deduper = new MessageDeduper(1000);
    deduper.shouldShow('a', 0);
    deduper.reset();
    expect(deduper.shouldShow('a', 1)).toBe(true);
  });
});
