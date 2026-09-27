import * as vscode from 'vscode';
import { PathNotAtRefError, type GitService } from './gitService';
import { reportError } from './errorReporting';
import { branchPaneText } from './hunkApply';

export const CHEVRON_SCHEME = 'chevron-ref';

/**
 * `chevron-ref:/<relativePath>?branch=<ref>&repo=<repo root>`. The repo root is part of the URI so
 * the pane (and blame on it) always reads from the repo the diff was opened for, whichever repo is
 * active by the time VS Code asks for the content — see `RepositoryManager`.
 */
export function branchRefUri(repoRoot: string, branch: string, relativePath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: CHEVRON_SCHEME,
    path: `/${relativePath}`,
    query: `branch=${encodeURIComponent(branch)}&repo=${encodeURIComponent(repoRoot)}`,
  });
}

export function parseBranchRefUri(uri: vscode.Uri): { branch: string; relativePath: string; repoRoot?: string } {
  const params = new URLSearchParams(uri.query);
  const branch = params.get('branch') ?? '';
  const repoRoot = params.get('repo') || undefined;
  const relativePath = uri.path.replace(/^\//, '');
  return { branch, relativePath, repoRoot };
}

/**
 * Serves `chevron-ref:` panes: a file's content at the merge-base of the URI's ref and HEAD.
 *
 * The URI names the ref, not the merge-base commit, so the same URI's content changes whenever
 * the merge-base does (a merge/rebase/checkout, or the ref itself moving). VS Code keeps a virtual
 * document's first snapshot until the provider fires `onDidChange` — `extension.ts` calls
 * `refreshOpenDocuments()` on every git refresh, after the merge-base cache is invalidated, so an
 * open pane (and therefore `← Take from`, which reads its old text from that pane) never goes on
 * showing the old merge-base's content.
 */
export class BranchContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly gitService: GitService,
    /** The open repo a pane URI names, or `undefined` — git never runs in a directory that isn't one. */
    private readonly resolveRepo: (uri: vscode.Uri) => string | undefined,
  ) {}

  /** Asks VS Code to re-read every open `chevron-ref:` document. */
  refreshOpenDocuments(): void {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === CHEVRON_SCHEME) {
        this.changeEmitter.fire(document.uri);
      }
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  /**
   * Only "the path doesn't exist at that ref" renders as an empty pane (correct: the file was added
   * on this side). Any other failure — a bad ref, git missing, output too large — is surfaced as a
   * deduplicated error toast and rethrown, so VS Code shows the pane as failed rather than as an
   * empty file, which would be a diff confidently claiming every line is new.
   *
   * A binary file renders as a one-line placeholder rather than raw bytes (`branchPaneText`).
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { branch, relativePath } = parseBranchRefUri(uri);
    const repoRoot = this.resolveRepo(uri);
    if (!repoRoot) {
      return '';
    }

    try {
      return branchPaneText(await this.gitService.getFileContentAtRef(branch, relativePath, repoRoot));
    } catch (error) {
      if (error instanceof PathNotAtRefError) {
        return '';
      }
      reportError(error);
      throw error;
    }
  }
}
