import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { PathNotAtRefError, type GitService } from './gitService';
import { isSamePath, relativePathInside } from './pathUtils';
import type { ComparisonState } from './comparisonState';
import type { RepositoryManager } from './repositoryManager';
import { CHEVRON_SCHEME, parseBranchRefUri } from './branchContentProvider';
import { EMPTY_SCHEME, parseEmptyContentUriRepo } from './emptyContentProvider';
import { diffLines, type LineHunk } from './lineDiff';
import { isUntakeableOldText, looksBinary, stripBom } from './hunkApply';
import { comparisonTargetLabel } from './types';

/** The "other side" of a Chevron diff editor tab whose working-tree side is a given document. */
interface ChevronDiffOriginal {
  uri: vscode.Uri;
  /** Branch name or worktree label, for `← Take from <label>`. */
  label: string;
  /** The other side is Chevron's empty placeholder: the file doesn't exist there at all. */
  missing: boolean;
}

/** What `← Take from <label>` takes from: the text shown in the diff editor's other pane. */
export interface TakeSource {
  label: string;
  oldText: string;
  hunks: LineHunk[];
}

export function toRelativePath(repoRoot: string, fsPath: string): string | undefined {
  return relativePathInside(repoRoot, fsPath);
}

/**
 * Resolves the old side of Chevron's diffs for a working-tree document and computes line hunks
 * against the document's *current buffer* (unsaved edits included) with `lineDiff.ts` — shared by
 * `← Take from <branch>` (`takeFromBranch.ts`) and next/previous change navigation
 * (`changeNavigationCommands.ts`).
 *
 * Two flavours, deliberately different:
 * - `resolveTakeSource` only answers for a document that is the working-tree side of an open
 *   Chevron diff tab, and takes its old text from *that tab's other pane* — so what gets written
 *   into the file is exactly what the user is looking at on the left, whatever produced it (a
 *   `chevron-ref` snapshot of the merge-base, or another worktree's live file, dirty buffer
 *   included).
 * - `getNavigationHunks` answers for any working-tree file under the repo (navigation also has to
 *   compute hunks for files that aren't open yet, to roll over into them), preferring an open
 *   Chevron tab's pane and otherwise asking git / the other worktree directly.
 */
export class HunkSource {
  constructor(
    private readonly gitService: GitService,
    private readonly comparisonState: ComparisonState,
    private readonly repositories: RepositoryManager,
  ) {}

  /**
   * If `original` is the other side of a Chevron diff — for `repoRoot`'s comparison target, or for
   * any open repo's when `repoRoot` is omitted — describes it; else `undefined` (e.g. a built-in SCM
   * diff, or some other extension's).
   */
  describeChevronOriginal(original: vscode.Uri, repoRoot?: string): ChevronDiffOriginal | undefined {
    if (original.scheme === CHEVRON_SCHEME) {
      const { branch, repoRoot: paneRepo } = parseBranchRefUri(original);
      if (repoRoot !== undefined && (paneRepo === undefined || !isSamePath(paneRepo, repoRoot))) {
        return undefined; // a pane from a different repo's diff
      }
      return { uri: original, label: comparisonTargetLabel({ kind: 'branch', name: branch }), missing: false };
    }
    if (original.scheme === EMPTY_SCHEME) {
      const paneRepo = parseEmptyContentUriRepo(original);
      if (repoRoot !== undefined && (paneRepo === undefined || !isSamePath(paneRepo, repoRoot))) {
        return undefined;
      }
      return { uri: original, label: '', missing: true };
    }
    if (original.scheme === 'file') {
      const roots = repoRoot !== undefined ? [repoRoot] : this.repositories.repositories;
      for (const root of roots) {
        const target = this.comparisonState.getTarget(root);
        if (target?.kind === 'worktree' && relativePathInside(target.path, original.fsPath) !== undefined) {
          return { uri: original, label: target.label, missing: false };
        }
      }
    }
    return undefined;
  }

  /** The Chevron diff tab (if any) showing `uri` as its modified (working-tree) side. */
  findChevronDiffFor(uri: vscode.Uri): ChevronDiffOriginal | undefined {
    const key = uri.toString();
    const repoRoot = this.repositories.repoForUri(uri);
    if (repoRoot === undefined) {
      return undefined;
    }
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === key) {
          const original = this.describeChevronOriginal(input.original, repoRoot);
          if (original) {
            return original;
          }
        }
      }
    }
    return undefined;
  }

  /** Whether `uri` is the other (old) side of some open Chevron diff tab — its edits change the hunks too. */
  isChevronOriginal(uri: vscode.Uri): boolean {
    const key = uri.toString();
    return vscode.window.tabGroups.all.some((group) =>
      group.tabs.some(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.original.toString() === key &&
          this.describeChevronOriginal(tab.input.original) !== undefined,
      ),
    );
  }

  /** The repo a working-tree (`file://`) document belongs to, and its path in that repo. */
  private workingTreeLocation(document: vscode.TextDocument): { repoRoot: string; relativePath: string } | undefined {
    if (document.uri.scheme !== 'file') {
      return undefined;
    }
    const repoRoot = this.repositories.repoForUri(document.uri);
    const relativePath = repoRoot === undefined ? undefined : toRelativePath(repoRoot, document.uri.fsPath);
    return repoRoot === undefined || relativePath === undefined ? undefined : { repoRoot, relativePath };
  }

  /**
   * The old side to take hunks from, plus the hunks themselves, for a working-tree document open in
   * a Chevron diff — or `undefined` when taking isn't offered: no comparison target for the
   * document's repo, not a Chevron diff's working-tree side, the file doesn't exist on the other
   * side (added/untracked — "take" would mean "delete everything", which is not what a per-hunk
   * action should ever do), the other side is empty (indistinguishable from missing for a
   * `chevron-ref` pane), or either side is binary (including the branch pane's binary placeholder).
   */
  async resolveTakeSource(document: vscode.TextDocument): Promise<TakeSource | undefined> {
    const location = this.workingTreeLocation(document);
    if (!location || !this.comparisonState.getTarget(location.repoRoot)) {
      return undefined;
    }
    const original = this.findChevronDiffFor(document.uri);
    if (!original || original.missing) {
      return undefined;
    }
    let oldText: string;
    try {
      oldText = (await vscode.workspace.openTextDocument(original.uri)).getText();
    } catch {
      return undefined;
    }
    const newText = document.getText();
    if (oldText === '' || isUntakeableOldText(oldText) || looksBinary(newText)) {
      return undefined;
    }
    return { label: original.label, oldText, hunks: diffLines(oldText, newText) };
  }

  /**
   * Hunks of `document` against its repo's comparison target for change navigation, or `undefined`
   * if there's nothing to navigate (no target, not a working-tree file in an open repo, binary). A
   * file with no old side at all (untracked/added) comes back as one hunk covering the whole file.
   * `previousPath` is a rename's path at the merge-base, when the caller already knows it.
   */
  async getNavigationHunks(document: vscode.TextDocument, previousPath?: string): Promise<LineHunk[] | undefined> {
    const location = this.workingTreeLocation(document);
    const oldText = location === undefined ? undefined : await this.navigationOldText(document, location, previousPath);
    if (oldText === undefined) {
      return undefined;
    }
    const newText = document.getText();
    if (isUntakeableOldText(oldText) || looksBinary(newText)) {
      return undefined;
    }
    return diffLines(oldText, newText);
  }

  private async navigationOldText(
    document: vscode.TextDocument,
    { repoRoot, relativePath }: { repoRoot: string; relativePath: string },
    previousPath: string | undefined,
  ): Promise<string | undefined> {
    const target = this.comparisonState.getTarget(repoRoot);
    if (!target) {
      return undefined;
    }

    const original = this.findChevronDiffFor(document.uri);
    if (original) {
      if (original.missing) {
        return '';
      }
      try {
        return (await vscode.workspace.openTextDocument(original.uri)).getText();
      } catch {
        return '';
      }
    }

    if (target.kind === 'branch') {
      return stripBom(await this.branchOldText(target.name, relativePath, repoRoot, previousPath));
    }
    const otherFsPath = path.join(target.path, relativePath);
    const openOther = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.scheme === 'file' && isSamePath(candidate.uri.fsPath, otherFsPath),
    );
    if (openOther) {
      return openOther.getText();
    }
    // A document's text never has the BOM (VS Code strips it on load); the raw file can.
    return stripBom(await fs.readFile(otherFsPath, 'utf8').catch(() => ''));
  }

  /**
   * The file at the merge-base — at its old path if it was renamed since — or `''` when it didn't
   * exist there (added/untracked: no old side).
   */
  private async branchOldText(
    branch: string,
    relativePath: string,
    repoRoot: string,
    previousPath: string | undefined,
  ): Promise<string> {
    try {
      return await this.gitService.getFileContentAtRef(branch, previousPath ?? relativePath, repoRoot);
    } catch (err) {
      if (!(err instanceof PathNotAtRefError)) {
        throw err;
      }
    }
    if (previousPath !== undefined) {
      return '';
    }
    // Absent at its own path: renamed (if so, read the old path), or genuinely new.
    const renamedFrom = await this.gitService.getPreviousPath(branch, relativePath, repoRoot).catch(() => undefined);
    return renamedFrom === undefined ? '' : this.branchOldText(branch, relativePath, repoRoot, renamedFrom);
  }
}
