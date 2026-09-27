import * as vscode from 'vscode';
import type { HunkSource } from './hunkSource';
import { diffLines, type LineHunk } from './lineDiff';
import { computeHunkEdit, findMatchingHunk, hunkAnchorLine, hunkAtLine } from './hunkApply';
import { settings } from './settings';
import { CHEVRON_SCHEME } from './branchContentProvider';

export const TAKE_HUNK_COMMAND = 'chevron.takeHunkFromBranch';

const CODELENS_PROMPT_DISMISSED_KEY = 'chevron.diffCodeLensPromptDismissed';

function pluralLines(count: number): string {
  return count === 1 ? '1 line' : `${count} lines`;
}

function describeHunk(hunk: LineHunk, label: string): string {
  if (hunk.newLines.length === 0) {
    return `Restore ${pluralLines(hunk.oldLines.length)} from ${label}`;
  }
  if (hunk.oldLines.length === 0) {
    return `Remove ${pluralLines(hunk.newLines.length)} not on ${label}`;
  }
  return `Replace ${pluralLines(hunk.newLines.length)} with ${label}'s ${pluralLines(hunk.oldLines.length)}`;
}

/**
 * `← Take from <branch>` — per-hunk apply in Chevron's diff editor. A
 * CodeLens above each changed block on the working-tree (`file://`) pane; clicking it replaces
 * that block in the working file with the other pane's text as a single `WorkspaceEdit` (so one
 * undo step), leaving the document dirty rather than saving it.
 *
 * **Where lenses appear.** Only on a `file://` document that is currently the *modified* side of
 * a diff tab whose *original* side is a Chevron one (`chevron-ref`, or another worktree's file for
 * a worktree target) — found by scanning `vscode.window.tabGroups` (see
 * `HunkSource.findChevronDiffFor`). Gating on the tab rather than on "any file in the repo while a
 * target is selected" keeps the lenses out of normal editing, and lets the old side come straight
 * from the pane the user is looking at. CodeLenses are per *document*, not per editor, so the same
 * file open in a plain editor tab alongside its Chevron diff shows them there too — harmless, since
 * the action is identical.
 *
 * **`diffEditor.codeLens`.** VS Code hides CodeLenses in diff editors unless that setting is on
 * (default off). Rather than overriding a global default that affects every diff editor (SCM,
 * other extensions), the first time a Chevron diff becomes active with it off, Chevron offers to
 * turn it on (once per session, with "Don't Ask Again"). The same action is also reachable
 * without lenses: `chevron.takeHunkFromBranch` with no arguments takes the hunk under the cursor.
 *
 * **Staleness.** A lens carries the exact hunk it was rendered for. Applying recomputes the diff
 * from the current buffer and current other pane, and only proceeds if an identical hunk (same
 * positions and same text on both sides) is still there and the document range still holds the
 * expected text — otherwise it refreshes the lenses and bails with a message. There is no `await`
 * between that final check and `applyEdit`, and VS Code itself rejects a `WorkspaceEdit` for a
 * document whose version moved in between.
 */
export class TakeFromBranchController implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private promptedThisSession = false;

  constructor(
    private readonly hunkSource: HunkSource,
    private readonly globalState: vscode.Memento,
  ) {
    this.disposables.push(
      this.emitter,
      vscode.window.tabGroups.onDidChangeTabs(() => {
        this.scheduleRefresh();
        void this.maybePromptForDiffCodeLens();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        // The working-tree side's own lenses are re-requested by VS Code on every edit anyway;
        // changes to the *other* pane change the hunks too — another worktree's live file being
        // edited, or a branch pane re-read after the merge-base moved (`BranchContentProvider`).
        const scheme = event.document.uri.scheme;
        if ((scheme === 'file' || scheme === CHEVRON_SCHEME) && this.hunkSource.isChevronOriginal(event.document.uri)) {
          this.scheduleRefresh();
        }
      }),
    );
  }

  /** Asks VS Code to re-request lenses now (comparison target changed, git state refreshed). */
  refresh(): void {
    this.emitter.fire();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => this.emitter.fire(), 250);
  }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    // `chevron.takeFromBranch.enabled: false` hides the lenses; the command itself (cursor-based)
    // stays available. `extension.ts` calls `refresh()` when the setting changes.
    if (!settings.takeFromBranchEnabled()) {
      return [];
    }
    const source = await this.hunkSource.resolveTakeSource(document);
    if (!source || token.isCancellationRequested) {
      return [];
    }
    return source.hunks.map((hunk) => {
      const line = hunkAnchorLine(hunk, document.lineCount);
      return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: `← Take from ${source.label}`,
        tooltip: describeHunk(hunk, source.label),
        command: TAKE_HUNK_COMMAND,
        arguments: [document.uri, hunk],
      });
    });
  }

  /**
   * Applies one hunk. With `expectedHunk` (the CodeLens path) it applies exactly that hunk or
   * nothing; without it, the hunk under the cursor in the active editor. Resolves `true` only if
   * the edit was applied.
   */
  async take(uri?: vscode.Uri, expectedHunk?: LineHunk): Promise<boolean> {
    const activeEditor = vscode.window.activeTextEditor;
    const document = uri
      ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString())
      : activeEditor?.document;
    if (!document) {
      return false;
    }

    const source = await this.hunkSource.resolveTakeSource(document);
    if (!source) {
      void vscode.window.showInformationMessage(
        'Chevron: nothing to take here — open this file in a Chevron diff against a branch or worktree where it exists.',
      );
      return false;
    }

    // Everything from here to `applyEdit` is synchronous, so the checks below can't go stale
    // before the edit is dispatched. Recompute against this exact snapshot rather than trusting
    // `source.hunks`, which was computed before the `await` above.
    const text = document.getText();
    const hunks = diffLines(source.oldText, text);

    let hunk: LineHunk | undefined;
    if (expectedHunk) {
      hunk = findMatchingHunk(hunks, expectedHunk);
    } else if (activeEditor?.document === document) {
      hunk = hunkAtLine(hunks, activeEditor.selection.active.line, document.lineCount);
      if (!hunk) {
        void vscode.window.showInformationMessage(`Chevron: the cursor isn't on a change against ${source.label}.`);
        return false;
      }
    }
    if (!hunk) {
      return this.bailStale();
    }

    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const edit = computeHunkEdit(text, hunk, eol);
    if (!edit) {
      return this.bailStale();
    }
    const range = new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end));
    if (document.getText(range) !== edit.expected) {
      return this.bailStale();
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(document.uri, range, edit.replacement);
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      return this.bailStale();
    }
    return true;
  }

  private bailStale(): false {
    this.refresh();
    void vscode.window.showWarningMessage(
      'Chevron: that change no longer matches the file (it was edited since the diff was shown). Nothing was changed — the diff has been refreshed, try again.',
    );
    return false;
  }

  private async maybePromptForDiffCodeLens(): Promise<void> {
    if (this.promptedThisSession || !settings.takeFromBranchEnabled()) {
      return;
    }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff) || !this.hunkSource.describeChevronOriginal(input.original)) {
      return;
    }
    const config = vscode.workspace.getConfiguration('diffEditor');
    const inspected = config.inspect<boolean>('codeLens');
    // Not a registered setting on this VS Code build — nothing to turn on.
    if (inspected?.defaultValue === undefined || config.get<boolean>('codeLens')) {
      return;
    }
    if (this.globalState.get<boolean>(CODELENS_PROMPT_DISMISSED_KEY)) {
      return;
    }
    this.promptedThisSession = true;
    const turnOn = 'Turn On';
    const dontAsk = "Don't Ask Again";
    const choice = await vscode.window.showInformationMessage(
      'Chevron shows "← Take from <branch>" above each change in its diffs, but CodeLens is turned off in diff editors (diffEditor.codeLens).',
      turnOn,
      dontAsk,
    );
    if (choice === turnOn) {
      await config.update('codeLens', true, vscode.ConfigurationTarget.Global);
    } else if (choice === dontAsk) {
      await this.globalState.update(CODELENS_PROMPT_DISMISSED_KEY, true);
    }
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
