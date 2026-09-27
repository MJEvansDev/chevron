import * as vscode from 'vscode';
import type { BlameSource } from './blameSource';
import type { BlameLine } from './types';
import { UNCOMMITTED_HASH } from './blameFormat';

/**
 * Hover-only blame for both panes of Chevron's diff editor: the local working-tree pane
 * (`file://`, blamed with no ref so uncommitted edits show as "Not committed yet") and the
 * branch-side pane (`chevron-ref://`, blamed at the merge-base commit so it lines up with the
 * content `BranchContentProvider` actually serves there — not the branch's raw tip). Independent
 * of `BlameAnnotationController` — this keeps working regardless of whether the margin
 * annotations are toggled on.
 */
export class BlameHoverProvider implements vscode.HoverProvider {
  constructor(private readonly blameSource: BlameSource) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    if (!this.blameSource.resolveRequest(document)) {
      return undefined;
    }

    const lines = await this.blameSource.getBlame(document);
    const blameLine = lines.find((entry) => entry.line === position.line + 1);
    if (!blameLine) {
      return undefined;
    }

    return new vscode.Hover(formatBlameMarkdown(blameLine), document.lineAt(position.line).range);
  }
}

function formatBlameMarkdown(blameLine: BlameLine): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  if (blameLine.hash === UNCOMMITTED_HASH) {
    markdown.appendMarkdown('**Not committed yet**');
    return markdown;
  }

  const date = new Date(blameLine.authorTime * 1000).toLocaleString();
  const summary = escapeMarkdown(blameLine.summary || '(no commit message)');
  const who =
    blameLine.committer && blameLine.committer !== blameLine.author
      ? `**${escapeMarkdown(blameLine.author)}** (committed by ${escapeMarkdown(blameLine.committer)})`
      : `**${escapeMarkdown(blameLine.author)}**`;
  markdown.appendMarkdown(`${who}, ${date}\n\n${summary}\n\n\`${blameLine.hash.slice(0, 7)}\``);
  return markdown;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!-]/g, '\\$&');
}
