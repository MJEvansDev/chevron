import { describe, it, expect } from 'vitest';
import { findAdjacentHunkLine, orderedNavigableFiles, rolloverCandidates } from '../../src/changeNavigation';
import { buildChangedFilesTree } from '../../src/treeBuilder';

describe('orderedNavigableFiles', () => {
  it('lists files in tree display order (folders first, alphabetical) and skips deletions', () => {
    const tree = buildChangedFilesTree([
      { status: 'M', path: 'README.md' },
      { status: 'M', path: 'src/b.ts' },
      { status: 'D', path: 'src/gone.ts' },
      { status: 'A', path: 'src/a.ts' },
      { status: 'U', path: 'src/nested/c.ts' },
      { status: 'R', path: 'z.txt', previousPath: 'y.txt' },
    ]);
    expect(orderedNavigableFiles(tree)).toEqual(['src/nested/c.ts', 'src/a.ts', 'src/b.ts', 'README.md', 'z.txt']);
  });

  it('returns nothing for an empty tree', () => {
    expect(orderedNavigableFiles([])).toEqual([]);
  });
});

describe('findAdjacentHunkLine', () => {
  const spans = [
    { start: 2, end: 4 },
    { start: 8, end: 8 },
    { start: 12, end: 15 },
  ];

  it('next goes to the first hunk starting below the cursor', () => {
    expect(findAdjacentHunkLine(spans, 0, 'next')).toBe(2);
    expect(findAdjacentHunkLine(spans, 2, 'next')).toBe(8);
    expect(findAdjacentHunkLine(spans, 3, 'next')).toBe(8);
    expect(findAdjacentHunkLine(spans, 11, 'next')).toBe(12);
  });

  it('next returns undefined past the last hunk', () => {
    expect(findAdjacentHunkLine(spans, 12, 'next')).toBeUndefined();
    expect(findAdjacentHunkLine(spans, 20, 'next')).toBeUndefined();
  });

  it('previous goes to the last hunk ending above the cursor', () => {
    expect(findAdjacentHunkLine(spans, 20, 'previous')).toBe(12);
    expect(findAdjacentHunkLine(spans, 12, 'previous')).toBe(8);
    expect(findAdjacentHunkLine(spans, 14, 'previous')).toBe(8);
    expect(findAdjacentHunkLine(spans, 5, 'previous')).toBe(2);
  });

  it('previous returns undefined at or above the first hunk', () => {
    expect(findAdjacentHunkLine(spans, 2, 'previous')).toBeUndefined();
    expect(findAdjacentHunkLine(spans, 3, 'previous')).toBeUndefined();
    expect(findAdjacentHunkLine(spans, 0, 'previous')).toBeUndefined();
  });

  it('returns undefined with no hunks', () => {
    expect(findAdjacentHunkLine([], 0, 'next')).toBeUndefined();
    expect(findAdjacentHunkLine([], 0, 'previous')).toBeUndefined();
  });
});

describe('rolloverCandidates', () => {
  const files = ['a', 'b', 'c', 'd'];

  it('next lists the files after the current one, without wrapping', () => {
    expect(rolloverCandidates(files, 'b', 'next')).toEqual(['c', 'd']);
    expect(rolloverCandidates(files, 'd', 'next')).toEqual([]);
  });

  it('previous lists the files before the current one, nearest first', () => {
    expect(rolloverCandidates(files, 'c', 'previous')).toEqual(['b', 'a']);
    expect(rolloverCandidates(files, 'a', 'previous')).toEqual([]);
  });

  it('starts from the top (next) or bottom (previous) when the current file is not a changed file', () => {
    expect(rolloverCandidates(files, 'elsewhere', 'next')).toEqual(['a', 'b', 'c', 'd']);
    expect(rolloverCandidates(files, undefined, 'previous')).toEqual(['d', 'c', 'b', 'a']);
  });
});
