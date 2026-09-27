import { describe, it, expect } from 'vitest';
import { formatAbsoluteDate, formatRelativeTime, formatBlameAnnotationText, UNCOMMITTED_HASH } from '../../src/blameFormat';

const NOW = new Date('2026-09-13T12:00:00Z').getTime();

describe('formatRelativeTime', () => {
  it('rounds down to the largest whole unit', () => {
    expect(formatRelativeTime(NOW / 1000 - 30, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW / 1000 - 90, NOW)).toBe('1m ago');
    expect(formatRelativeTime(NOW / 1000 - 60 * 60 * 5, NOW)).toBe('5h ago');
    expect(formatRelativeTime(NOW / 1000 - 60 * 60 * 24 * 3, NOW)).toBe('3d ago');
    expect(formatRelativeTime(NOW / 1000 - 60 * 60 * 24 * 45, NOW)).toBe('1mo ago');
    expect(formatRelativeTime(NOW / 1000 - 60 * 60 * 24 * 400, NOW)).toBe('1y ago');
  });

  it('clamps a future timestamp to "just now" rather than going negative', () => {
    expect(formatRelativeTime(NOW / 1000 + 1000, NOW)).toBe('just now');
  });
});

describe('formatBlameAnnotationText', () => {
  it('formats a committed line as "author, relative-time"', () => {
    const blameLine = {
      line: 1,
      hash: 'a'.repeat(40),
      author: 'Jane Doe',
      committer: 'Jane Doe',
      authorTime: NOW / 1000 - 60 * 60 * 24 * 2,
      summary: 'Fix bug',
    };
    expect(formatBlameAnnotationText(blameLine, NOW)).toBe('Jane Doe, 2d ago');
  });

  it('omits the committer even when it differs from the author — that detail stays in the hover', () => {
    const blameLine = {
      line: 1,
      hash: 'a'.repeat(40),
      author: 'Alex Morgan',
      committer: 'GitHub',
      authorTime: NOW / 1000 - 60 * 60 * 24 * 30,
      summary: 'Merge PR',
    };
    expect(formatBlameAnnotationText(blameLine, NOW)).toBe('Alex Morgan, 1mo ago');
  });

  it('truncates a long author name so one line never dominates the annotation width', () => {
    const blameLine = {
      line: 1,
      hash: 'a'.repeat(40),
      author: 'A Very Long Display Name That Goes On And On',
      committer: 'A Very Long Display Name That Goes On And On',
      authorTime: NOW / 1000,
      summary: '',
    };
    const text = formatBlameAnnotationText(blameLine, NOW);
    expect(text.startsWith('A Very Long Display Nam')).toBe(true);
    expect(text).toContain('…, just now');
  });

  it('reports uncommitted lines as "Not committed yet" regardless of author/time', () => {
    const blameLine = {
      line: 1,
      hash: UNCOMMITTED_HASH,
      author: 'Not Committed Yet',
      committer: 'Not Committed Yet',
      authorTime: NOW / 1000,
      summary: '',
    };
    expect(formatBlameAnnotationText(blameLine, NOW)).toBe('Not committed yet');
  });
});

describe('dateFormat: absolute', () => {
  // Local noon, so the expected calendar date is the same in every time zone.
  const localNoon = new Date(2026, 5, 14, 12, 0, 0).getTime() / 1000;
  const blameLine = {
    line: 1,
    hash: 'a'.repeat(40),
    author: 'Jane Doe',
    committer: 'Jane Doe',
    authorTime: localNoon,
    summary: 'Fix bug',
  };

  it('formats the author date as YYYY-MM-DD', () => {
    expect(formatAbsoluteDate(localNoon)).toBe('2026-06-14');
    expect(formatAbsoluteDate(new Date(2026, 0, 5, 12).getTime() / 1000)).toBe('2026-01-05');
  });

  it('uses the absolute date in the annotation when asked, relative by default', () => {
    expect(formatBlameAnnotationText(blameLine, NOW, 'absolute')).toBe('Jane Doe, 2026-06-14');
    expect(formatBlameAnnotationText(blameLine, NOW)).toMatch(/^Jane Doe, \d+(mo|d) ago$/);
  });

  it('still says "Not committed yet" for an uncommitted line', () => {
    expect(formatBlameAnnotationText({ ...blameLine, hash: UNCOMMITTED_HASH }, NOW, 'absolute')).toBe('Not committed yet');
  });
});
