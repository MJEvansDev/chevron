/** 'U' (untracked) is synthesized locally — git itself never reports it via --name-status. */
export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'U';

export interface ChangedFile {
  status: GitFileStatus;
  path: string;
  /** Present for renames (status 'R'): the path the file was renamed from. */
  previousPath?: string;
  /** Lines added/removed per `git diff --numstat`. Absent for binary files and untracked files. */
  additions?: number;
  deletions?: number;
}

/** Inclusive, 1-based line range. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * What the working tree is being compared against. A `branch` target diffs against that branch's
 * merge-base with HEAD (see `gitService.getMergeBase`) — a diff against a committed ref. A
 * `worktree` target diffs live against another `git worktree add` checkout's own working
 * directory instead, uncommitted edits there included — a genuinely different diff engine, not
 * just a different label. `label` is the branch checked
 * out there, or a short SHA for a detached HEAD — precomputed by `branchOrdering.ts` since it's
 * needed for display wherever the target itself is (tree view description, diff editor title)
 * without re-deriving it from `path` each time.
 */
export type ComparisonTarget = { kind: 'branch'; name: string } | { kind: 'worktree'; path: string; label: string };

/** A full (SHA-1 or SHA-256) object name, as pasted into "Enter a ref…". */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Display name for a target. A `branch` target's `name` can be any ref git resolves — a branch, a
 * tag, `HEAD~3`, or a pasted SHA (see "Enter a ref…" in `branchPicker.ts`) — so a full SHA is
 * shortened to 7 characters the way git itself abbreviates it.
 */
export function comparisonTargetLabel(target: ComparisonTarget): string {
  if (target.kind === 'worktree') {
    return target.label;
  }
  return FULL_SHA_RE.test(target.name) ? target.name.slice(0, 7) : target.name;
}

export interface BlameLine {
  /** 1-based line number in the blamed file. */
  line: number;
  /** All-zero for an uncommitted line (`git blame`'s "Not Committed Yet"). */
  hash: string;
  author: string;
  /** Usually the same as `author` — differs for e.g. a rebased or cherry-picked commit. */
  committer: string;
  /** Unix seconds. */
  authorTime: number;
  summary: string;
}
