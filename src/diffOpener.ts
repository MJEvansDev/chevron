import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { branchRefUri } from './branchContentProvider';
import { emptyContentUri } from './emptyContentProvider';
import { comparisonTargetLabel } from './types';

/**
 * Opens the branch-vs-working-tree diff for `localUri`. For a file renamed since the merge-base,
 * `previousPath` is its path there: the branch pane reads that path, so the diff shows the actual
 * changes (and `← Take from` works) instead of an all-new file.
 */
export async function openFileDiff(
  localUri: vscode.Uri,
  repoRoot: string,
  branch: string,
  previousPath?: string,
): Promise<void> {
  const relativePath = path.relative(repoRoot, localUri.fsPath).split(path.sep).join('/');
  const oldPath = previousPath ?? relativePath;
  const remoteUri = branchRefUri(repoRoot, branch, oldPath);
  // `comparisonTargetLabel`, not the raw ref: a pasted full SHA reads as its 7-character short form.
  const shownPath = oldPath === relativePath ? relativePath : `${oldPath} → ${relativePath}`;
  const title = `${shownPath} (${comparisonTargetLabel({ kind: 'branch', name: branch })} ↔ Working Tree)`;

  await vscode.commands.executeCommand('vscode.diff', remoteUri, localUri, title);
}

/**
 * Opens a live filesystem-to-filesystem diff against another worktree's copy of the same file:
 * a real `file://` URI read straight from the
 * other worktree's directory (so its own uncommitted edits show up), not a `git show` snapshot
 * the way `openFileDiff`'s branch-side pane is. Falls back to an empty virtual document when the
 * file doesn't exist there (e.g. it's newly added on this side) — `vscode.diff` can't open a
 * `file://` URI that doesn't exist on disk.
 */
export async function openWorktreeFileDiff(
  localUri: vscode.Uri,
  repoRoot: string,
  worktreePath: string,
  worktreeLabel: string,
): Promise<void> {
  const relativePath = path.relative(repoRoot, localUri.fsPath).split(path.sep).join('/');
  const otherFsPath = path.join(worktreePath, relativePath);
  const otherUri = (await pathExists(otherFsPath)) ? vscode.Uri.file(otherFsPath) : emptyContentUri(repoRoot, relativePath);
  const title = `${relativePath} (${worktreeLabel} ↔ Working Tree)`;

  await vscode.commands.executeCommand('vscode.diff', otherUri, localUri, title);
}

async function pathExists(fsPath: string): Promise<boolean> {
  try {
    await fs.access(fsPath);
    return true;
  } catch {
    return false;
  }
}
