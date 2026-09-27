import type { TreeNode } from './treeBuilder';

/**
 * Pure ordering logic for next/previous change navigation (IntelliJ's F7 / Shift+F7) — see
 * `changeNavigationCommands.ts` for the command side. No runtime `vscode` import, so Vitest can
 * cover it.
 */

export type NavigationDirection = 'next' | 'previous';

/**
 * Changed files in the order the changed-files tree displays them (depth-first, folders before
 * files, as `buildChangedFilesTree` sorts them) — so rolling over to "the next file" matches what
 * the user sees in the tree. Deleted files are skipped: their working-tree side doesn't exist, so
 * there's nothing to put a cursor in.
 */
export function orderedNavigableFiles(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  const visit = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'folder') {
        visit(node.children);
      } else if (node.status !== 'D') {
        paths.push(node.path);
      }
    }
  };
  visit(nodes);
  return paths;
}

/**
 * The line to move to within the current file, given each hunk's inclusive 0-based line span
 * (sorted, as `diffLines` produces them) and the cursor's line — or `undefined` when there's no
 * further hunk that way and navigation should roll over to another file.
 *
 * Next: the first hunk starting *below* the cursor. Previous: the last hunk ending *above* the
 * cursor — so from inside a hunk, previous goes to the hunk before it, not to the top of the one
 * the cursor is already in.
 */
export function findAdjacentHunkLine(
  spans: Array<{ start: number; end: number }>,
  cursorLine: number,
  direction: NavigationDirection,
): number | undefined {
  if (direction === 'next') {
    return spans.find((span) => span.start > cursorLine)?.start;
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i].end < cursorLine) {
      return spans[i].start;
    }
  }
  return undefined;
}

/**
 * Files to try, in order, when rolling over from `currentPath` — every file after it for `next`,
 * every file before it (nearest first) for `previous`. No wrap-around: at either end navigation
 * stops and says so, rather than silently jumping back to the other end of the tree. If the
 * current file isn't a changed file at all, `next` starts from the top and `previous` from the
 * bottom.
 */
export function rolloverCandidates(
  files: string[],
  currentPath: string | undefined,
  direction: NavigationDirection,
): string[] {
  const index = currentPath === undefined ? -1 : files.indexOf(currentPath);
  if (direction === 'next') {
    return index === -1 ? files.slice() : files.slice(index + 1);
  }
  return (index === -1 ? files.slice() : files.slice(0, index)).reverse();
}
