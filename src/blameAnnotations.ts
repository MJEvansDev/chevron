import * as vscode from 'vscode';
import { BlameSource } from './blameSource';
import type { ChangedLinesSource } from './changedLinesSource';
import { formatBlameAnnotationText } from './blameFormat';
import { settings } from './settings';

/**
 * Toggleable "blame in the margin" annotations — a compact author/relative-time label prefixed
 * before each *changed* line's code (added or modified relative to the comparison branch's
 * merge-base — see `ChangedLinesSource`), reading as a margin column. Restricted to changed lines
 * rather than every line in the file: annotating every line was visual noise (a label on every
 * line of every open file) — narrowing it to just the lines this branch actually touched keeps it
 * relevant to what Chevron is comparing, and means the annotation only ever displaces code on
 * the (typically few) lines that actually have one.
 *
 * Only the working-tree pane (`file://`) gets annotated — never the branch-side
 * (`chevron-ref://`) pane of the diff editor. Two panes each carrying their own blame margin
 * was one column too many, and the working-tree pane is the one to keep: it's always the most
 * recent version of the file (unsaved edits included), where the branch-side pane is a fixed
 * historical snapshot. `ChangedLinesSource` already returns `undefined` for anything that isn't a
 * `file://` document, which resolves to zero decorations for the branch pane without this class
 * needing its own scheme check for that — but it still checks explicitly below to skip the
 * (cached, so not wasted, but pointless here) blame fetch too.
 *
 * `before` content (prepended at column 0) rather than `after` (trailing past the end of the
 * line): `before` is what actually reads as "a margin" — a consistent left-hand column — where
 * `after` reads as an inline trailing comment. This used to be the reason `after` was chosen
 * instead (annotating *every* line, `before` pushed code rightward on every single line, eating a
 * third-plus of a split editor's width); now that only changed lines carry a label at all, that
 * cost is confined to the few lines that actually changed rather than the whole file. VS Code's
 * decoration API still has no way to put arbitrary text in the *real* glyph/gutter margin (only
 * icons via `gutterIconPath`), so this remains an editor-content-area decoration made to look like
 * one, not a true margin annotation.
 *
 * Off by default (`chevron.blame.annotationsEnabledByDefault`; the toggle itself isn't persisted),
 * toggled by `chevron.toggleBlameAnnotations`; the date style is `chevron.blame.dateFormat`. Independent of
 * `BlameHoverProvider` — hovering a line keeps working regardless of this toggle, on *either*
 * pane and *any* line (not just changed ones), and still shows the full detail (committer,
 * absolute date, summary, hash) this compact form omits.
 */
export class BlameAnnotationController implements vscode.Disposable {
  private enabled: boolean;
  /** Set once the user toggles; from then on `chevron.blame.annotationsEnabledByDefault` no longer applies this session. */
  private toggledByUser = false;
  private readonly decorationType: vscode.TextEditorDecorationType;

  constructor(
    private readonly blameSource: BlameSource,
    private readonly changedLinesSource: ChangedLinesSource,
  ) {
    this.enabled = settings.blameAnnotationsEnabledByDefault();
    void vscode.commands.executeCommand('setContext', 'chevron.blameAnnotationsEnabled', this.enabled);
    this.decorationType = vscode.window.createTextEditorDecorationType({
      before: {
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: '0 1.5em 0 0',
      },
    });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async toggle(): Promise<void> {
    this.toggledByUser = true;
    await this.setEnabled(!this.enabled);
  }

  /**
   * `chevron.blame.annotationsEnabledByDefault` changed: follow it, unless the user has already
   * toggled annotations this session (their explicit choice wins).
   */
  async applyDefaultSetting(): Promise<void> {
    if (!this.toggledByUser) {
      await this.setEnabled(settings.blameAnnotationsEnabledByDefault());
    }
  }

  /** Redraws every visible editor, e.g. after `chevron.blame.dateFormat` changed. */
  async refreshAll(): Promise<void> {
    await Promise.all(vscode.window.visibleTextEditors.map((editor) => this.refresh(editor)));
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await vscode.commands.executeCommand('setContext', 'chevron.blameAnnotationsEnabled', this.enabled);
    if (this.enabled) {
      await Promise.all(vscode.window.visibleTextEditors.map((editor) => this.refresh(editor)));
    } else {
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(this.decorationType, []);
      }
    }
  }

  async refresh(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!this.enabled || !editor) {
      return;
    }

    // Working-tree pane only — see the class doc comment for why the branch-side pane never gets
    // annotated.
    // Very large files are skipped outright (no blame, no changed-lines diff) — see
    // `BlameSource.isTooLarge`.
    if (
      editor.document.uri.scheme !== 'file' ||
      !this.blameSource.resolveRequest(editor.document) ||
      BlameSource.isTooLarge(editor.document)
    ) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const [lines, changedLines] = await Promise.all([
      this.blameSource.getBlame(editor.document),
      this.changedLinesSource.getChangedLines(editor.document),
    ]);
    const byLine = new Map(lines.map((line) => [line.line, line]));
    const dateFormat = settings.blameDateFormat();
    const now = Date.now();

    const decorations: vscode.DecorationOptions[] = [];
    for (let lineIndex = 0; lineIndex < editor.document.lineCount; lineIndex++) {
      const lineNumber = lineIndex + 1;
      // No comparison branch (or nothing changed on this line) — nothing to annotate here. See
      // `ChangedLinesSource`'s doc comment for why `undefined` means "show nothing" rather than
      // "show everything."
      if (!changedLines || !changedLines.has(lineNumber)) {
        continue;
      }
      const blameLine = byLine.get(lineNumber);
      if (!blameLine) {
        continue;
      }
      decorations.push({
        range: new vscode.Range(lineIndex, 0, lineIndex, 0),
        renderOptions: { before: { contentText: formatBlameAnnotationText(blameLine, now, dateFormat) } },
      });
    }
    editor.setDecorations(this.decorationType, decorations);
  }

  dispose(): void {
    this.decorationType.dispose();
  }
}
