import { describe, it, expect } from 'vitest';
import { buildChangedFilesLayout, buildChangedFilesList, buildChangedFilesTree } from '../../src/treeBuilder';
import type { ChangedFile } from '../../src/types';

describe('buildChangedFilesTree', () => {
  it('nests files under folders derived from their paths', () => {
    const files: ChangedFile[] = [
      { status: 'M', path: 'src/extension.ts' },
      { status: 'A', path: 'src/gitService.ts' },
      { status: 'M', path: 'README.md' },
    ];

    const tree = buildChangedFilesTree(files);

    expect(tree).toEqual([
      {
        kind: 'folder',
        name: 'src',
        path: 'src',
        children: [
          { kind: 'file', name: 'extension.ts', path: 'src/extension.ts', status: 'M' },
          { kind: 'file', name: 'gitService.ts', path: 'src/gitService.ts', status: 'A' },
        ],
      },
      { kind: 'file', name: 'README.md', path: 'README.md', status: 'M' },
    ]);
  });

  it('sorts folders before files, both alphabetically', () => {
    const files: ChangedFile[] = [
      { status: 'M', path: 'zeta.ts' },
      { status: 'M', path: 'alpha/file.ts' },
      { status: 'M', path: 'beta.ts' },
    ];

    const tree = buildChangedFilesTree(files);

    expect(tree.map((node) => node.name)).toEqual(['alpha', 'beta.ts', 'zeta.ts']);
  });

  it('nests deeply and groups siblings under a shared folder', () => {
    const files: ChangedFile[] = [
      { status: 'M', path: 'src/nested/deep/file.ts' },
      { status: 'A', path: 'src/nested/deep/other.ts' },
    ];

    const tree = buildChangedFilesTree(files);
    const src = tree[0];
    if (src.kind !== 'folder') {
      throw new Error('expected src to be a folder');
    }
    const nested = src.children[0];
    if (nested.kind !== 'folder') {
      throw new Error('expected nested to be a folder');
    }
    const deep = nested.children[0];
    if (deep.kind !== 'folder') {
      throw new Error('expected deep to be a folder');
    }

    expect(deep.children.map((child) => child.name)).toEqual(['file.ts', 'other.ts']);
  });

  it('returns an empty tree for no changed files', () => {
    expect(buildChangedFilesTree([])).toEqual([]);
  });

  it('carries additions/deletions through onto the file node', () => {
    const files: ChangedFile[] = [{ status: 'M', path: 'file.ts', additions: 5, deletions: 2 }];

    const tree = buildChangedFilesTree(files);

    expect(tree).toEqual([
      { kind: 'file', name: 'file.ts', path: 'file.ts', status: 'M', additions: 5, deletions: 2 },
    ]);
  });
});

describe('buildChangedFilesList', () => {
  it('lists every file at the top level, sorted by full path, with its directory', () => {
    const files: ChangedFile[] = [
      { status: 'M', path: 'src/z.ts', additions: 1, deletions: 0 },
      { status: 'A', path: 'README.md' },
      { status: 'D', path: 'src/nested/a.ts' },
      { status: 'M', path: 'src/a.ts' },
    ];

    expect(buildChangedFilesList(files)).toEqual([
      { kind: 'file', name: 'README.md', path: 'README.md', status: 'A', additions: undefined, deletions: undefined },
      { kind: 'file', name: 'a.ts', path: 'src/a.ts', status: 'M', directory: 'src', additions: undefined, deletions: undefined },
      {
        kind: 'file',
        name: 'a.ts',
        path: 'src/nested/a.ts',
        status: 'D',
        directory: 'src/nested',
        additions: undefined,
        deletions: undefined,
      },
      { kind: 'file', name: 'z.ts', path: 'src/z.ts', status: 'M', directory: 'src', additions: 1, deletions: 0 },
    ]);
  });

  it('returns an empty list for no changed files', () => {
    expect(buildChangedFilesList([])).toEqual([]);
  });
});

describe('renames', () => {
  const files: ChangedFile[] = [
    { status: 'R', path: 'src/new.ts', previousPath: 'old.ts', additions: 0, deletions: 0 },
    { status: 'M', path: 'src/a.ts' },
  ];

  it('carries previousPath onto a renamed file node in both layouts, and only there', () => {
    for (const layout of ['tree', 'list'] as const) {
      const nodes = buildChangedFilesLayout(files, layout);
      const flat = nodes.flatMap((node) => (node.kind === 'folder' ? node.children : [node]));
      const renamed = flat.find((node) => node.path === 'src/new.ts');
      const modified = flat.find((node) => node.path === 'src/a.ts');
      expect(renamed).toMatchObject({ kind: 'file', previousPath: 'old.ts' });
      expect(modified && 'previousPath' in modified).toBe(false);
    }
  });
});

describe('buildChangedFilesLayout', () => {
  const files: ChangedFile[] = [{ status: 'M', path: 'src/a.ts' }];

  it('nests for "tree"', () => {
    expect(buildChangedFilesLayout(files, 'tree')).toEqual(buildChangedFilesTree(files));
  });

  it('flattens for "list"', () => {
    expect(buildChangedFilesLayout(files, 'list')).toEqual(buildChangedFilesList(files));
  });
});
