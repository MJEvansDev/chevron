import type { BranchRef, WorktreeRef } from './gitService';
import { comparisonTargetLabel, type ComparisonTarget } from './types';

export interface BranchRow {
  kind: 'branch';
  target: Extract<ComparisonTarget, { kind: 'branch' }>;
  label: string;
  description?: string;
  remote: boolean;
}

export interface WorktreeRow {
  kind: 'worktree';
  target: Extract<ComparisonTarget, { kind: 'worktree' }>;
  label: string;
  description?: string;
}

/** A tag — stored as a `{ kind: 'branch' }` target, since that already works for any ref git resolves. */
export interface TagRow {
  kind: 'tag';
  target: Extract<ComparisonTarget, { kind: 'branch' }>;
  label: string;
  description?: string;
}

/** "Enter a tag, commit SHA or ref…" — opens an InputBox rather than selecting a target directly. */
export interface EnterRefRow {
  kind: 'enterRef';
  label: string;
  description?: string;
}

export interface SeparatorRow {
  kind: 'separator';
  label: string;
}

export type BranchPickerRow = BranchRow | TagRow | WorktreeRow | EnterRefRow | SeparatorRow;

/**
 * Groups branches into a "Local" section and a "Remote" section (each internally sorted so the
 * one currently selected for comparison comes first, marked with a checkmark — otherwise
 * re-opening the picker to change branches gives no indication of what you're currently
 * comparing against), separated by a labeled divider row.
 *
 * Deliberately has no runtime dependency on the `vscode` module (only a type-only import,
 * erased at build time) so it's testable under Vitest — see `branchPicker.ts`, which turns these
 * plain rows into actual `vscode.QuickPickItem`s (separators, icons) and drives the QuickPick.
 */
export function orderAndLabelBranches(
  branches: BranchRef[],
  current: string,
  currentTarget?: ComparisonTarget,
  worktrees: WorktreeRef[] = [],
  tags: string[] = [],
): BranchPickerRow[] {
  const local = branches.filter((branch) => !branch.remote);
  const remote = branches.filter((branch) => branch.remote);

  const rows: BranchPickerRow[] = [];
  if (local.length > 0) {
    rows.push({ kind: 'separator', label: 'Local' });
    rows.push(...labelGroup(local, current, currentTarget));
  }
  if (remote.length > 0) {
    rows.push({ kind: 'separator', label: 'Remote' });
    rows.push(...labelGroup(remote, current, currentTarget));
  }
  if (tags.length > 0) {
    rows.push({ kind: 'separator', label: 'Tags' });
    rows.push(...labelTags(tags, currentTarget));
  }
  if (worktrees.length > 0) {
    rows.push({ kind: 'separator', label: 'Worktrees' });
    rows.push(...labelWorktrees(worktrees, currentTarget));
  }
  return rows;
}

function labelGroup(group: BranchRef[], current: string, currentTarget: ComparisonTarget | undefined): BranchRow[] {
  const isCurrent = (name: string) => currentTarget?.kind === 'branch' && currentTarget.name === name;

  const ordered = group.slice().sort((a, b) => {
    if (isCurrent(a.name)) {
      return -1;
    }
    if (isCurrent(b.name)) {
      return 1;
    }
    return 0;
  });

  return ordered.map((branch) => {
    const isComparing = isCurrent(branch.name);
    const descriptors: string[] = [];
    if (isComparing) {
      descriptors.push('currently comparing');
    }
    if (branch.name === current) {
      descriptors.push('current branch');
    }

    return {
      kind: 'branch',
      target: { kind: 'branch', name: branch.name },
      label: isComparing ? `$(check) ${branch.name}` : branch.name,
      description: descriptors.length > 0 ? descriptors.join(' · ') : undefined,
      remote: branch.remote,
    };
  });
}

function labelTags(tags: string[], currentTarget: ComparisonTarget | undefined): TagRow[] {
  const isCurrent = (name: string) => currentTarget?.kind === 'branch' && currentTarget.name === name;
  const ordered = tags.slice().sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)));
  return ordered.map((name) => ({
    kind: 'tag',
    target: { kind: 'branch', name },
    label: isCurrent(name) ? `$(check) ${name}` : name,
    description: isCurrent(name) ? 'currently comparing' : undefined,
  }));
}

export const ENTER_REF_LABEL = '$(edit) Enter a tag, commit SHA or ref…';

/**
 * The picker's free-form entry. If the current comparison target is a ref that none of the listed
 * rows show (a pasted SHA, `HEAD~3`, an old tag beyond the listing cap), its description says so —
 * otherwise re-opening the picker would give no hint of what's being compared.
 */
export function enterRefRow(rows: BranchPickerRow[], currentTarget: ComparisonTarget | undefined): EnterRefRow {
  const listed = rows.some(
    (row) => (row.kind === 'branch' || row.kind === 'tag') && currentTarget?.kind === 'branch' && row.target.name === currentTarget.name,
  );
  return {
    kind: 'enterRef',
    label: ENTER_REF_LABEL,
    description:
      currentTarget?.kind === 'branch' && !listed ? `currently comparing ${comparisonTargetLabel(currentTarget)}` : undefined,
  };
}

/**
 * Cheap, synchronous checks on typed-in ref text before asking git (`rev-parse --verify`) whether
 * it names a commit. Returns an error message, or `undefined` if it's worth asking git.
 */
export function validateRefSyntax(value: string): string | undefined {
  const ref = value.trim();
  if (ref === '') {
    return 'Enter a branch, tag, commit SHA or other ref.';
  }
  if (ref.startsWith('-')) {
    return 'A ref cannot start with "-".';
  }
  if (/\s/.test(ref)) {
    return 'A ref cannot contain whitespace.';
  }
  return undefined;
}

/**
 * Labels other worktrees for the picker's "Worktrees" section — same top-sorting/`$(check)`
 * treatment as `labelGroup`, but keyed by the worktree's directory (rather than the branch
 * checked out there — see below) and with that directory as the description instead of "current
 * branch"/"currently comparing" descriptors (a worktree is never "the current branch" — that
 * concept doesn't apply to a second checkout).
 *
 * Picking a worktree row sets a `{ kind: 'worktree' }` target keyed by directory, not the
 * `{ kind: 'branch' }` target the same branch would get if picked under "Local" — they resolve to
 * two different diff engines (a live filesystem-to-filesystem diff vs. a diff against a committed
 * ref, see `gitService.getChangedFilesBetweenWorktrees`/`getChangedFiles`), so only an exact
 * target match — not just the same underlying branch name — gets the checkmark here.
 */
function labelWorktrees(worktrees: WorktreeRef[], currentTarget: ComparisonTarget | undefined): WorktreeRow[] {
  const isCurrent = (worktreePath: string) => currentTarget?.kind === 'worktree' && currentTarget.path === worktreePath;

  const ordered = worktrees.slice().sort((a, b) => {
    if (isCurrent(a.path)) {
      return -1;
    }
    if (isCurrent(b.path)) {
      return 1;
    }
    return 0;
  });

  return ordered.map((worktree) => {
    const isComparing = isCurrent(worktree.path);
    const name = worktree.branch ?? `${worktree.head.slice(0, 7)} (detached)`;

    return {
      kind: 'worktree',
      target: { kind: 'worktree', path: worktree.path, label: name },
      label: isComparing ? `$(check) ${name}` : name,
      description: isComparing ? `${worktree.path} · currently comparing` : worktree.path,
    };
  });
}
