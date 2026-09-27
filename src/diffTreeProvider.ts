import * as vscode from 'vscode';
import * as path from 'node:path';
import type { GitService } from './gitService';
import type { ComparisonState } from './comparisonState';
import type { RepositoryManager } from './repositoryManager';
import { buildChangedFilesLayout, type TreeNode } from './treeBuilder';
import { comparisonTargetLabel, type ChangedFile, type ComparisonTarget, type GitFileStatus } from './types';
import { capList, MAX_TREE_FILES, truncationMessage } from './limits';
import { reportError } from './errorReporting';
import { formatAheadBehind, formatFileDescription, formatViewDescription, viewHeaderTitle } from './treeDescription';
import { settings } from './settings';

const STATUS_ICONS: Record<GitFileStatus, string> = {
  A: 'diff-added',
  M: 'diff-modified',
  D: 'diff-removed',
  R: 'diff-renamed',
  U: 'diff-added',
};

// Same theme colors VS Code's own git decorations use, so Chevron's status colors line up
// with the ones the user already associates with added/modified/deleted/renamed elsewhere.
const STATUS_COLORS: Record<GitFileStatus, string> = {
  A: 'gitDecoration.addedResourceForeground',
  M: 'gitDecoration.modifiedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  U: 'gitDecoration.untrackedResourceForeground',
};

/**
 * The changed-files view, for the *active* repo (`RepositoryManager.activeRepository`) against
 * that repo's comparison target. Layout (`chevron.treeLayout`) and untracked files
 * (`chevron.showUntrackedFiles`) are read on every `getChildren`.
 */
export class ChangedFilesTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private treeView?: vscode.TreeView<TreeNode>;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly gitService: GitService,
    private readonly comparisonState: ComparisonState,
    private readonly repositories: RepositoryManager,
  ) {
    this.disposables = [
      this.emitter,
      this.comparisonState.onDidChangeComparisonTarget(({ repoRoot }) => this.refreshIfActive(repoRoot)),
      this.comparisonState.onDidClearComparisonTarget(({ repoRoot }) => this.refreshIfActive(repoRoot)),
      this.repositories.onDidChangeActiveRepository(() => this.refresh()),
    ];
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /**
   * Wired up from `extension.ts` after the `TreeView` is created (it needs this provider to
   * exist first). Used to set `message`/`description` from inside `getChildren`, where the data
   * needed to word them (whether the diff came back empty, ahead/behind counts) is already at
   * hand — rather than duplicating that fetch at the call site.
   */
  attachTreeView(treeView: vscode.TreeView<TreeNode>): void {
    this.treeView = treeView;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  private refreshIfActive(repoRoot: string): void {
    if (repoRoot === this.repositories.activeRepository) {
      this.refresh();
    }
  }

  /** Shows `text` (a `describe` result) as the view's header — see `viewHeaderTitle`. */
  setHeader(text: string | undefined): void {
    if (this.treeView) {
      this.treeView.title = viewHeaderTitle(text);
      this.treeView.description = undefined;
    }
  }

  /** The view description for `repoRoot` (prefixed with the repo name only when several repos are open). */
  describe(repoRoot: string | undefined, targetLabel?: string, suffix?: string): string | undefined {
    const repoName = repoRoot !== undefined && this.repositories.hasMultiple ? this.repositories.displayName(repoRoot) : undefined;
    return formatViewDescription({ repoName, targetLabel, suffix });
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'folder') {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'chevron.folder';
      return item;
    }

    const repoRoot = this.repositories.activeRepository;
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.description = formatFileDescription(element);
    item.iconPath = new vscode.ThemeIcon(
      STATUS_ICONS[element.status],
      new vscode.ThemeColor(STATUS_COLORS[element.status]),
    );
    item.contextValue = 'chevron.file';
    if (repoRoot) {
      item.resourceUri = vscode.Uri.file(path.join(repoRoot, element.path));
    }
    if (element.previousPath !== undefined) {
      item.tooltip = `${element.previousPath} → ${element.path}`;
    }
    // `previousPath` so a rename's diff reads its old side from the old path (see `openFileDiff`).
    item.command = {
      command: 'chevron.openFileDiff',
      title: 'Open Diff',
      arguments: [element.path, repoRoot, element.previousPath],
    };
    return item;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) {
      return element.kind === 'folder' ? element.children : [];
    }

    const repoRoot = this.repositories.activeRepository;
    const target = repoRoot === undefined ? undefined : this.comparisonState.getTarget(repoRoot);
    if (!repoRoot || !target) {
      if (this.treeView) {
        // Clear anything left over from a previous target (e.g. one that was just cleared because
        // its branch was deleted) so the welcome view isn't shown under a stale message.
        this.treeView.message = undefined;
        this.setHeader(this.describe(repoRoot));
      }
      return [];
    }

    try {
      return await this.getRootChildren(target, repoRoot);
    } catch (error) {
      // Never let a git failure (bad ref, git missing, output over maxBuffer) escape as a rejected
      // `getChildren` — show it in the view itself, plus a (deduplicated) toast.
      reportError(error);
      if (this.treeView) {
        this.treeView.message = `Couldn't compare against ${comparisonTargetLabel(target)}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      return [];
    }
  }

  private async getRootChildren(target: ComparisonTarget, repoRoot: string): Promise<TreeNode[]> {
    const options = { includeUntracked: settings.showUntrackedFiles() };
    if (target.kind === 'worktree') {
      const files = await this.gitService.getChangedFilesBetweenWorktrees(target.path, repoRoot, options);
      // No ahead/behind suffix here: that's a commit-count divergence between two branches,
      // and two working directories don't have one.
      return this.buildTree(repoRoot, files, target.label, this.describe(repoRoot, target.label));
    }

    const branch = target.name;
    const [files, aheadBehind] = await Promise.all([
      this.gitService.getChangedFiles(branch, repoRoot, options),
      // Cosmetic only (the description line) — a failure here shouldn't block the file tree itself.
      this.gitService.getAheadBehind(branch, repoRoot).catch(() => undefined),
    ]);
    const label = comparisonTargetLabel(target);
    const suffix = aheadBehind ? formatAheadBehind(aheadBehind) : undefined;
    return this.buildTree(repoRoot, files, label, this.describe(repoRoot, label, suffix));
  }

  /**
   * Builds the tree (or flat list), capped at `MAX_TREE_FILES` files (a branch diverged by tens of
   * thousands of files would otherwise build a tree VS Code struggles to render), and sets the
   * view's description/message: "no differences", or "showing first N of M" when capped.
   */
  private buildTree(repoRoot: string, files: ChangedFile[], label: string, description: string | undefined): TreeNode[] {
    const capped = capList(files, MAX_TREE_FILES);
    const tree = buildChangedFilesLayout(capped.shown, settings.treeLayout());
    // The active repo can change while git runs; that change schedules its own refresh, so don't
    // stamp this (now stale) repo's description/message onto the view.
    if (this.treeView && repoRoot === this.repositories.activeRepository) {
      this.setHeader(description);
      this.treeView.message = capped.truncated
        ? truncationMessage(capped.shown.length, capped.total)
        : tree.length === 0
          ? `No differences between the working tree and ${label}.`
          : undefined;
    }
    return tree;
  }
}
