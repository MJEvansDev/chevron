import * as vscode from 'vscode';
import type { GitService } from './gitService';
import { enterRefRow, orderAndLabelBranches, validateRefSyntax, type BranchPickerRow } from './branchOrdering';
import type { ComparisonTarget } from './types';

type PickItem = vscode.QuickPickItem & { target?: ComparisonTarget; enterRef?: true };

function toQuickPickItem(row: BranchPickerRow): PickItem {
  switch (row.kind) {
    case 'separator':
      return { label: row.label, kind: vscode.QuickPickItemKind.Separator };
    case 'enterRef':
      // `alwaysShow` so it survives the QuickPick's filtering while the user types a SHA into it.
      return { enterRef: true, label: row.label, description: row.description, alwaysShow: true };
    case 'worktree':
      return { target: row.target, label: row.label, description: row.description, iconPath: new vscode.ThemeIcon('repo') };
    case 'tag':
      return { target: row.target, label: row.label, description: row.description, iconPath: new vscode.ThemeIcon('tag') };
    case 'branch':
      return {
        target: row.target,
        label: row.label,
        description: row.description,
        iconPath: new vscode.ThemeIcon(row.remote ? 'cloud' : 'git-branch'),
      };
  }
}

export async function showBranchQuickPick(
  gitService: GitService,
  repoRoot: string,
  currentTarget?: ComparisonTarget,
  /** Shown in the title when several repos are open, so it's clear which one this picks for. */
  repoName?: string,
): Promise<ComparisonTarget | undefined> {
  const [branches, current, worktrees, tags] = await Promise.all([
    gitService.listBranches(repoRoot),
    gitService.getCurrentBranch(repoRoot),
    // Optional sections — a failure listing these shouldn't stop the user picking a branch.
    gitService.listWorktrees(repoRoot).catch(() => []),
    gitService.listTags(repoRoot).catch(() => []),
  ]);

  const rows = orderAndLabelBranches(branches, current, currentTarget, worktrees, tags);
  const items = [enterRefRow(rows, currentTarget), ...rows].map(toQuickPickItem);

  const selected = await vscode.window.showQuickPick(items, {
    title: repoName ? `Chevron: Select branch to compare ${repoName} against` : 'Chevron: Select branch to compare against',
    placeHolder: 'Choose a branch, tag or worktree — or enter any ref',
  });

  if (selected?.enterRef) {
    return promptForRef(gitService, repoRoot, currentTarget);
  }
  return selected?.target;
}

/**
 * Free-form ref entry: anything `git rev-parse --verify <ref>^{commit}` accepts (a tag, a full or
 * abbreviated SHA, `HEAD~3`, `origin/main@{yesterday}`, …). Stored as a `{ kind: 'branch' }`
 * target — every git operation on a branch target already takes any commit-ish.
 */
async function promptForRef(
  gitService: GitService,
  repoRoot: string,
  currentTarget: ComparisonTarget | undefined,
): Promise<ComparisonTarget | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'Chevron: Compare against a ref',
    prompt: 'A tag, commit SHA, or any ref git understands (e.g. v1.2.0, 3f2a9c1, HEAD~3)',
    value: currentTarget?.kind === 'branch' ? currentTarget.name : undefined,
    validateInput: async (input) => {
      const syntaxError = validateRefSyntax(input);
      if (syntaxError) {
        return syntaxError;
      }
      const sha = await gitService.resolveCommit(input.trim(), repoRoot).catch(() => undefined);
      return sha ? undefined : `'${input.trim()}' doesn't name a commit in this repository.`;
    },
  });
  if (value === undefined) {
    return undefined;
  }
  const ref = value.trim();
  // `validateInput` doesn't gate programmatic/accepted values in every VS Code version — check again.
  if (validateRefSyntax(ref) || !(await gitService.resolveCommit(ref, repoRoot).catch(() => undefined))) {
    void vscode.window.showErrorMessage(`Chevron: '${ref}' doesn't name a commit in this repository.`);
    return undefined;
  }
  return { kind: 'branch', name: ref };
}
