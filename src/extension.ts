import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import gitService, { pickGitBinary, setGitBinary, type MergeBaseFallbackReason } from './gitService';
import { ComparisonState } from './comparisonState';
import { BranchContentProvider, CHEVRON_SCHEME, parseBranchRefUri } from './branchContentProvider';
import { EmptyContentProvider, EMPTY_SCHEME } from './emptyContentProvider';
import { showBranchQuickPick } from './branchPicker';
import { openFileDiff, openWorktreeFileDiff } from './diffOpener';
import { ChangedFilesTreeProvider } from './diffTreeProvider';
import { BlameSource } from './blameSource';
import { BlameHoverProvider } from './blameHoverProvider';
import { BlameAnnotationController } from './blameAnnotations';
import { ChangedLinesSource } from './changedLinesSource';
import { HunkSource } from './hunkSource';
import { TakeFromBranchController, TAKE_HUNK_COMMAND } from './takeFromBranch';
import { registerChangeNavigationCommands } from './changeNavigationCommands';
import { RepositoryManager } from './repositoryManager';
import { defaultComparisonCandidates } from './defaultBranch';
import { settings, setTreeLayout } from './settings';
import type { LineHunk } from './lineDiff';
import type { TreeNode } from './treeBuilder';
import { comparisonTargetLabel, type ComparisonTarget } from './types';
import { reportError, reportWarningOnce } from './errorReporting';
import { relativePathInside } from './pathUtils';

export interface ChevronApi {
  comparisonState: ComparisonState;
  treeView: vscode.TreeView<unknown>;
  treeProvider: ChangedFilesTreeProvider;
  repositories: RepositoryManager;
}

const NO_REPO_MESSAGE = 'Chevron: no git repository found in this workspace.';

/**
 * Honours VS Code's `git.path` setting (a path, or an array of candidate paths — first existing one
 * wins) instead of assuming `git` is on `PATH`. gitService.ts itself stays `vscode`-free; the
 * resolved binary is injected via `setGitBinary`.
 */
function applyGitPathSetting(): void {
  const setting = vscode.workspace.getConfiguration('git').get<unknown>('path');
  setGitBinary(
    pickGitBinary(setting, (candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }),
  );
}

/**
 * Watches the git state that should refresh the tree: `HEAD` and `index` in this worktree's own git
 * dir, and `refs/**` + `packed-refs` in the repository's common dir. These are resolved with
 * `git rev-parse --absolute-git-dir --git-common-dir` rather than assumed to be `<root>/.git/...`,
 * because in a linked worktree or a submodule `.git` is a *file* pointing elsewhere — a
 * `.git/{HEAD,index,refs/**}` pattern would silently never fire there. (`RelativePattern`s outside
 * the workspace are supported for `createFileSystemWatcher` from VS Code 1.84.)
 *
 * One per known repo — `GitRefWatchers` keeps the set in step with `RepositoryManager`.
 */
async function createGitRefWatcher(root: string, onChange: () => void): Promise<vscode.Disposable> {
  let gitDir: string;
  let commonDir: string;
  try {
    ({ gitDir, commonDir } = await gitService.getGitDirs(root));
  } catch {
    gitDir = commonDir = path.join(root, '.git'); // best effort — the old assumption
  }
  const patterns =
    gitDir === commonDir
      ? [new vscode.RelativePattern(vscode.Uri.file(gitDir), '{HEAD,index,packed-refs,refs/**}')]
      : [
          new vscode.RelativePattern(vscode.Uri.file(gitDir), '{HEAD,index}'),
          new vscode.RelativePattern(vscode.Uri.file(commonDir), '{packed-refs,refs/**}'),
        ];
  const disposables: vscode.Disposable[] = [];
  for (const pattern of patterns) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    disposables.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange), watcher.onDidDelete(onChange));
  }
  return vscode.Disposable.from(...disposables);
}

/** A git ref watcher per known repo, recreated for exactly the repos that were added/removed. */
class GitRefWatchers implements vscode.Disposable {
  private readonly watchers = new Map<string, vscode.Disposable>();

  constructor(private readonly onChange: () => void) {}

  /** Makes the watched set equal `roots` (e.g. after discovery, or `git.path` changed → `recreate`). */
  async sync(roots: readonly string[], recreate = false): Promise<void> {
    for (const [root, watcher] of this.watchers) {
      if (recreate || !roots.includes(root)) {
        watcher.dispose();
        this.watchers.delete(root);
      }
    }
    await Promise.all(
      roots
        .filter((root) => !this.watchers.has(root))
        .map(async (root) => {
          const watcher = await createGitRefWatcher(root, this.onChange);
          if (this.watchers.has(root)) {
            watcher.dispose(); // a concurrent sync got there first
          } else {
            this.watchers.set(root, watcher);
          }
        }),
    );
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
  }
}

function describeMergeBaseFallback(ref: string, reason: MergeBaseFallbackReason): string {
  return reason === 'noCommits'
    ? `the current branch has no commits yet, so there's no merge-base with '${ref}' — comparing against the tip of '${ref}' instead.`
    : `HEAD and '${ref}' have no common ancestor (unrelated histories, or a shallow clone) — comparing against the tip of '${ref}' instead.`;
}

async function pathExists(fsPath: string): Promise<boolean> {
  try {
    await fs.promises.access(fsPath);
    return true;
  } catch {
    return false;
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let blameAnnotationTimer: ReturnType<typeof setTimeout> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<ChevronApi> {
  applyGitPathSetting();

  // One warning per ref per session (not per refresh — the cache is rebuilt on every git change).
  const warnedFallbackRefs = new Set<string>();
  gitService.setMergeBaseFallbackListener((ref, reason) => {
    if (!warnedFallbackRefs.has(ref)) {
      warnedFallbackRefs.add(ref);
      reportWarningOnce(`fallback:${ref}`, describeMergeBaseFallback(ref, reason));
    }
  });

  const repositories = new RepositoryManager(gitService, context.workspaceState);
  const comparisonState = new ComparisonState(context.workspaceState, () => repositories.activeRepository);
  const treeProvider = new ChangedFilesTreeProvider(gitService, comparisonState, repositories);
  const treeView = vscode.window.createTreeView('chevron.changedFilesView', { treeDataProvider: treeProvider });
  treeProvider.attachTreeView(treeView);

  // Only ever run git in a repo that's actually open — a `chevron-ref:` URI names its repo.
  const branchContentProvider = new BranchContentProvider(gitService, (uri) =>
    repositories.knownRepo(parseBranchRefUri(uri).repoRoot),
  );

  const blameSource = new BlameSource(gitService, comparisonState, repositories);
  const changedLinesSource = new ChangedLinesSource(gitService, comparisonState, repositories);
  const blameAnnotations = new BlameAnnotationController(blameSource, changedLinesSource);

  /** The view header for the active repo's current target (before `getChildren` adds ahead/behind). */
  function syncTreeDescription(): void {
    const active = repositories.activeRepository;
    const target = active === undefined ? undefined : comparisonState.getTarget(active);
    treeProvider.setHeader(treeProvider.describe(active, target ? comparisonTargetLabel(target) : undefined));
  }

  /**
   * Clears a stored comparison target that no longer resolves — a branch deleted since it was
   * selected, or a worktree directory that's gone — and brings back the welcome view. Returns
   * whether the target (if any) is still usable. A failure to *check* (e.g. git missing) leaves the
   * target alone.
   */
  async function revalidateTarget(repoRoot: string): Promise<boolean> {
    const target = comparisonState.getTarget(repoRoot);
    if (!target) {
      return true;
    }
    let valid: boolean;
    try {
      valid =
        target.kind === 'branch'
          ? (await gitService.resolveCommit(target.name, repoRoot)) !== undefined
          : await pathExists(target.path);
    } catch {
      return true;
    }
    if (!valid) {
      const label = comparisonTargetLabel(target);
      const where = repositories.hasMultiple ? ` in ${repositories.displayName(repoRoot)}` : '';
      await comparisonState.clearTarget(repoRoot);
      void vscode.window.showInformationMessage(
        target.kind === 'branch'
          ? `Chevron: '${label}'${where} no longer exists, so the comparison was cleared. Select another branch to compare against.`
          : `Chevron: the worktree for '${label}'${where} no longer exists, so the comparison was cleared.`,
      );
    }
    return valid;
  }

  async function revalidateAllTargets(): Promise<void> {
    await Promise.all(repositories.repositories.map((root) => revalidateTarget(root)));
  }

  /**
   * `chevron.defaultComparisonBranch` / `chevron.autoSelectComparisonBranch`: gives a repo with no
   * stored target one automatically (see `defaultComparisonCandidates` for the order). Runs when a
   * repo is first discovered and when either setting changes — *not* after a target is cleared
   * because its branch was deleted (the user should see that, not have it silently replaced).
   */
  async function autoSelectTarget(repoRoot: string): Promise<void> {
    if (!settings.autoSelectComparisonBranch() || comparisonState.getTarget(repoRoot)) {
      return;
    }
    try {
      const [originHead, currentBranch] = await Promise.all([
        gitService.getOriginHead(repoRoot),
        gitService.getCurrentBranch(repoRoot),
      ]);
      const candidates = defaultComparisonCandidates({
        configured: settings.defaultComparisonBranch(repoRoot),
        originHead,
        currentBranch,
      });
      for (const ref of candidates) {
        if ((await gitService.resolveCommit(ref, repoRoot)) !== undefined) {
          // The user may have picked something while git ran — theirs wins.
          if (!comparisonState.getTarget(repoRoot)) {
            await comparisonState.setTarget(repoRoot, { kind: 'branch', name: ref }, { automatic: true });
          }
          return;
        }
      }
    } catch {
      // Auto-selection is a convenience — a git failure here is reported by whatever runs next.
    }
  }

  async function refreshNow(): Promise<void> {
    gitService.invalidateCache();
    await revalidateAllTargets();
    treeProvider.refresh();
    // Open branch panes show the merge-base as it was when they opened — re-read them against the
    // current one. Their text changing re-computes the take lenses (TakeFromBranchController).
    branchContentProvider.refreshOpenDocuments();
  }

  function scheduleRefresh(): void {
    // Invalidate straight away (not just when the debounce fires) so nothing in the next 300ms
    // reads a merge-base computed against the old HEAD/refs.
    gitService.invalidateCache();
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      void refreshNow();
      // Blame/changed-lines can go stale here even though no open document's version changed
      // (e.g. committing flips a line from "Not committed yet" to a real commit without touching
      // the buffer) — drop the caches and recompute for whatever's currently visible.
      blameSource.clear();
      changedLinesSource.clear();
      for (const editor of vscode.window.visibleTextEditors) {
        void blameAnnotations.refresh(editor);
      }
    }, 300);
  }

  // Debounced separately from `scheduleRefresh` (different target, different trigger frequency —
  // this one also fires on every keystroke via `onDidChangeTextDocument`, not just saves/git-ref
  // changes) so a burst of edits doesn't re-run `git blame` on the whole file per keystroke.
  function scheduleBlameAnnotationRefresh(editor: vscode.TextEditor | undefined): void {
    if (blameAnnotationTimer) {
      clearTimeout(blameAnnotationTimer);
    }
    blameAnnotationTimer = setTimeout(() => void blameAnnotations.refresh(editor), 300);
  }

  const gitRefWatchers = new GitRefWatchers(scheduleRefresh);

  context.subscriptions.push(
    repositories,
    comparisonState,
    treeProvider,
    gitRefWatchers,
    repositories.onDidChangeActiveRepository(async () => {
      await comparisonState.updateContextKey();
      syncTreeDescription();
    }),
  );

  /**
   * (Re)discovers repos and keeps everything per-repo in step: migrates a pre-multi-repo target,
   * watches exactly the known repos, revalidates stored targets, and auto-selects a default target
   * for repos seen for the first time this session. Awaited on activation so a default target
   * exists by the time `activate` resolves — otherwise it could land after, and overwrite, the
   * user's first pick.
   */
  async function rediscover(recreateWatchers = false): Promise<void> {
    const before = [...repositories.repositories];
    await repositories.discover();
    const roots = repositories.repositories;
    await comparisonState.migrateLegacyTarget(roots[0]);
    await gitRefWatchers.sync(roots, recreateWatchers);
    await revalidateAllTargets();
    await Promise.all(roots.filter((root) => !before.includes(root)).map((root) => autoSelectTarget(root)));
    await comparisonState.updateContextKey();
    syncTreeDescription();
  }

  await rediscover();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await rediscover();
      treeProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('git.path')) {
        applyGitPathSetting();
        await rediscover(true);
        await refreshNow();
      }
      if (
        event.affectsConfiguration('chevron.defaultComparisonBranch') ||
        event.affectsConfiguration('chevron.autoSelectComparisonBranch')
      ) {
        await Promise.all(repositories.repositories.map((root) => autoSelectTarget(root)));
      }
      if (event.affectsConfiguration('chevron.showUntrackedFiles') || event.affectsConfiguration('chevron.treeLayout')) {
        treeProvider.refresh();
      }
      if (event.affectsConfiguration('chevron.blame.annotationsEnabledByDefault')) {
        await blameAnnotations.applyDefaultSetting();
      }
      if (event.affectsConfiguration('chevron.blame.dateFormat')) {
        await blameAnnotations.refreshAll();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh()),
    comparisonState.onDidClearComparisonTarget(({ repoRoot }) => {
      if (repoRoot === repositories.activeRepository) {
        syncTreeDescription();
      }
    }),
  );

  /** The branch picker, with git failures (e.g. git missing) reported as a toast instead of an unhandled rejection. */
  async function pickComparisonTarget(root: string): Promise<ComparisonTarget | undefined> {
    try {
      const repoName = repositories.hasMultiple ? repositories.displayName(root) : undefined;
      return await showBranchQuickPick(gitService, root, comparisonState.getTarget(root), repoName);
    } catch (error) {
      reportError(error);
      return undefined;
    }
  }

  async function ensureComparisonTarget(repoRoot: string): Promise<ComparisonTarget | undefined> {
    const existing = comparisonState.getTarget(repoRoot);
    if (existing) {
      return existing;
    }
    const target = await pickComparisonTarget(repoRoot);
    if (target) {
      await comparisonState.setTarget(repoRoot, target);
    }
    return target;
  }

  /** For `diffCurrentFile`: a renamed file's path at the merge-base, when the target is a branch. */
  async function previousPathOf(localUri: vscode.Uri, repoRoot: string, target: ComparisonTarget): Promise<string | undefined> {
    const relativePath = relativePathInside(repoRoot, localUri.fsPath);
    if (target.kind !== 'branch' || relativePath === undefined) {
      return undefined;
    }
    // A failure here is reported by the diff itself — just open it at the same path.
    return gitService.getPreviousPath(target.name, relativePath, repoRoot).catch(() => undefined);
  }

  /** Dispatches to the branch-vs-ref diff or the live worktree-vs-worktree diff, per the comparison target's kind. */
  async function openDiffForTarget(
    localUri: vscode.Uri,
    repoRoot: string,
    target: ComparisonTarget,
    previousPath?: string,
  ): Promise<void> {
    if (target.kind === 'branch') {
      await openFileDiff(localUri, repoRoot, target.name, previousPath);
    } else {
      // No rename detection for a worktree target — each path is compared with the same path there.
      await openWorktreeFileDiff(localUri, repoRoot, target.path, target.label);
    }
  }

  context.subscriptions.push(
    treeView,

    branchContentProvider,
    vscode.workspace.registerTextDocumentContentProvider(CHEVRON_SCHEME, branchContentProvider),

    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, new EmptyContentProvider()),

    vscode.languages.registerHoverProvider(
      [{ scheme: 'file' }, { scheme: CHEVRON_SCHEME }],
      new BlameHoverProvider(blameSource),
    ),

    blameAnnotations,

    vscode.commands.registerCommand('chevron.toggleBlameAnnotations', async () => {
      await blameAnnotations.toggle();
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void repositories.followEditor(editor);
      void blameAnnotations.refresh(editor);
    }),

    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        void blameAnnotations.refresh(editor);
      }
    }),

    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === event.document);
      scheduleBlameAnnotationRefresh(editor);
    }),

    comparisonState.onDidChangeComparisonTarget(async ({ repoRoot, automatic }) => {
      if (repoRoot === repositories.activeRepository) {
        syncTreeDescription();
        // Selecting (or implicitly picking) a comparison target is the moment the user most wants
        // to see the changed-files tree — reveal it rather than leaving them to go find it. Not for
        // an automatic default, which happens on startup.
        if (!automatic) {
          await vscode.commands.executeCommand('chevron.changedFilesView.focus');
        }
      }
      // Blame annotations are restricted to lines changed against the comparison target, so
      // switching targets changes which lines qualify even though the documents themselves haven't.
      for (const editor of vscode.window.visibleTextEditors) {
        void blameAnnotations.refresh(editor);
      }
    }),

    vscode.commands.registerCommand('chevron.selectCompareBranch', async () => {
      const repoRoot = repositories.activeRepository;
      if (!repoRoot) {
        vscode.window.showErrorMessage(NO_REPO_MESSAGE);
        return;
      }
      const target = await pickComparisonTarget(repoRoot);
      if (target) {
        await comparisonState.setTarget(repoRoot, target);
      }
    }),

    vscode.commands.registerCommand('chevron.selectRepository', async () => {
      await repositories.pickRepository();
    }),

    vscode.commands.registerCommand('chevron.diffCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Chevron: no active file to compare.');
        return;
      }
      const repoRoot = repositories.repoForUri(editor.document.uri);
      if (!repoRoot) {
        vscode.window.showErrorMessage(
          repositories.repositories.length === 0 ? NO_REPO_MESSAGE : 'Chevron: this file is not in an open git repository.',
        );
        return;
      }
      const target = await ensureComparisonTarget(repoRoot);
      if (!target) {
        return;
      }
      await openDiffForTarget(editor.document.uri, repoRoot, target, await previousPathOf(editor.document.uri, repoRoot, target));
    }),

    /**
     * From a tree item (`[path, repoRoot, previousPath]`) or change navigation; without `repoRoot`,
     * the active repo. `previousPath` is a rename's path at the merge-base (see `openFileDiff`).
     */
    vscode.commands.registerCommand(
      'chevron.openFileDiff',
      async (relativePath: string, repoRootArg?: string, previousPath?: string) => {
        const repoRoot = repositories.knownRepo(repoRootArg) ?? repositories.activeRepository;
        const target = repoRoot === undefined ? undefined : comparisonState.getTarget(repoRoot);
        if (!repoRoot || !target) {
          return;
        }
        const localUri = vscode.Uri.joinPath(vscode.Uri.file(repoRoot), relativePath);
        await openDiffForTarget(localUri, repoRoot, target, typeof previousPath === 'string' ? previousPath : undefined);
      },
    ),

    vscode.commands.registerCommand('chevron.showChangedFilesTree', async () => {
      const repoRoot = repositories.activeRepository;
      if (!repoRoot) {
        vscode.window.showErrorMessage(NO_REPO_MESSAGE);
        return;
      }
      await ensureComparisonTarget(repoRoot);
      await vscode.commands.executeCommand('chevron.changedFilesView.focus');
    }),

    vscode.commands.registerCommand('chevron.refreshChangedFiles', async () => {
      await refreshNow();
    }),

    vscode.commands.registerCommand('chevron.viewAsList', () => setTreeLayout('list')),
    vscode.commands.registerCommand('chevron.viewAsTree', () => setTreeLayout('tree')),

    vscode.commands.registerCommand('chevron.copyRelativePath', async (node?: TreeNode) => {
      if (node?.kind !== 'file') {
        return;
      }
      await vscode.env.clipboard.writeText(node.path);
    }),

    vscode.commands.registerCommand('chevron.revealInExplorer', async (node?: TreeNode) => {
      // Tree items always belong to the active repo — it's the one the view shows.
      const repoRoot = repositories.activeRepository;
      if (node?.kind !== 'file' || !repoRoot) {
        return;
      }
      const uri = vscode.Uri.file(path.join(repoRoot, node.path));
      await vscode.commands.executeCommand('revealInExplorer', uri);
    }),
  );

  // `← Take from <branch>` (per-hunk apply) and next/previous change navigation — see
  // takeFromBranch.ts and changeNavigationCommands.ts. Lenses refresh whenever the tree does
  // (comparison target changed, git state changed, file saved), without touching scheduleRefresh.
  const hunkSource = new HunkSource(gitService, comparisonState, repositories);
  const takeFromBranch = new TakeFromBranchController(hunkSource, context.globalState);
  context.subscriptions.push(
    takeFromBranch,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, takeFromBranch),
    vscode.commands.registerCommand(TAKE_HUNK_COMMAND, (uri?: unknown, hunk?: LineHunk) =>
      takeFromBranch.take(uri instanceof vscode.Uri ? uri : undefined, hunk),
    ),
    treeProvider.onDidChangeTreeData(() => takeFromBranch.refresh()),
    // A non-active repo's target changing doesn't refresh the tree, but can change its files' lenses.
    comparisonState.onDidChangeComparisonTarget(() => takeFromBranch.refresh()),
    comparisonState.onDidClearComparisonTarget(() => takeFromBranch.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('chevron.takeFromBranch.enabled')) {
        takeFromBranch.refresh();
      }
    }),
    registerChangeNavigationCommands({ gitService, comparisonState, hunkSource, repositories }),
  );

  // Follow whatever editor is active at startup (discovery already preferred its repo).
  void repositories.followEditor(vscode.window.activeTextEditor);

  return { comparisonState, treeView, treeProvider, repositories };
}

export function deactivate(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  if (blameAnnotationTimer) {
    clearTimeout(blameAnnotationTimer);
  }
}
