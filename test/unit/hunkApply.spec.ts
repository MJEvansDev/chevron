import { describe, it, expect } from 'vitest';
import { diffLines } from '../../src/lineDiff';
import {
  applyHunkEdit,
  BINARY_PANE_PLACEHOLDER,
  branchPaneText,
  computeHunkEdit,
  isUntakeableOldText,
  detectEol,
  findMatchingHunk,
  hunkAnchorLine,
  hunkAtLine,
  hunkLineSpan,
  looksBinary,
  stripBom,
} from '../../src/hunkApply';

describe('stripBom', () => {
  it('drops a leading UTF-8 BOM, so old-side text diffs like the (BOM-less) document text', () => {
    expect(stripBom('﻿line 1\nline 2\n')).toBe('line 1\nline 2\n');
    expect(diffLines(stripBom('﻿same\n'), 'same\n')).toEqual([]);
    expect(branchPaneText('﻿same\n')).toBe('same\n');
  });

  it('leaves text without a leading BOM alone', () => {
    expect(stripBom('')).toBe('');
    expect(stripBom('plain\n')).toBe('plain\n');
    expect(stripBom('mid﻿dle')).toBe('mid﻿dle');
  });
});

/** Takes hunk `index` of diff(old → doc) back into `doc`, the way the `← Take from` lens does. */
function take(oldText: string, docText: string, index: number, eol = detectEol(docText)): string {
  const hunks = diffLines(oldText, docText);
  const edit = computeHunkEdit(docText, hunks[index], eol);
  if (!edit) {
    throw new Error('expected an applicable edit');
  }
  expect(edit.expected).toBe(docText.slice(edit.start, edit.end));
  return applyHunkEdit(docText, edit);
}

/** Takes every hunk, one at a time, recomputing the diff after each (as a user clicking lens after lens would). */
function takeAllOneByOne(oldText: string, docText: string): string {
  let text = docText;
  for (let guard = 0; guard < 100; guard++) {
    const hunks = diffLines(oldText, text);
    if (hunks.length === 0) {
      return text;
    }
    const edit = computeHunkEdit(text, hunks[0], detectEol(text));
    if (!edit) {
      throw new Error('fresh hunk was not applicable');
    }
    text = applyHunkEdit(text, edit);
  }
  throw new Error('did not converge');
}

describe('computeHunkEdit / applyHunkEdit', () => {
  it('reverts a modification', () => {
    expect(take('a\nb\nc\n', 'a\nB\nc\n', 0)).toBe('a\nb\nc\n');
  });

  it('reverts a multi-line modification into a different number of lines', () => {
    expect(take('a\nb\nc\nd\n', 'a\nX\nd\n', 0)).toBe('a\nb\nc\nd\n');
  });

  it('removes a pure addition', () => {
    expect(take('a\nc\n', 'a\nb\nc\n', 0)).toBe('a\nc\n');
  });

  it('restores a pure deletion in the middle', () => {
    expect(take('a\nb\nc\n', 'a\nc\n', 0)).toBe('a\nb\nc\n');
  });

  it('restores a deletion at the start of the file', () => {
    expect(take('first\na\n', 'a\n', 0)).toBe('first\na\n');
  });

  it('restores a deletion at the end of the file', () => {
    expect(take('a\nlast\n', 'a\n', 0)).toBe('a\nlast\n');
  });

  it('removes an addition on the first line', () => {
    expect(take('a\n', 'new\na\n', 0)).toBe('a\n');
  });

  it('removes an addition on the last line', () => {
    expect(take('a\n', 'a\nnew\n', 0)).toBe('a\n');
  });

  it('only touches the chosen hunk when there are several', () => {
    const oldText = '1\n2\n3\n4\n5\n';
    const docText = 'one\n2\n3\n4\nfive\n';
    expect(take(oldText, docText, 0)).toBe('1\n2\n3\n4\nfive\n');
    expect(take(oldText, docText, 1)).toBe('one\n2\n3\n4\n5\n');
  });

  it('handles hunks separated by a single unchanged line independently', () => {
    const oldText = '1\n2\n3\n';
    const docText = 'x\n2\ny\n';
    expect(take(oldText, docText, 0)).toBe('1\n2\ny\n');
    expect(take(oldText, docText, 1)).toBe('x\n2\n3\n');
  });

  it('empties a document against an empty old side (the lens never offers this, but the math holds)', () => {
    expect(take('', 'a\nb\n', 0)).toBe('');
  });

  it('refills an emptied document', () => {
    expect(take('a\nb\n', '', 0)).toBe('a\nb\n');
  });

  it('restores a missing trailing newline', () => {
    expect(take('a\nb\n', 'a\nb', 0)).toBe('a\nb\n');
  });

  it('removes a trailing newline the old side did not have', () => {
    expect(take('a\nb', 'a\nb\n', 0)).toBe('a\nb');
  });

  it('removes an unterminated final line that was added', () => {
    expect(take('a\n', 'a\nb', 0)).toBe('a\n');
  });

  it('restores an unterminated final line that was deleted', () => {
    expect(take('a\nb', 'a\n', 0)).toBe('a\nb');
  });

  it('keeps a CRLF document CRLF even when the old side is LF', () => {
    expect(take('a\nb\nc\n', 'a\r\nB\r\nc\r\n', 0)).toBe('a\r\nb\r\nc\r\n');
  });

  it('keeps a LF document LF even when the old side is CRLF', () => {
    expect(take('a\r\nb\r\nc\r\n', 'a\nB\nc\n', 0)).toBe('a\nb\nc\n');
  });

  it('restores a deletion into a CRLF document with CRLF line breaks', () => {
    expect(take('a\r\nb\r\nc\r\n', 'a\r\nc\r\n', 0)).toBe('a\r\nb\r\nc\r\n');
  });

  it('uses the EOL it is given rather than guessing', () => {
    expect(take('a\nb\n', 'a\n', 0, '\r\n')).toBe('a\nb\r\n');
  });

  it('taking every hunk one by one rebuilds the old text exactly (random cases)', () => {
    let seed = 987;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = ['a', 'b', 'c', ''];
    const randomLines = () =>
      Array.from({ length: Math.floor(random() * 10) }, () => alphabet[Math.floor(random() * alphabet.length)]);
    const join = (lines: string[], eol: string, trailing: boolean) =>
      lines.length === 0 ? '' : lines.join(eol) + (trailing ? eol : '');

    for (let iteration = 0; iteration < 1500; iteration++) {
      const eol = random() < 0.5 ? '\n' : '\r\n';
      const oldLines = randomLines();
      const oldTrailing = random() < 0.7;
      const oldText = join(oldLines, '\n', oldTrailing);
      const docText = join(randomLines(), eol, random() < 0.7);
      const result = takeAllOneByOne(oldText, docText);
      // The document's own EOL is kept — when the doc had no line breaks to detect, LF is used.
      const expectedEol = /\r\n/.test(docText) ? '\r\n' : '\n';
      expect(result).toBe(join(oldLines, expectedEol, oldTrailing));
    }
  });
});

describe('stale-hunk protection', () => {
  it('refuses a hunk whose new side no longer matches the document', () => {
    const [hunk] = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    expect(computeHunkEdit('a\nEDITED\nc\n', hunk, '\n')).toBeUndefined();
  });

  it('refuses a hunk that runs past the end of the document', () => {
    const [hunk] = diffLines('a\n', 'a\nb\nc\n');
    expect(computeHunkEdit('a\nb\n', hunk, '\n')).toBeUndefined();
  });

  it('refuses an insertion after an unterminated final line', () => {
    expect(computeHunkEdit('a', { oldStart: 1, oldLines: ['b\n'], newStart: 1, newLines: [] }, '\n')).toBeUndefined();
  });

  it('refuses a hunk whose line only differs by a trailing newline', () => {
    const [hunk] = diffLines('x\n', 'a\n');
    expect(computeHunkEdit('a', hunk, '\n')).toBeUndefined();
  });

  it('findMatchingHunk finds the same hunk after an edit below it', () => {
    const oldText = '1\n2\n3\n4\n';
    const [expected] = diffLines(oldText, 'one\n2\n3\n4\n');
    const fresh = diffLines(oldText, 'one\n2\n3\nfour\n');
    expect(findMatchingHunk(fresh, expected)).toEqual(expected);
  });

  it('findMatchingHunk bails after an edit above the hunk shifts it', () => {
    const oldText = '1\n2\n3\n4\n';
    const [expected] = diffLines(oldText, '1\n2\n3\nfour\n');
    const fresh = diffLines(oldText, 'inserted\n1\n2\n3\nfour\n');
    expect(findMatchingHunk(fresh, expected)).toBeUndefined();
  });

  it('findMatchingHunk bails after the hunk itself was edited', () => {
    const oldText = '1\n2\n';
    const [expected] = diffLines(oldText, '1\ntwo\n');
    expect(findMatchingHunk(diffLines(oldText, '1\nTWO\n'), expected)).toBeUndefined();
  });

  it('findMatchingHunk bails when the old side changed', () => {
    const [expected] = diffLines('1\n2\n', '1\ntwo\n');
    expect(findMatchingHunk(diffLines('1\nzwei\n', '1\ntwo\n'), expected)).toBeUndefined();
  });
});

describe('hunk anchors and spans', () => {
  it('anchors a modification at its first new-side line', () => {
    const [hunk] = diffLines('a\nb\nc\n', 'a\nB\nC\n');
    expect(hunkAnchorLine(hunk, 4)).toBe(1);
    expect(hunkLineSpan(hunk, 4)).toEqual({ start: 1, end: 2 });
  });

  it('anchors a deletion at the line below the gap, spanning one line', () => {
    const [hunk] = diffLines('a\nb\nc\n', 'a\nc\n');
    expect(hunkLineSpan(hunk, 3)).toEqual({ start: 1, end: 1 });
  });

  it('clamps an end-of-file deletion anchor to the last editor line', () => {
    const [hunk] = diffLines('a\nb', 'a\n');
    // 'a\n' has two editor lines in VS Code: 'a' and an empty line after the trailing newline.
    expect(hunkAnchorLine(hunk, 2)).toBe(1);
    const [unterminated] = diffLines('a\nb\n', 'a');
    expect(hunkAnchorLine(unterminated, 1)).toBe(0);
  });

  it('anchors on line 0 of an emptied document', () => {
    const [hunk] = diffLines('a\n', '');
    expect(hunkAnchorLine(hunk, 1)).toBe(0);
  });

  it('hunkAtLine finds the hunk covering a line', () => {
    const hunks = diffLines('1\n2\n3\n4\n5\n', 'x\n2\n3\ny\nz\n');
    expect(hunkAtLine(hunks, 0, 6)).toBe(hunks[0]);
    expect(hunkAtLine(hunks, 1, 6)).toBeUndefined();
    expect(hunkAtLine(hunks, 4, 6)).toBe(hunks[1]);
  });
});

describe('detectEol / looksBinary', () => {
  it('detects CRLF and LF, defaulting to LF', () => {
    expect(detectEol('a\r\nb')).toBe('\r\n');
    expect(detectEol('a\nb\r\n')).toBe('\n');
    expect(detectEol('a')).toBe('\n');
  });

  it('flags text with a NUL byte as binary', () => {
    expect(looksBinary('PNG\0\0data')).toBe(true);
    expect(looksBinary('plain text')).toBe(false);
  });
});

describe('branch pane binary placeholder', () => {
  it('replaces binary content with a one-line placeholder', () => {
    expect(branchPaneText('PNG\0\0data')).toBe(BINARY_PANE_PLACEHOLDER);
    expect(branchPaneText('x'.repeat(7999) + '\0')).toBe(BINARY_PANE_PLACEHOLDER);
  });

  it('passes text through untouched, including a NUL past the first 8000 characters', () => {
    expect(branchPaneText('plain\ntext\n')).toBe('plain\ntext\n');
    const late = 'x'.repeat(8000) + '\0';
    expect(branchPaneText(late)).toBe(late);
  });

  it('treats the placeholder (and binary) as untakeable old text', () => {
    expect(isUntakeableOldText(BINARY_PANE_PLACEHOLDER)).toBe(true);
    expect(isUntakeableOldText('a\0b')).toBe(true);
    expect(isUntakeableOldText('line 1\n')).toBe(false);
  });
});
