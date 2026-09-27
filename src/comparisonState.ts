import * as vscode from 'vscode';
import { comparisonTargetLabel, type ComparisonTarget } from './types';
import { repoStateKey } from './repositories';
import { looksLikeOption } from './gitService';

function isUnsafeTarget(target: ComparisonTarget): boolean {
  return target.kind === 'branch' && looksLikeOption(target.name);
}

/** Pre-multi-repo storage: one target for the whole workspace. Migrated to the first repo on discovery. */
const LEGACY_STORAGE_KEY = 'chevron.comparisonTarget';
const STORAGE_KEY_PREFIX = 'chevron.comparisonTarget:';
const CONTEXT_KEY = 'chevron.hasComparisonBranch';

export interface ComparisonTargetChange {
  repoRoot: string;
  target: ComparisonTarget;
  /** Chosen by auto-selection (`chevron.defaultComparisonBranch`) rather than by the user — don't reveal the view for it. */
  automatic: boolean;
}

/**
 * What each repo's working tree is being compared against — one `ComparisonTarget` per repo root,
 * in `workspaceState` under `chevron.comparisonTarget:<repo root>` (see `repoStateKey`).
 * Document-scoped features look up the target for the document's own repo (`getTarget(root)`);
 * the changed-files tree and repo-less commands use the active repo's (`target`).
 *
 * The `chevron.hasComparisonBranch` context key (welcome view, navigation keybindings) tracks the
 * *active* repo — `extension.ts` calls `updateContextKey()` when the active repo changes.
 */
export class ComparisonState {
  private readonly emitter = new vscode.EventEmitter<ComparisonTargetChange>();
  readonly onDidChangeComparisonTarget = this.emitter.event;
  private readonly clearEmitter = new vscode.EventEmitter<{ repoRoot: string }>();
  /** Fires when a repo's target is cleared (e.g. the stored branch was deleted) — separate from `onDidChangeComparisonTarget`, whose listeners can rely on a defined target. */
  readonly onDidClearComparisonTarget = this.clearEmitter.event;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly getActiveRepo: () => string | undefined,
  ) {}

  /** The active repo's target (what the changed-files tree shows). */
  get target(): ComparisonTarget | undefined {
    const active = this.getActiveRepo();
    return active === undefined ? undefined : this.getTarget(active);
  }

  getTarget(repoRoot: string): ComparisonTarget | undefined {
    const target = this.workspaceState.get<ComparisonTarget>(STORAGE_KEY_PREFIX + repoStateKey(repoRoot));
    // A stored ref that git would read as an option is never used, whatever put it there.
    return target && isUnsafeTarget(target) ? undefined : target;
  }

  /**
   * Stores `repoRoot`'s target. A branch target whose name starts with `-` is refused (with an
   * error message) — git would parse it as an option (see `looksLikeOption`).
   */
  async setTarget(repoRoot: string, target: ComparisonTarget, options: { automatic?: boolean } = {}): Promise<void> {
    if (isUnsafeTarget(target)) {
      void vscode.window.showErrorMessage(`Chevron: '${comparisonTargetLabel(target)}' can't be compared against — a ref name can't start with "-".`);
      return;
    }
    await this.workspaceState.update(STORAGE_KEY_PREFIX + repoStateKey(repoRoot), target);
    await this.updateContextKey();
    this.emitter.fire({ repoRoot, target, automatic: options.automatic ?? false });
  }

  /** Forgets a repo's target, bringing back the "No comparison branch selected" welcome view if it's the active repo. */
  async clearTarget(repoRoot: string): Promise<void> {
    await this.workspaceState.update(STORAGE_KEY_PREFIX + repoStateKey(repoRoot), undefined);
    await this.updateContextKey();
    this.clearEmitter.fire({ repoRoot });
  }

  /**
   * Moves a target stored by a pre-multi-repo version (one key for the whole workspace) to
   * `firstRepo` — that version only ever looked at the first workspace folder's repo — unless that
   * repo already has one of its own. No-op once migrated.
   */
  async migrateLegacyTarget(firstRepo: string | undefined): Promise<void> {
    const legacy = this.workspaceState.get<ComparisonTarget>(LEGACY_STORAGE_KEY);
    if (!legacy || firstRepo === undefined) {
      return;
    }
    if (!this.getTarget(firstRepo)) {
      await this.workspaceState.update(STORAGE_KEY_PREFIX + repoStateKey(firstRepo), legacy);
    }
    await this.workspaceState.update(LEGACY_STORAGE_KEY, undefined);
  }

  async updateContextKey(): Promise<void> {
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, this.target !== undefined);
  }

  dispose(): void {
    this.emitter.dispose();
    this.clearEmitter.dispose();
  }
}
