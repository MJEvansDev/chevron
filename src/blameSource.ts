import * as vscode from 'vscode';
import type { GitService } from './gitService';
import type { ComparisonState } from './comparisonState';
import type { RepositoryManager } from './repositoryManager';
import { CHEVRON_SCHEME, parseBranchRefUri } from './branchContentProvider';
import type { BlameLine } from './types';
import { relativePathInside } from './pathUtils';
import { isTooLargeForBlame } from './limits';

export type BlameRequest =
  | { kind: 'workingTree'; relativePath: string; cwd: string }
  | { kind: 'ref'; relativePath: string; branch: string; cwd: string };

interface CacheEntry {
  version: number;
  lines: Promise<BlameLine[]>;
}

/**
 * Resolves and caches per-document blame, shared by `BlameHoverProvider` and
 * `BlameAnnotationController` so both draw on the same `git blame` call per document version
 * rather than each running it independently.
 */
export class BlameSource {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly gitService: GitService,
    private readonly comparisonState: ComparisonState,
    private readonly repositories: RepositoryManager,
  ) {}

  /**
   * Which pane `document` belongs to and what to blame for it — `undefined` for anything outside
   * the repo (or not one of Chevron's panes) so callers can no-op cleanly.
   *
   * The repo is the one the document itself belongs to (`RepositoryManager.repoForUri`), not the
   * active one. A `file://` document outside every open repo but under some repo's worktree
   * comparison target's directory also resolves to a plain `'workingTree'` request, cwd'd at that worktree
   * instead — the "other side" of a worktree
   * diff is a real file on disk, not a `git show` snapshot, so it blames the same way the local
   * pane does rather than needing the `'ref'` treatment a branch comparison's other side gets.
   */
  resolveRequest(document: vscode.TextDocument): BlameRequest | undefined {
    if (document.uri.scheme === 'file') {
      const repoRoot = this.repositories.repoForUri(document.uri);
      if (repoRoot !== undefined) {
        const relativeToRepo = relativePathInside(repoRoot, document.uri.fsPath);
        if (relativeToRepo !== undefined) {
          return { kind: 'workingTree', relativePath: relativeToRepo, cwd: repoRoot };
        }
        return undefined; // the repo root directory itself
      }

      // Outside every open repo: the other side of some repo's worktree comparison?
      for (const root of this.repositories.repositories) {
        const target = this.comparisonState.getTarget(root);
        if (target?.kind === 'worktree') {
          const relativeToWorktree = relativePathInside(target.path, document.uri.fsPath);
          if (relativeToWorktree !== undefined) {
            return { kind: 'workingTree', relativePath: relativeToWorktree, cwd: target.path };
          }
        }
      }
      return undefined; // outside every repo and every worktree comparison target
    }

    if (document.uri.scheme === CHEVRON_SCHEME) {
      const repoRoot = this.repositories.repoForUri(document.uri);
      const { branch, relativePath } = parseBranchRefUri(document.uri);
      if (!branch || repoRoot === undefined) {
        return undefined;
      }
      return { kind: 'ref', relativePath, branch, cwd: repoRoot };
    }

    return undefined;
  }

  getBlame(document: vscode.TextDocument): Promise<BlameLine[]> {
    const request = this.resolveRequest(document);
    if (!request || BlameSource.isTooLarge(document)) {
      return Promise.resolve([]);
    }

    const key = document.uri.toString();
    const existing = this.cache.get(key);
    // Branch-side documents change only when the merge-base moves and `BranchContentProvider`
    // re-reads them — which bumps `document.version` too, so the same key works for both sides.
    if (existing && existing.version === document.version) {
      return existing.lines;
    }

    const lines =
      request.kind === 'workingTree'
        ? this.gitService.getBlame(request.relativePath, request.cwd).catch(() => [])
        : this.gitService.getBlameAtRef(request.branch, request.relativePath, request.cwd).catch(() => []);
    this.cache.set(key, { version: document.version, lines });
    return lines;
  }

  /**
   * Very large files get no blame at all (hover or annotations) — `git blame --line-porcelain` on
   * a 100k-line file takes seconds and produces tens of MB. See `limits.ts` for the thresholds.
   */
  static isTooLarge(document: vscode.TextDocument): boolean {
    const lastLine = document.lineCount - 1;
    const charCount = lastLine < 0 ? 0 : document.offsetAt(document.lineAt(lastLine).range.end);
    return isTooLargeForBlame(document.lineCount, charCount);
  }

  /**
   * Drops all cached blame. Needed alongside the document-version cache because blame can go
   * stale without the document's version changing at all — e.g. committing what was an
   * uncommitted line doesn't touch the open document, but should flip that line from "Not
   * committed yet" to the new commit. Called from the same trigger that refreshes the
   * changed-files tree (`.git/HEAD`/`.git/index`/`.git/refs/**` changing, or a save).
   */
  clear(): void {
    this.cache.clear();
  }
}
