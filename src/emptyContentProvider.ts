import * as vscode from 'vscode';

export const EMPTY_SCHEME = 'chevron-empty';

/**
 * URI for a file that doesn't exist on one side of a worktree comparison (e.g. it's newly added
 * on this side, so the other worktree has nothing to show) — `vscode.diff` can't open a `file://`
 * URI that doesn't exist on disk, so this stands in for it. Same convention `BranchContentProvider`
 * uses for a file missing at a ref, just for a real filesystem path instead of a `git show`.
 * Carries the repo root (like `branchRefUri`) so change navigation knows which repo it belongs to.
 */
export function emptyContentUri(repoRoot: string, relativePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: EMPTY_SCHEME, path: `/${relativePath}`, query: `repo=${encodeURIComponent(repoRoot)}` });
}

/** The repo root an `emptyContentUri` was made for, if any. */
export function parseEmptyContentUriRepo(uri: vscode.Uri): string | undefined {
  return new URLSearchParams(uri.query).get('repo') || undefined;
}

export class EmptyContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return '';
  }
}
