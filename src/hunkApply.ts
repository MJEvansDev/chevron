import { splitLines, lineToken, tokensToText, type LineHunk } from './lineDiff';

/**
 * Pure logic for `← Take from <branch>`: turning a `LineHunk` (from `lineDiff.ts`) into a single
 * text replacement on the working-tree document, plus the checks that stop a stale hunk from
 * being applied. Deliberately free of any runtime `vscode` import so it's Vitest-testable — this is
 * the one Chevron feature that writes to the user's files, so the edit math lives where it can be
 * exhaustively unit-tested. `takeFromBranch.ts` maps the offsets to a `vscode.Range` via
 * `document.positionAt` and applies it as one `WorkspaceEdit`.
 */

/** A replacement of `[start, end)` (character offsets into the document text) with `replacement`. */
export interface HunkEdit {
  start: number;
  end: number;
  /** The exact raw text currently expected at `[start, end)` — re-checked just before applying. */
  expected: string;
  replacement: string;
}

/** `\r\n` if the text's first line break is CRLF, else `\n` (also the default for a text with no line breaks). */
export function detectEol(text: string): string {
  const match = /\r\n|\n/.exec(text);
  return match?.[0] === '\r\n' ? '\r\n' : '\n';
}

/** Same heuristic git uses to call a file binary: a NUL byte in the first 8000 characters. */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8000).includes('\0');
}

/** What the branch pane (`BranchContentProvider`) shows for a binary file instead of its raw bytes. */
export const BINARY_PANE_PLACEHOLDER = 'Binary file — not shown';

/**
 * `text` without a leading UTF-8 byte-order mark. VS Code strips it from every document's text, so
 * old-side text read straight from git or disk has to lose it too before being diffed against a
 * document — otherwise line 1 always differs.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The branch pane's text for `content` from `git show`: the content itself (BOM-less), or the placeholder if it's binary. */
export function branchPaneText(content: string): string {
  return looksBinary(content) ? BINARY_PANE_PLACEHOLDER : stripBom(content);
}

/**
 * Whether the other pane's text can't be diffed/taken line by line: binary, or the branch pane's
 * binary placeholder (which must never be written into a file as if it were the old content).
 */
export function isUntakeableOldText(text: string): boolean {
  return looksBinary(text) || text === BINARY_PANE_PLACEHOLDER;
}

/**
 * The edit that makes `docText` take `hunk`'s old side in place of its new side, writing line
 * breaks as `eol` (the document's own EOL, so a CRLF file stays CRLF even if the old side came out
 * of git as LF). Returns `undefined` if `docText` doesn't actually contain the hunk's new side at
 * `hunk.newStart` — i.e. the hunk is stale — rather than guessing.
 */
export function computeHunkEdit(docText: string, hunk: LineHunk, eol: string): HunkEdit | undefined {
  const lines = splitLines(docText);
  const endIndex = hunk.newStart + hunk.newLines.length;
  if (hunk.newStart < 0 || endIndex > lines.length) {
    return undefined;
  }
  for (let i = 0; i < hunk.newLines.length; i++) {
    if (lineToken(lines[hunk.newStart + i]) !== hunk.newLines[i]) {
      return undefined;
    }
  }
  // Inserting after an unterminated final line would glue the inserted text onto it. A hunk
  // freshly computed by `diffLines` never has this shape (an unterminated line only ever matches
  // another unterminated, final line), so seeing it means the hunk doesn't belong to this text.
  if (hunk.newLines.length === 0 && hunk.newStart > 0 && lines[hunk.newStart - 1].eol === '') {
    return undefined;
  }

  let start = 0;
  for (let i = 0; i < hunk.newStart; i++) {
    start += lines[i].text.length + lines[i].eol.length;
  }
  let end = start;
  for (let i = hunk.newStart; i < endIndex; i++) {
    end += lines[i].text.length + lines[i].eol.length;
  }

  return {
    start,
    end,
    expected: docText.slice(start, end),
    replacement: tokensToText(hunk.oldLines, eol),
  };
}

/** Splices `edit` into `text` — what applying the `WorkspaceEdit` does, for tests. */
export function applyHunkEdit(text: string, edit: HunkEdit): string {
  return text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** Whether two hunks are the same change at the same place — both sides' positions and contents. */
export function hunksEqual(a: LineHunk, b: LineHunk): boolean {
  return (
    a.oldStart === b.oldStart &&
    a.newStart === b.newStart &&
    sameLines(a.oldLines, b.oldLines) &&
    sameLines(a.newLines, b.newLines)
  );
}

/**
 * The hunk in a freshly recomputed `hunks` list that is identical to `expected` (the one a
 * CodeLens was rendered for), or `undefined` if the file moved on since. Matching on position
 * *and* content on both sides means an edit elsewhere below the hunk (which doesn't shift it) is
 * fine, while any edit above it, inside it, or to the old side makes the apply bail.
 */
export function findMatchingHunk(hunks: LineHunk[], expected: LineHunk): LineHunk | undefined {
  return hunks.find((hunk) => hunksEqual(hunk, expected));
}

/**
 * The 0-based editor line a hunk is anchored to — where its CodeLens renders and where change
 * navigation puts the cursor. The first new-side line for an addition/modification; for a pure
 * deletion, the line the removed lines sat just above (CodeLenses render *above* their line, so
 * that lands right at the gap). Clamped to the document's last line (`lineCount` is VS Code's
 * `TextDocument.lineCount`, which counts an empty line after a trailing newline).
 */
export function hunkAnchorLine(hunk: LineHunk, lineCount: number): number {
  return Math.max(0, Math.min(hunk.newStart, lineCount - 1));
}

/** Inclusive 0-based editor line span a hunk covers on the new side (a single anchor line for a pure deletion). */
export function hunkLineSpan(hunk: LineHunk, lineCount: number): { start: number; end: number } {
  const start = hunkAnchorLine(hunk, lineCount);
  const end = Math.max(start, Math.min(hunk.newStart + hunk.newLines.length - 1, lineCount - 1));
  return { start, end };
}

/** The hunk whose span contains `line` (0-based), if any. */
export function hunkAtLine(hunks: LineHunk[], line: number, lineCount: number): LineHunk | undefined {
  return hunks.find((hunk) => {
    const span = hunkLineSpan(hunk, lineCount);
    return line >= span.start && line <= span.end;
  });
}
