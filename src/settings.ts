import * as vscode from 'vscode';
import type { BlameDateFormat } from './blameFormat';
import type { TreeLayout } from './treeBuilder';

/**
 * `contributes.configuration`. Every setting is read at the point of use (never
 * cached), so a change applies on the next read; `extension.ts` listens to
 * `onDidChangeConfiguration` for the ones that need something redrawn.
 */
function config(scope?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('chevron', scope);
}

export const settings = {
  /** Resource-scoped: pass the repo root so a multi-root workspace can set it per folder. */
  defaultComparisonBranch: (repoRoot?: string): string =>
    config(repoRoot === undefined ? undefined : vscode.Uri.file(repoRoot)).get<string>('defaultComparisonBranch', '') ?? '',
  autoSelectComparisonBranch: (): boolean => config().get<boolean>('autoSelectComparisonBranch', true) ?? true,
  blameAnnotationsEnabledByDefault: (): boolean => config().get<boolean>('blame.annotationsEnabledByDefault', false) ?? false,
  blameDateFormat: (): BlameDateFormat =>
    config().get<string>('blame.dateFormat', 'relative') === 'absolute' ? 'absolute' : 'relative',
  showUntrackedFiles: (): boolean => config().get<boolean>('showUntrackedFiles', true) ?? true,
  treeLayout: (): TreeLayout => (config().get<string>('treeLayout', 'tree') === 'list' ? 'list' : 'tree'),
  takeFromBranchEnabled: (): boolean => config().get<boolean>('takeFromBranch.enabled', true) ?? true,
};

/**
 * Sets `chevron.treeLayout` (the view-title list/tree toggle) where the effective value comes
 * from: the workspace if it overrides the setting there, otherwise user settings.
 */
export async function setTreeLayout(layout: TreeLayout): Promise<void> {
  const inspected = config().inspect<string>('treeLayout');
  const target =
    inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config().update('treeLayout', layout, target);
}
