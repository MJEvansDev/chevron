import * as vscode from 'vscode';
import { GitError, type GitService } from './gitService';
import { reportError } from './errorReporting';
import { CHEVRON_SCHEME, parseBranchRefUri } from './branchContentProvider';
import { EMPTY_SCHEME, parseEmptyContentUriRepo } from './emptyContentProvider';
import { chooseActiveRepo, findRepoForPath, repoDisplayNames, uniqueRepoRoots } from './repositories';
import { isSamePath } from './pathUtils';

const ACTIVE_REPO_KEY = 'chevron.activeRepository';
const MULTIPLE_CONTEXT_KEY = 'chevron.multipleRepositories';

/**
 * The git repositories open in this window and which one is *active* — the one
 * the changed-files tree shows and repo-less commands act on.
 *
 * - **Discovery** shells out (`git rev-parse --show-toplevel` per workspace folder, deduplicated;
 *   folders that aren't in a repo are skipped) rather than using the built-in `vscode.git`
 *   extension's API — no soft dependency on another extension's activation or its API's stability
 *   Re-run on `onDidChangeWorkspaceFolders` and when `git.path` changes.
 * - **Active repo** follows the active editor: when it shows a document that belongs to a known
 *   repo (a `file://` inside it, or one of Chevron's own panes for it), that repo becomes active;
 *   otherwise the last one stays. `chevron.selectRepository` picks explicitly. Remembered across
 *   sessions in `workspaceState`.
 * - Sets the `chevron.multipleRepositories` context key, which gates the repo picker's menu entries
 *   — with a single repo nothing about the UI changes.
 *
 * Document-scoped features never use the active repo: they ask `repoForUri` for the repo the
 * document itself belongs to.
 */
export class RepositoryManager implements vscode.Disposable {
  private roots: string[] = [];
  private active: string | undefined;
  private readonly changeActiveEmitter = new vscode.EventEmitter<string | undefined>();
  /** The active repo changed (explicitly, by following the editor, or because discovery dropped it). */
  readonly onDidChangeActiveRepository = this.changeActiveEmitter.event;
  private discovery: Promise<void> | undefined;

  constructor(
    private readonly gitService: GitService,
    private readonly workspaceState: vscode.Memento,
  ) {}

  get repositories(): readonly string[] {
    return this.roots;
  }

  get activeRepository(): string | undefined {
    return this.active;
  }

  get hasMultiple(): boolean {
    return this.roots.length > 1;
  }

  /** Display name for a repo root (folder name, disambiguated when two repos share one). */
  displayName(root: string): string {
    return repoDisplayNames(this.roots).get(root) ?? root;
  }

  /** The known root equal to `root` (path-equality), or `undefined` — use before running git anywhere a URI names. */
  knownRepo(root: string | undefined): string | undefined {
    return root === undefined ? undefined : this.roots.find((candidate) => isSamePath(candidate, root));
  }

  /**
   * The known repo a document belongs to: the deepest known repo containing a `file://` path, or
   * the repo recorded in one of Chevron's own `chevron-ref`/`chevron-empty` pane URIs.
   */
  repoForUri(uri: vscode.Uri): string | undefined {
    if (uri.scheme === 'file') {
      return findRepoForPath(this.roots, uri.fsPath);
    }
    if (uri.scheme === CHEVRON_SCHEME) {
      return this.knownRepo(parseBranchRefUri(uri).repoRoot);
    }
    if (uri.scheme === EMPTY_SCHEME) {
      return this.knownRepo(parseEmptyContentUriRepo(uri));
    }
    return undefined;
  }

  /**
   * (Re)discovers repos from the workspace folders. Concurrent calls share one run. Resolves after
   * `onDidChangeActiveRepository` listeners have been fired.
   */
  discover(): Promise<void> {
    if (!this.discovery) {
      this.discovery = this.runDiscovery().finally(() => {
        this.discovery = undefined;
      });
    }
    return this.discovery;
  }

  private async runDiscovery(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const found = await Promise.all(
      folders.map(async (folder) => {
        if (folder.uri.scheme !== 'file') {
          return undefined;
        }
        try {
          return await this.gitService.getRepoRoot(folder.uri.fsPath);
        } catch (error) {
          // "Not a git repository" is a normal state (the commands say so when used); a git binary
          // that can't be run at all is worth telling the user about up front.
          if (error instanceof GitError && error.kind === 'notFound') {
            reportError(error);
          }
          return undefined;
        }
      }),
    );
    const roots = uniqueRepoRoots(found.filter((root): root is string => root !== undefined));
    this.roots = roots;

    const editorUri = vscode.window.activeTextEditor?.document.uri;
    const nextActive = chooseActiveRepo(roots, {
      fromEditor: editorUri?.scheme === 'file' ? findRepoForPath(roots, editorUri.fsPath) : undefined,
      previous: this.active,
      remembered: this.workspaceState.get<string>(ACTIVE_REPO_KEY),
    });

    await vscode.commands.executeCommand('setContext', MULTIPLE_CONTEXT_KEY, roots.length > 1);
    await this.setActive(nextActive);
  }

  /** Makes `root` (which must be a known repo, or `undefined` when there are none) the active one. */
  async setActive(root: string | undefined): Promise<void> {
    const known = this.knownRepo(root);
    if (known === this.active) {
      return;
    }
    this.active = known;
    if (known !== undefined) {
      await this.workspaceState.update(ACTIVE_REPO_KEY, known);
    }
    this.changeActiveEmitter.fire(known);
  }

  /** Follows the active editor: a document in a known repo makes that repo active; anything else leaves it be. */
  async followEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor) {
      return;
    }
    const root = this.repoForUri(editor.document.uri);
    if (root !== undefined) {
      await this.setActive(root);
    }
  }

  /** `chevron.selectRepository`: a QuickPick of the known repos. */
  async pickRepository(): Promise<string | undefined> {
    if (this.roots.length === 0) {
      void vscode.window.showErrorMessage('Chevron: no git repository found in this workspace.');
      return undefined;
    }
    const items = this.roots.map((root) => ({
      label: this.displayName(root),
      description: root === this.active ? `${root}  (active)` : root,
      iconPath: new vscode.ThemeIcon('repo'),
      root,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Chevron: Select repository',
      placeHolder: 'Which repository should the changed-files view compare?',
    });
    if (picked) {
      await this.setActive(picked.root);
    }
    return picked?.root;
  }

  dispose(): void {
    this.changeActiveEmitter.dispose();
  }
}
