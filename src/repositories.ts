import * as nodePath from 'node:path';
import { isSamePath, relativePathInside } from './pathUtils';

/**
 * Pure helpers for multi-root / multi-repo workspaces. No `vscode` import, so
 * Vitest-testable; `repositoryManager.ts` is the `vscode`-side wrapper. `pathImpl` defaults to the
 * host's `node:path`; tests pass `path.win32`/`path.posix` explicitly.
 */
type PathImpl = Pick<typeof nodePath, 'relative' | 'isAbsolute' | 'sep' | 'resolve' | 'basename' | 'dirname'>;

/**
 * Repo roots in first-seen order with duplicates removed — two workspace folders inside the same
 * repo (e.g. `repo/` and `repo/packages/a`) both resolve to one `--show-toplevel`.
 */
export function uniqueRepoRoots(roots: readonly string[], pathImpl: PathImpl = nodePath): string[] {
  const unique: string[] = [];
  for (const root of roots) {
    if (!unique.some((existing) => isSamePath(existing, root, pathImpl))) {
      unique.push(root);
    }
  }
  return unique;
}

/**
 * The known repo `fsPath` belongs to — the *deepest* containing root, so a file in a nested repo
 * (a submodule or vendored checkout opened as its own workspace folder) belongs to that repo, not
 * the outer one. The root itself counts as inside.
 */
export function findRepoForPath(roots: readonly string[], fsPath: string, pathImpl: PathImpl = nodePath): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const root of roots) {
    const inside = isSamePath(root, fsPath, pathImpl) || relativePathInside(root, fsPath, pathImpl) !== undefined;
    if (inside && pathImpl.resolve(root).length > bestLength) {
      best = root;
      bestLength = pathImpl.resolve(root).length;
    }
  }
  return best;
}

/** Whether `root` is one of `roots` (path-equality, not string-equality — see `isSamePath`). */
export function containsRepo(roots: readonly string[], root: string | undefined, pathImpl: PathImpl = nodePath): boolean {
  return root !== undefined && roots.some((candidate) => isSamePath(candidate, root, pathImpl));
}

/**
 * Short display names: the folder name, or `parent/name` when two repos share a folder name (e.g.
 * `work/api` and `personal/api`).
 */
export function repoDisplayNames(roots: readonly string[], pathImpl: PathImpl = nodePath): Map<string, string> {
  const names = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const root of roots) {
    const base = pathImpl.basename(root) || root;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  for (const root of roots) {
    const base = pathImpl.basename(root) || root;
    if ((counts.get(base) ?? 0) > 1) {
      const parent = pathImpl.basename(pathImpl.dirname(root));
      names.set(root, parent ? `${parent}/${base}` : root);
    } else {
      names.set(root, base);
    }
  }
  return names;
}

/**
 * A stable storage key for per-repo state: the resolved path, lower-cased on Windows (where
 * `C:\repo` and `c:\repo` are the same repo).
 */
export function repoStateKey(root: string, pathImpl: PathImpl = nodePath): string {
  const resolved = pathImpl.resolve(root);
  return pathImpl.sep === '\\' ? resolved.toLowerCase() : resolved;
}

/**
 * Which repo should be active after (re)discovery: the active editor's repo if it has one, else
 * the previously active repo if it's still open, else the one remembered from last session, else
 * the first.
 */
export function chooseActiveRepo(
  roots: readonly string[],
  candidates: { fromEditor?: string; previous?: string; remembered?: string },
  pathImpl: PathImpl = nodePath,
): string | undefined {
  for (const candidate of [candidates.fromEditor, candidates.previous, candidates.remembered]) {
    if (candidate !== undefined) {
      const match = roots.find((root) => isSamePath(root, candidate, pathImpl));
      if (match) {
        return match;
      }
    }
  }
  return roots[0];
}
