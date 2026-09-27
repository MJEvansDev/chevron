import * as nodePath from 'node:path';

/**
 * Path helpers that behave the same on Windows and POSIX. Pure (no `vscode` import) so they're
 * Vitest-testable; the `pathImpl` parameter defaults to the host's `node:path` but tests pass
 * `path.win32`/`path.posix` explicitly to exercise both.
 *
 * Why these exist: git prints forward-slash paths even on Windows (`C:/repo`), VS Code's
 * `Uri.fsPath` gives backslashes and a lower-case drive letter (`c:\repo`), and
 * `path.relative(...).startsWith('..')` is wrong both for a file whose name starts with `..` and for
 * a target on a different drive (where `path.relative` returns an absolute path, not a `..` one).
 */
type PathImpl = Pick<typeof nodePath, 'relative' | 'isAbsolute' | 'sep' | 'resolve'>;

/**
 * `target`'s path relative to `root`, with `/` separators (git's form), or `undefined` if `target`
 * isn't strictly inside `root`.
 */
export function relativePathInside(root: string, target: string, pathImpl: PathImpl = nodePath): string | undefined {
  const relative = pathImpl.relative(root, target);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${pathImpl.sep}`) ||
    relative.startsWith('../') ||
    pathImpl.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative.split(pathImpl.sep).join('/');
}

/** Whether two filesystem paths name the same location — case-insensitively on Windows (drive letters, NTFS). */
export function isSamePath(a: string, b: string, pathImpl: PathImpl = nodePath): boolean {
  const resolvedA = pathImpl.resolve(a);
  const resolvedB = pathImpl.resolve(b);
  if (pathImpl.sep === '\\') {
    return resolvedA.toLowerCase() === resolvedB.toLowerCase();
  }
  return resolvedA === resolvedB;
}
