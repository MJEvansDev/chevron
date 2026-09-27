import { describe, it, expect } from 'vitest';
import {
  enterRefRow,
  orderAndLabelBranches,
  validateRefSyntax,
  ENTER_REF_LABEL,
  type BranchRow,
  type WorktreeRow,
} from '../../src/branchOrdering';
import { comparisonTargetLabel, type ComparisonTarget } from '../../src/types';

function branchRows(rows: ReturnType<typeof orderAndLabelBranches>): BranchRow[] {
  return rows.filter((row): row is BranchRow => row.kind === 'branch');
}

function worktreeRows(rows: ReturnType<typeof orderAndLabelBranches>): WorktreeRow[] {
  return rows.filter((row): row is WorktreeRow => row.kind === 'worktree');
}

function branchTarget(name: string): ComparisonTarget {
  return { kind: 'branch', name };
}

describe('orderAndLabelBranches', () => {
  it('groups local branches under a "Local" separator and sorts the comparison branch to the top', () => {
    const rows = orderAndLabelBranches(
      [
        { name: 'main', remote: false },
        { name: 'feature-a', remote: false },
        { name: 'feature-b', remote: false },
      ],
      'main',
      branchTarget('feature-b'),
    );

    expect(rows[0]).toEqual({ kind: 'separator', label: 'Local' });
    expect(branchRows(rows).map((row) => row.target.name)).toEqual(['feature-b', 'main', 'feature-a']);
    expect(branchRows(rows)[0]).toMatchObject({
      label: '$(check) feature-b',
      description: 'currently comparing',
      remote: false,
    });
  });

  it('puts remote-tracking branches in their own "Remote" section after local branches', () => {
    const rows = orderAndLabelBranches(
      [
        { name: 'main', remote: false },
        { name: 'origin/main', remote: true },
        { name: 'origin/feature', remote: true },
      ],
      'main',
      undefined,
    );

    expect(rows.map((row) => (row.kind === 'branch' ? row.target.name : row.label))).toEqual([
      'Local',
      'main',
      'Remote',
      'origin/main',
      'origin/feature',
    ]);
    expect(branchRows(rows).find((row) => row.target.name === 'origin/main')).toMatchObject({ remote: true });
  });

  it('omits a section entirely when there are no branches of that kind', () => {
    const rows = orderAndLabelBranches([{ name: 'origin/main', remote: true }], 'main', undefined);

    expect(rows[0]).toEqual({ kind: 'separator', label: 'Remote' });
    expect(rows.some((row) => row.kind === 'separator' && row.label === 'Local')).toBe(false);
  });

  it('combines "currently comparing" and "current branch" descriptors when they coincide', () => {
    const rows = orderAndLabelBranches(
      [
        { name: 'main', remote: false },
        { name: 'feature-a', remote: false },
      ],
      'main',
      branchTarget('main'),
    );

    expect(branchRows(rows)[0]).toMatchObject({
      target: { kind: 'branch', name: 'main' },
      label: '$(check) main',
      description: 'currently comparing · current branch',
    });
  });

  it('preserves input order within a group and adds no checkmark when no comparison branch is set', () => {
    const rows = orderAndLabelBranches(
      [
        { name: 'main', remote: false },
        { name: 'feature-a', remote: false },
      ],
      'main',
      undefined,
    );

    expect(branchRows(rows).map((row) => row.target.name)).toEqual(['main', 'feature-a']);
    expect(branchRows(rows)[0]).toMatchObject({ label: 'main', description: 'current branch' });
    expect(branchRows(rows)[1]).toMatchObject({ label: 'feature-a', description: undefined });
  });

  it('omits the "Worktrees" section when there are none', () => {
    const rows = orderAndLabelBranches([{ name: 'main', remote: false }], 'main', undefined, []);

    expect(rows.some((row) => row.kind === 'separator' && row.label === 'Worktrees')).toBe(false);
  });

  it('lists other worktrees under a "Worktrees" section, labeled by the branch checked out there', () => {
    const rows = orderAndLabelBranches(
      [{ name: 'main', remote: false }],
      'main',
      undefined,
      [{ path: '/repo/feature-wt', head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', branch: 'feature-x' }],
    );

    expect(rows[rows.length - 2]).toEqual({ kind: 'separator', label: 'Worktrees' });
    expect(worktreeRows(rows)).toEqual([
      {
        kind: 'worktree',
        target: { kind: 'worktree', path: '/repo/feature-wt', label: 'feature-x' },
        label: 'feature-x',
        description: '/repo/feature-wt',
      },
    ]);
  });

  it('labels a detached-HEAD worktree by a short SHA and compares against the full path', () => {
    const rows = orderAndLabelBranches([], 'main', undefined, [
      { path: '/repo/detached-wt', head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', branch: undefined },
    ]);

    expect(worktreeRows(rows)).toEqual([
      {
        kind: 'worktree',
        target: { kind: 'worktree', path: '/repo/detached-wt', label: 'bbbbbbb (detached)' },
        label: 'bbbbbbb (detached)',
        description: '/repo/detached-wt',
      },
    ]);
  });

  it('marks the worktree currently being compared against with a checkmark', () => {
    const rows = orderAndLabelBranches([], 'main', { kind: 'worktree', path: '/repo/feature-wt', label: 'feature-x' }, [
      { path: '/repo/feature-wt', head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', branch: 'feature-x' },
    ]);

    expect(worktreeRows(rows)[0]).toMatchObject({
      label: '$(check) feature-x',
      description: '/repo/feature-wt · currently comparing',
    });
  });

  it('does not mark a worktree row when the current target is a plain branch of the same name', () => {
    const rows = orderAndLabelBranches([], 'main', branchTarget('feature-x'), [
      { path: '/repo/feature-wt', head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', branch: 'feature-x' },
    ]);

    expect(worktreeRows(rows)[0]).toMatchObject({ label: 'feature-x', description: '/repo/feature-wt' });
  });
});

describe('orderAndLabelBranches — tags', () => {
  it('lists tags in a "Tags" section after remote branches and before worktrees', () => {
    const rows = orderAndLabelBranches(
      [
        { name: 'main', remote: false },
        { name: 'origin/main', remote: true },
      ],
      'main',
      undefined,
      [{ path: '/repo/wt', head: 'abc1234def', branch: 'wt' }],
      ['v2.0', 'v1.0'],
    );

    expect(rows.map((row) => (row.kind === 'separator' ? `[${row.label}]` : row.label))).toEqual([
      '[Local]',
      'main',
      '[Remote]',
      'origin/main',
      '[Tags]',
      'v2.0',
      'v1.0',
      '[Worktrees]',
      'wt',
    ]);
    expect(rows.find((row) => row.kind === 'tag')).toMatchObject({ target: { kind: 'branch', name: 'v2.0' } });
  });

  it('checks and top-sorts the tag currently being compared against', () => {
    const rows = orderAndLabelBranches([], '', { kind: 'branch', name: 'v1.0' }, [], ['v2.0', 'v1.0']);
    const tags = rows.filter((row) => row.kind === 'tag');
    expect(tags.map((row) => row.label)).toEqual(['$(check) v1.0', 'v2.0']);
    expect(tags[0]).toMatchObject({ description: 'currently comparing' });
  });

  it('omits the Tags section when there are no tags', () => {
    const rows = orderAndLabelBranches([{ name: 'main', remote: false }], 'main', undefined, [], []);
    expect(rows.some((row) => row.kind === 'separator' && row.label === 'Tags')).toBe(false);
  });
});

describe('enterRefRow', () => {
  const rows = orderAndLabelBranches([{ name: 'main', remote: false }], 'main', undefined, [], ['v1.0']);

  it('has the edit label and no description when nothing unlisted is being compared', () => {
    expect(enterRefRow(rows, undefined)).toEqual({ kind: 'enterRef', label: ENTER_REF_LABEL, description: undefined });
    expect(enterRefRow(rows, { kind: 'branch', name: 'main' }).description).toBeUndefined();
    expect(enterRefRow(rows, { kind: 'branch', name: 'v1.0' }).description).toBeUndefined();
  });

  it('names a current target that no listed row shows, abbreviating a full SHA', () => {
    const sha = 'a'.repeat(40);
    expect(enterRefRow(rows, { kind: 'branch', name: sha }).description).toBe('currently comparing aaaaaaa');
    expect(enterRefRow(rows, { kind: 'branch', name: 'HEAD~3' }).description).toBe('currently comparing HEAD~3');
  });

  it('says nothing for a worktree target', () => {
    expect(enterRefRow(rows, { kind: 'worktree', path: '/wt', label: 'wt' }).description).toBeUndefined();
  });
});

describe('validateRefSyntax', () => {
  it('accepts ordinary refs', () => {
    expect(validateRefSyntax('v1.2.0')).toBeUndefined();
    expect(validateRefSyntax('  3f2a9c1  ')).toBeUndefined();
    expect(validateRefSyntax('HEAD~3')).toBeUndefined();
    expect(validateRefSyntax('origin/feature/x')).toBeUndefined();
  });

  it('rejects empty input, option-like input and whitespace', () => {
    expect(validateRefSyntax('   ')).toBeDefined();
    expect(validateRefSyntax('--all')).toBeDefined();
    expect(validateRefSyntax('two words')).toBeDefined();
  });
});

describe('comparisonTargetLabel', () => {
  it('shortens a full SHA-1 or SHA-256 to 7 characters', () => {
    expect(comparisonTargetLabel({ kind: 'branch', name: '0123456789abcdef0123456789abcdef01234567' })).toBe('0123456');
    expect(comparisonTargetLabel({ kind: 'branch', name: 'f'.repeat(64) })).toBe('fffffff');
  });

  it('leaves branch names, tags and abbreviated SHAs alone', () => {
    expect(comparisonTargetLabel({ kind: 'branch', name: 'feature/foo' })).toBe('feature/foo');
    expect(comparisonTargetLabel({ kind: 'branch', name: 'v1.0' })).toBe('v1.0');
    expect(comparisonTargetLabel({ kind: 'branch', name: 'abc1234' })).toBe('abc1234');
  });

  it('uses the precomputed label for a worktree', () => {
    expect(comparisonTargetLabel({ kind: 'worktree', path: '/wt', label: 'feature-x' })).toBe('feature-x');
  });
});
