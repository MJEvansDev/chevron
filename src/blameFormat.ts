import type { BlameLine } from './types';

/** `git blame`'s sentinel hash for an uncommitted line ("Not Committed Yet"). */
export const UNCOMMITTED_HASH = '0'.repeat(40);

const RELATIVE_UNITS: ReadonlyArray<readonly [string, number]> = [
  ['y', 60 * 60 * 24 * 365],
  ['mo', 60 * 60 * 24 * 30],
  ['d', 60 * 60 * 24],
  ['h', 60 * 60],
  ['m', 60],
];

/**
 * Compact "2mo ago"-style relative time, for the margin annotation where space is tight. The
 * hover keeps a full absolute date/time instead — this is deliberately the lossy, short form.
 */
export function formatRelativeTime(unixSeconds: number, now: number = Date.now()): string {
  const diffSeconds = Math.max(0, now / 1000 - unixSeconds);
  for (const [label, secondsPerUnit] of RELATIVE_UNITS) {
    const value = Math.floor(diffSeconds / secondsPerUnit);
    if (value >= 1) {
      return `${value}${label} ago`;
    }
  }
  return 'just now';
}

/**
 * Terse single-line text for the margin annotation: author + relative time only. Deliberately
 * excludes the committer and hash that the hover shows — the margin annotation renders on every
 * blamed line of every visible editor at once, so it has to stay short regardless of how long a
 * name happens to be (a long author name is still truncated); the full detail is a hover away.
 */
export function formatBlameAnnotationText(
  blameLine: BlameLine,
  now?: number,
  dateFormat: BlameDateFormat = 'relative',
): string {
  if (blameLine.hash === UNCOMMITTED_HASH) {
    return 'Not committed yet';
  }
  const when = dateFormat === 'absolute' ? formatAbsoluteDate(blameLine.authorTime) : formatRelativeTime(blameLine.authorTime, now);
  return `${truncate(blameLine.author, 24)}, ${when}`;
}

/** `chevron.blame.dateFormat`. */
export type BlameDateFormat = 'relative' | 'absolute';

/** `2026-09-27` in local time — compact, sortable and locale-neutral, for the margin annotation. */
export function formatAbsoluteDate(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
