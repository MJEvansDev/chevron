import type { GitFileStatus } from './types';

/**
 * Text for the changed-files view's description line and its items' descriptions. Pure (no
 * `vscode` import) so Vitest can pin the exact formats — integration tests assert on them.
 */

/** `↓behind ↑ahead`, or `undefined` when the two are level. */
export function formatAheadBehind({ ahead, behind }: { ahead: number; behind: number }): string | undefined {
  if (ahead === 0 && behind === 0) {
    return undefined;
  }
  return `↓${behind} ↑${ahead}`;
}

/**
 * The view description: `main  ↓3 ↑5` for a single repo (unchanged from before multi-repo
 * support), prefixed with the active repo's name — `api · main  ↓3 ↑5` — when more than one repo
 * is open, so it's clear which repo the tree shows. With no target, just the repo name (multi-repo)
 * or nothing.
 */
export function formatViewDescription(options: {
  repoName?: string;
  targetLabel?: string;
  suffix?: string;
}): string | undefined {
  const target = options.targetLabel
    ? options.suffix
      ? `${options.targetLabel}  ${options.suffix}`
      : options.targetLabel
    : undefined;
  if (options.repoName) {
    return target ? `${options.repoName} · ${target}` : options.repoName;
  }
  return target;
}

/** The view's name in the manifest (`contributes.views`), shown when there's nothing to compare. */
export const DEFAULT_VIEW_TITLE = 'Compare to Branch';

/**
 * The view's title for a `formatViewDescription` result. The header text goes in the *title*, not
 * the `TreeView.description`: the view is alone in its container, and VS Code then merges its
 * header into the container's ("CHEVRON: <title>") and drops the description — so a description
 * would never be seen. Reads "CHEVRON: MAIN ↓3 ↑5".
 */
export function viewHeaderTitle(description: string | undefined): string {
  return description ?? DEFAULT_VIEW_TITLE;
}

/** A file item's description: `M  +3 -1` (or just `M` without counts), preceded by its directory in the flat-list layout. */
export function formatFileDescription(element: {
  status: GitFileStatus;
  additions?: number;
  deletions?: number;
  directory?: string;
}): string {
  const status =
    element.additions === undefined && element.deletions === undefined
      ? element.status
      : `${element.status}  +${element.additions ?? 0} -${element.deletions ?? 0}`;
  return element.directory ? `${element.directory}  ${status}` : status;
}
