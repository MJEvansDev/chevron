import * as vscode from 'vscode';
import * as path from 'node:path';
import type { GitService } from './gitService';
import type { ComparisonState } from './comparisonState';
import { type HunkSource, toRelativePath } from './hunkSource';
import { CHEVRON_SCHEME } from './branchContentProvider';
import { EMPTY_SCHEME } from './emptyContentProvider';
import { buildChangedFilesLayout } from './treeBuilder';
import type { RepositoryManager } from './repositoryManager';
import { settings } from './settings';
import { hunkLineSpan } from './hunkApply';
import {
  findAdjacentHunkLine,
  orderedNavigableFiles,
  rolloverCandidates,
  type NavigationDirection,
} from './changeNavigation';
import { comparisonTargetLabel, type ComparisonTarget } from './types';

interface NavigationDeps {
  gitService: GitService;
  comparisonState: ComparisonState;
  hunkSource: HunkSource;
  repositories: RepositoryManager;
}

interface CurrentLocation {
  relativePath: string;
  /** The working-tree (`file://`) editor for that path, if one is visible. */
  editor?: vscode.TextEditor;
}

/**
 * `chevron.nextChange` / `chevron.previousChange` — IntelliJ's F7 / Shift+F7 across the whole
 * comparison: move to the next/previous changed hunk in the current file; past
 * the last (or before the first) one, roll over into the next (previous) file in the changed-files
 * tree's order, opening its Chevron diff at its first (last) hunk. Hunks are computed from the
 * live buffer by `HunkSource` — the same ones `← Take from <branch>` offers.
 *
 * Works from either pane of a Chevron diff: from the other (branch/worktree) pane it navigates the
 * working-tree pane's cursor, since line numbers only mean something on one side.
 */
export function registerChangeNavigationCommands(deps: NavigationDeps): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('chevron.nextChange', () => navigate(deps, 'next')),
    vscode.commands.registerCommand('chevron.previousChange', () => navigate(deps, 'previous')),
  );
}

/**
 * The repo to navigate in: the one the active editor's document belongs to (either pane of a
 * Chevron diff — the other pane of a worktree diff lives outside every open repo, so that's matched
 * through each repo's worktree target), else the active repo.
 */
function resolveNavigationRepo(deps: NavigationDeps): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri) {
    const own = deps.repositories.repoForUri(uri);
    if (own !== undefined) {
      return own;
    }
    if (uri.scheme === 'file') {
      for (const root of deps.repositories.repositories) {
        const target = deps.comparisonState.getTarget(root);
        if (target?.kind === 'worktree' && toRelativePath(target.path, uri.fsPath) !== undefined) {
          return root;
        }
      }
    }
  }
  return deps.repositories.activeRepository;
}

async function navigate(deps: NavigationDeps, direction: NavigationDirection): Promise<boolean> {
  const repoRoot = resolveNavigationRepo(deps);
  const target = repoRoot === undefined ? undefined : deps.comparisonState.getTarget(repoRoot);
  if (!repoRoot || !target) {
    void vscode.window.showInformationMessage('Chevron: select a branch to compare against first.');
    return false;
  }

  const current = resolveCurrentLocation(repoRoot, target);
  if (current?.editor) {
    const document = current.editor.document;
    const hunks = await deps.hunkSource.getNavigationHunks(document);
    if (hunks && hunks.length > 0) {
      const spans = hunks.map((hunk) => hunkLineSpan(hunk, document.lineCount));
      const line = findAdjacentHunkLine(spans, current.editor.selection.active.line, direction);
      if (line !== undefined) {
        moveCursor(current.editor, line);
        return true;
      }
    }
  }

  // Same files, in the same order, as the changed-files view shows them.
  const options = { includeUntracked: settings.showUntrackedFiles() };
  const files =
    target.kind === 'branch'
      ? await deps.gitService.getChangedFiles(target.name, repoRoot, options)
      : await deps.gitService.getChangedFilesBetweenWorktrees(target.path, repoRoot, options);
  const ordered = orderedNavigableFiles(buildChangedFilesLayout(files, settings.treeLayout()));
  // Renames: the old side lives at the path the file had at the merge-base.
  const previousPaths = new Map(files.flatMap((file) => (file.previousPath === undefined ? [] : [[file.path, file.previousPath]])));

  for (const relativePath of rolloverCandidates(ordered, current?.relativePath, direction)) {
    const uri = vscode.Uri.file(path.join(repoRoot, relativePath));
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      continue; // e.g. binary, or vanished since the file list was computed
    }
    const previousPath = previousPaths.get(relativePath);
    const hunks = await deps.hunkSource.getNavigationHunks(document, previousPath);
    if (!hunks || hunks.length === 0) {
      continue; // e.g. a mode-only change, or only an EOL-style difference
    }
    await vscode.commands.executeCommand('chevron.openFileDiff', relativePath, repoRoot, previousPath);
    const editor = (await waitForWorkingTreeEditor(uri)) ?? (await vscode.window.showTextDocument(document));
    const spans = hunks.map((hunk) => hunkLineSpan(hunk, document.lineCount));
    moveCursor(editor, direction === 'next' ? spans[0].start : spans[spans.length - 1].start);
    return true;
  }

  vscode.window.setStatusBarMessage(
    `Chevron: no ${direction === 'next' ? 'more' : 'earlier'} changes against ${comparisonTargetLabel(target)}.`,
    4000,
  );
  return false;
}

/** Which changed file the user is "in", from the active editor — either pane of a Chevron diff. */
function resolveCurrentLocation(repoRoot: string, target: ComparisonTarget): CurrentLocation | undefined {
  const active = vscode.window.activeTextEditor;
  if (!active) {
    return undefined;
  }
  const uri = active.document.uri;

  let relativePath: string | undefined;
  if (uri.scheme === 'file') {
    relativePath = toRelativePath(repoRoot, uri.fsPath);
    if (relativePath !== undefined) {
      return { relativePath, editor: active };
    }
    if (target.kind === 'worktree') {
      relativePath = toRelativePath(target.path, uri.fsPath);
    }
  } else if (uri.scheme === CHEVRON_SCHEME || uri.scheme === EMPTY_SCHEME) {
    // The pane's own path is the file's path at the merge-base — for a rename, not the working
    // tree's. The diff tab it's the original side of names the working-tree file.
    const modified = workingTreeSideOf(uri);
    relativePath = modified ? toRelativePath(repoRoot, modified.fsPath) : uri.path.replace(/^\//, '');
  }
  if (relativePath === undefined) {
    return undefined;
  }
  return { relativePath, editor: findWorkingTreeEditor(vscode.Uri.file(path.join(repoRoot, relativePath))) };
}

/** The `file://` modified side of an open diff tab whose original side is `original`. */
function workingTreeSideOf(original: vscode.Uri): vscode.Uri | undefined {
  const key = original.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff && input.original.toString() === key && input.modified.scheme === 'file') {
        return input.modified;
      }
    }
  }
  return undefined;
}

function findWorkingTreeEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
  const key = uri.toString();
  const active = vscode.window.activeTextEditor;
  if (active?.document.uri.toString() === key) {
    return active;
  }
  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === key);
}

/**
 * The editor for `uri` once the just-opened diff's panes have been reported to the extension host
 * (editor-state sync can trail `vscode.diff`'s own completion slightly), for up to ~1s.
 */
async function waitForWorkingTreeEditor(uri: vscode.Uri): Promise<vscode.TextEditor | undefined> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const editor = findWorkingTreeEditor(uri);
    if (editor) {
      return editor;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

function moveCursor(editor: vscode.TextEditor, line: number): void {
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}
