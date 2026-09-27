/**
 * A small, synchronous, pure-TypeScript line diff (Myers' O(ND) algorithm) — the hunk engine
 * behind `← Take from <branch>` (`takeFromBranch.ts`) and change navigation
 * (`changeNavigationCommands.ts`).
 *
 * Why not `git diff --unified=0` (`gitService.getChangedLineRanges`)? That diffs the file *on
 * disk*, but "take" edits the live buffer, which may have unsaved changes — hunks computed from
 * disk would point at the wrong lines the moment the buffer is dirty. Diffing the old side's text
 * against `document.getText()` in-process always reflects exactly what's in the editor, needs no
 * temp files or subprocess per keystroke, and keeps the whole thing Vitest-testable.
 *
 * Lines are compared as *tokens*: a line's content plus a normalized `\n` if (and only if) it has a
 * terminator. That makes two things fall out for free:
 * - CRLF vs LF: `a\r\n` and `a\n` compare equal, so an old side checked out with different line
 *   endings than the editor buffer doesn't turn every line into a change.
 * - "\ No newline at end of file": a final line without a terminator (`a`) differs from one with
 *   (`a\n`), exactly like git reports it, so taking that hunk restores (or removes) the final EOL.
 */

/** One line of a text, split off its terminator. `eol` is `''` only for a final, unterminated line. */
export interface SplitLine {
  text: string;
  eol: string;
}

/**
 * A single changed region between an old and a new text. Indices are **0-based line indices**
 * into `splitLines(old)` / `splitLines(new)`. Lines are tokens (content plus a normalized `\n`
 * when the line is terminated — see the module doc comment), never raw text.
 *
 * - Pure addition: `oldLines` is empty; `oldStart` is where the new lines would sit in the old text.
 * - Pure deletion: `newLines` is empty; `newStart` is the index of the new-side line the old lines
 *   were removed *before* (equal to the new text's line count for a deletion at the very end).
 */
export interface LineHunk {
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
}

/** Splits text into lines on `\r\n`, `\n` or a lone `\r`, keeping each line's own terminator. `''` → `[]`. */
export function splitLines(text: string): SplitLine[] {
  const lines: SplitLine[] = [];
  const re = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    lines.push({ text: text.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), eol: '' });
  }
  return lines;
}

/** The comparison token for a line — see `LineHunk`. */
export function lineToken(line: SplitLine): string {
  return line.eol ? `${line.text}\n` : line.text;
}

/** Tokens for every line of `text`. */
export function tokenizeLines(text: string): string[] {
  return splitLines(text).map(lineToken);
}

/**
 * Beyond this many edits (D in Myers' O(ND)), stop searching for a minimal diff and report the
 * whole differing middle section as one hunk. Myers' trace needs O(D²) memory to backtrack, so a
 * file that's been completely rewritten would otherwise cost hundreds of MB. One coarse hunk is
 * still a *correct* diff (applying it restores the old text exactly), just not a minimal one.
 */
const MAX_EDIT_DISTANCE = 2000;

/** Line hunks turning `oldText` into `newText`, in order. Empty when the texts are line-for-line equal (EOL style aside). */
export function diffLines(oldText: string, newText: string): LineHunk[] {
  return diffTokens(tokenizeLines(oldText), tokenizeLines(newText));
}

/** Same as `diffLines`, on already-tokenized lines. */
export function diffTokens(oldTokens: string[], newTokens: string[]): LineHunk[] {
  // Intern tokens as small integers: the inner snake loop then compares numbers, not strings.
  const ids = new Map<string, number>();
  const intern = (token: string): number => {
    let id = ids.get(token);
    if (id === undefined) {
      id = ids.size;
      ids.set(token, id);
    }
    return id;
  };
  const a = oldTokens.map(intern);
  const b = newTokens.map(intern);

  // Trim the common prefix/suffix first — in the common case (a handful of edits in a big file)
  // this shrinks Myers' input to almost nothing.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const matches = myersMatches(midA, midB) ?? [];

  const hunks: LineHunk[] = [];
  let i = 0;
  let j = 0;
  const flush = (untilI: number, untilJ: number) => {
    if (untilI > i || untilJ > j) {
      hunks.push({
        oldStart: prefix + i,
        oldLines: oldTokens.slice(prefix + i, prefix + untilI),
        newStart: prefix + j,
        newLines: newTokens.slice(prefix + j, prefix + untilJ),
      });
    }
  };
  for (const [mi, mj] of matches) {
    flush(mi, mj);
    i = mi + 1;
    j = mj + 1;
  }
  flush(midA.length, midB.length);
  return hunks;
}

/**
 * Myers' greedy forward search plus backtrack, returning matched `[indexInA, indexInB]` pairs in
 * increasing order — or `undefined` when the edit distance exceeds `MAX_EDIT_DISTANCE` (callers
 * then treat the whole input as one differing block).
 */
function myersMatches(a: number[], b: number[]): Array<[number, number]> | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return [];
  }
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = V after step d, windowed to k ∈ [-d, d] (index k + d).
  const trace: Int32Array[] = [];
  let finalD = -1;

  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) {
      return undefined;
    }
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]; // step down (insertion from b)
      } else {
        x = v[offset + k - 1] + 1; // step right (deletion from a)
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        finalD = d;
        break outer;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }

  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = finalD; d > 0; d--) {
    const prev = trace[d - 1];
    const prevAt = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && prevAt(k - 1) < prevAt(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prevAt(prevK);
    const prevY = prevX - prevK;
    const snakeStartX = down ? prevX : prevX + 1;
    while (x > snakeStartX) {
      x--;
      y--;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    matches.push([x, y]);
  }
  return matches.reverse();
}

/** Reassembles hunk tokens into text using `eol` for every terminated line. */
export function tokensToText(tokens: string[], eol: string): string {
  return tokens.map((token) => (token.endsWith('\n') ? token.slice(0, -1) + eol : token)).join('');
}

/** Applies hunks produced by `diffLines(oldText, newText)` in reverse, i.e. rebuilds `oldText`'s lines from `newText`. Test helper, and a sanity check for the diff itself. */
export function applyHunksReversed(newTokens: string[], hunks: LineHunk[]): string[] {
  const result = newTokens.slice();
  for (let h = hunks.length - 1; h >= 0; h--) {
    const hunk = hunks[h];
    result.splice(hunk.newStart, hunk.newLines.length, ...hunk.oldLines);
  }
  return result;
}
