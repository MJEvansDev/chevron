import * as vscode from 'vscode';
import { MessageDeduper } from './limits';

const deduper = new MessageDeduper();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Non-modal error toast, deduplicated by message text for 30s — so the same failure hit by many
 * callers at once (every file in a 50-file tree, every visible editor's blame) produces one toast.
 */
export function reportError(error: unknown): void {
  const message = messageOf(error);
  if (deduper.shouldShow(`error:${message}`)) {
    void vscode.window.showErrorMessage(`Chevron: ${message}`);
  }
}

/** Same deduplication, for warnings keyed by the caller (e.g. one per comparison ref). */
export function reportWarningOnce(key: string, message: string): void {
  if (deduper.shouldShow(`warning:${key}`)) {
    void vscode.window.showWarningMessage(`Chevron: ${message}`);
  }
}
