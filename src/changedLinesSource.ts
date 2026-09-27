import * as vscode from 'vscode';
import type { GitService } from './gitService';
import type { ComparisonState } from './comparisonState';
import type { RepositoryManager } from './repositoryManager';
import type { LineRange } from './types';
import { relativePathInside } from './pathUtils';

interface CacheEntry {
  version: number;
  lines: Promise<Set<number> | undefined>;
}

/**
 * Resolves and caches which line numbers of a `file://` document (the working-tree pane) are
 * added/modified relative to the comparison target — a branch's merge-base, or
 * another worktree's own copy of the file — used to
 * restrict `BlameAnnotationController`'s margin annotations to changed lines instead of the whole
 * file. `file://` only, and only for documents under `repoRoot`: annotations only ever render on
 * *this* worktree's own working-tree pane, never the other side of the diff — see
 * `BlameAnnotationController`'s doc comment for why.
 *
 * Keyed by document URI *and* the comparison target (unlike `BlameSource`, whose blame doesn't
 * depend on the target): switching targets changes what counts as "changed" without necessarily
 * bumping the document's version, so a plain version-keyed cache would serve stale results after
 * a switch.
 *
 * Returns `undefined` when there's no comparison target to diff against (or the document isn't a
 * working-tree file in this repo) — callers treat that the same as an empty set, i.e. show
 * nothing, rather than falling back to "show everything," since there is no base to call anything
 * changed relative to.
 */
export class ChangedLinesSource {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly gitService: GitService,
    private readonly comparisonState: ComparisonState,
    private readonly repositories: RepositoryManager,
  ) {}

  getChangedLines(document: vscode.TextDocument): Promise<Set<number> | undefined> {
    if (document.uri.scheme !== 'file') {
      return Promise.resolve(undefined);
    }
    // The document's own repo and that repo's target — not the active repo's.
    const repoRoot = this.repositories.repoForUri(document.uri);
    const target = repoRoot === undefined ? undefined : this.comparisonState.getTarget(repoRoot);
    if (!repoRoot || !target) {
      return Promise.resolve(undefined);
    }

    const relativePath = relativePathInside(repoRoot, document.uri.fsPath);
    if (relativePath === undefined) {
      return Promise.resolve(undefined); // outside the repo
    }

    const targetKey = target.kind === 'branch' ? target.name : target.path;
    const key = `${document.uri.toString()}::${repoRoot}::${targetKey}`;
    const existing = this.cache.get(key);
    if (existing && existing.version === document.version) {
      return existing.lines;
    }

    const ranges =
      target.kind === 'branch'
        ? this.gitService.getChangedLineRanges(target.name, relativePath, repoRoot)
        : this.gitService.getChangedLineRangesAgainstWorktree(target.path, relativePath, repoRoot);

    const lines = ranges.then(rangesToLineSet).catch(() => undefined);
    this.cache.set(key, { version: document.version, lines });
    return lines;
  }

  /** Drops all cached ranges — see `BlameSource.clear`'s doc comment for why this is needed. */
  clear(): void {
    this.cache.clear();
  }
}

function rangesToLineSet(ranges: LineRange[]): Set<number> {
  const set = new Set<number>();
  for (const range of ranges) {
    for (let line = range.start; line <= range.end; line++) {
      set.add(line);
    }
  }
  return set;
}
