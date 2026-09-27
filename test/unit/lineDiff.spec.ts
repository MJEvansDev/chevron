import { describe, it, expect } from 'vitest';
import { applyHunksReversed, diffLines, splitLines, tokenizeLines, tokensToText } from '../../src/lineDiff';

describe('splitLines', () => {
  it('returns no lines for empty text', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('keeps each line\'s own terminator, with an unterminated final line', () => {
    expect(splitLines('a\r\nb\nc')).toEqual([
      { text: 'a', eol: '\r\n' },
      { text: 'b', eol: '\n' },
      { text: 'c', eol: '' },
    ]);
  });

  it('does not invent an empty final line after a trailing newline', () => {
    expect(splitLines('a\n')).toEqual([{ text: 'a', eol: '\n' }]);
  });

  it('treats a lone CR as a line break', () => {
    expect(splitLines('a\rb')).toEqual([
      { text: 'a', eol: '\r' },
      { text: 'b', eol: '' },
    ]);
  });

  it('keeps empty lines', () => {
    expect(splitLines('\n\n')).toEqual([
      { text: '', eol: '\n' },
      { text: '', eol: '\n' },
    ]);
  });
});

describe('tokensToText', () => {
  it('writes every terminated line with the given EOL and leaves an unterminated one bare', () => {
    expect(tokensToText(['a\n', 'b\n', 'c'], '\r\n')).toBe('a\r\nb\r\nc');
  });
});

describe('diffLines', () => {
  it('reports nothing for identical texts', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('ignores CRLF vs LF differences', () => {
    expect(diffLines('a\nb\n', 'a\r\nb\r\n')).toEqual([]);
  });

  it('reports a modification', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ oldStart: 1, oldLines: ['b\n'], newStart: 1, newLines: ['B\n'] }]);
  });

  it('reports a pure addition with an empty old side', () => {
    expect(diffLines('a\nc\n', 'a\nb\nc\n')).toEqual([{ oldStart: 1, oldLines: [], newStart: 1, newLines: ['b\n'] }]);
  });

  it('reports a pure deletion anchored at the following new-side line', () => {
    expect(diffLines('a\nb\nc\n', 'a\nc\n')).toEqual([{ oldStart: 1, oldLines: ['b\n'], newStart: 1, newLines: [] }]);
  });

  it('reports a deletion at the very end anchored past the last line', () => {
    expect(diffLines('a\nb\n', 'a\n')).toEqual([{ oldStart: 1, oldLines: ['b\n'], newStart: 1, newLines: [] }]);
  });

  it('reports a deletion at the very start', () => {
    expect(diffLines('a\nb\n', 'b\n')).toEqual([{ oldStart: 0, oldLines: ['a\n'], newStart: 0, newLines: [] }]);
  });

  it('treats a missing trailing newline as a change to the last line', () => {
    expect(diffLines('a\nb\n', 'a\nb')).toEqual([{ oldStart: 1, oldLines: ['b\n'], newStart: 1, newLines: ['b'] }]);
  });

  it('reports everything as added against an empty old side', () => {
    expect(diffLines('', 'a\nb\n')).toEqual([{ oldStart: 0, oldLines: [], newStart: 0, newLines: ['a\n', 'b\n'] }]);
  });

  it('reports everything as deleted when the new side is empty', () => {
    expect(diffLines('a\nb\n', '')).toEqual([{ oldStart: 0, oldLines: ['a\n', 'b\n'], newStart: 0, newLines: [] }]);
  });

  it('keeps hunks separated by a single unchanged line apart', () => {
    expect(diffLines('1\n2\n3\n', 'x\n2\ny\n')).toEqual([
      { oldStart: 0, oldLines: ['1\n'], newStart: 0, newLines: ['x\n'] },
      { oldStart: 2, oldLines: ['3\n'], newStart: 2, newLines: ['y\n'] },
    ]);
  });

  it('reports several independent hunks in order', () => {
    const oldText = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', ''].join('\n');
    const newText = ['1', 'two', '3', '4', '6', '7', '8', 'added', '9', '10', ''].join('\n');
    expect(diffLines(oldText, newText)).toEqual([
      { oldStart: 1, oldLines: ['2\n'], newStart: 1, newLines: ['two\n'] },
      { oldStart: 4, oldLines: ['5\n'], newStart: 4, newLines: [] },
      { oldStart: 8, oldLines: [], newStart: 7, newLines: ['added\n'] },
    ]);
  });

  it('round-trips random edits (reverse-applying all hunks rebuilds the old text)', () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = ['a', 'b', 'c', 'd', ''];
    const randomText = () => {
      const count = Math.floor(random() * 12);
      const lines = Array.from({ length: count }, () => alphabet[Math.floor(random() * alphabet.length)]);
      const text = lines.join('\n');
      return random() < 0.5 && count > 0 ? `${text}\n` : text;
    };

    for (let iteration = 0; iteration < 2000; iteration++) {
      const oldText = randomText();
      const newText = randomText();
      const hunks = diffLines(oldText, newText);
      expect(applyHunksReversed(tokenizeLines(newText), hunks)).toEqual(tokenizeLines(oldText));
      // Hunks are ordered, non-overlapping and never adjacent (adjacent ones would have been merged).
      for (let i = 1; i < hunks.length; i++) {
        expect(hunks[i].newStart).toBeGreaterThan(hunks[i - 1].newStart + hunks[i - 1].newLines.length);
        expect(hunks[i].oldStart).toBeGreaterThan(hunks[i - 1].oldStart + hunks[i - 1].oldLines.length);
      }
    }
  });

  it('falls back to one coarse (but still correct) hunk for an enormous rewrite', () => {
    const oldText = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n') + '\n';
    const newText = 'keep\n' + Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n') + '\n';
    const hunks = diffLines(`keep\n${oldText}`, newText);
    expect(hunks).toHaveLength(1);
    expect(applyHunksReversed(tokenizeLines(newText), hunks)).toEqual(tokenizeLines(`keep\n${oldText}`));
  });
});
