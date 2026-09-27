/**
 * Performance guards and the small pure helpers that apply them. No `vscode`
 * import, so Vitest-testable.
 */

/** Files with more lines than this get no blame (hover or margin annotations) — `git blame` is slow and its output huge. */
export const MAX_BLAME_LINES = 20_000;
/** Same guard by size, for files with few but very long lines (minified bundles, data files). */
export const MAX_BLAME_CHARS = 2 * 1024 * 1024;

/** The changed-files tree renders at most this many files; the rest are summarized in the view message. */
export const MAX_TREE_FILES = 5000;

export function isTooLargeForBlame(lineCount: number, charCount: number): boolean {
  return lineCount > MAX_BLAME_LINES || charCount > MAX_BLAME_CHARS;
}

export interface CappedList<T> {
  shown: T[];
  total: number;
  truncated: boolean;
}

export function capList<T>(items: T[], max: number): CappedList<T> {
  return items.length > max
    ? { shown: items.slice(0, max), total: items.length, truncated: true }
    : { shown: items, total: items.length, truncated: false };
}

/** The tree view message shown when the changed-files list was capped. */
export function truncationMessage(shown: number, total: number): string {
  return `Showing the first ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} changed files.`;
}

/**
 * Suppresses repeats of the same notification within a time window — e.g. a bad ref makes every
 * one of 50 diff panes fail with the same error, which should be one toast, not 50.
 */
export class MessageDeduper {
  private readonly lastShown = new Map<string, number>();

  constructor(private readonly windowMs = 30_000) {}

  /** `true` if `key` hasn't been shown within the window (and records it as shown now). */
  shouldShow(key: string, now = Date.now()): boolean {
    const last = this.lastShown.get(key);
    if (last !== undefined && now - last < this.windowMs) {
      return false;
    }
    this.lastShown.set(key, now);
    return true;
  }

  reset(): void {
    this.lastShown.clear();
  }
}
