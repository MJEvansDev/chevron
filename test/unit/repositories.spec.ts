import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  chooseActiveRepo,
  containsRepo,
  findRepoForPath,
  repoDisplayNames,
  repoStateKey,
  uniqueRepoRoots,
} from '../../src/repositories';

describe('uniqueRepoRoots', () => {
  it('drops duplicates, keeping first-seen order', () => {
    expect(uniqueRepoRoots(['/w/a', '/w/b', '/w/a', '/w/c', '/w/b'], path.posix)).toEqual(['/w/a', '/w/b', '/w/c']);
  });

  it('treats paths that differ only by trailing separator or Windows casing as the same repo', () => {
    expect(uniqueRepoRoots(['/w/a', '/w/a/'], path.posix)).toEqual(['/w/a']);
    expect(uniqueRepoRoots(['C:\\w\\a', 'c:\\W\\A'], path.win32)).toEqual(['C:\\w\\a']);
  });

  it('keeps case-distinct paths apart on POSIX', () => {
    expect(uniqueRepoRoots(['/w/a', '/w/A'], path.posix)).toEqual(['/w/a', '/w/A']);
  });
});

describe('findRepoForPath', () => {
  const roots = ['/w/outer', '/w/outer/vendor/inner', '/w/other'];

  it('finds the repo containing a file', () => {
    expect(findRepoForPath(roots, '/w/other/src/x.ts', path.posix)).toBe('/w/other');
  });

  it('prefers the deepest (nested) repo', () => {
    expect(findRepoForPath(roots, '/w/outer/vendor/inner/y.ts', path.posix)).toBe('/w/outer/vendor/inner');
    expect(findRepoForPath(roots, '/w/outer/vendor/z.ts', path.posix)).toBe('/w/outer');
  });

  it('counts the root itself as inside', () => {
    expect(findRepoForPath(roots, '/w/other', path.posix)).toBe('/w/other');
  });

  it('returns undefined outside every repo, including a sibling with a shared prefix', () => {
    expect(findRepoForPath(roots, '/w/elsewhere/a.ts', path.posix)).toBeUndefined();
    expect(findRepoForPath(roots, '/w/other-repo/a.ts', path.posix)).toBeUndefined();
  });

  it('matches Windows paths regardless of drive-letter case or separators', () => {
    expect(findRepoForPath(['C:/work/repo'], 'c:\\work\\repo\\src\\a.ts', path.win32)).toBe('C:/work/repo');
  });
});

describe('containsRepo', () => {
  it('uses path equality', () => {
    expect(containsRepo(['/w/a'], '/w/a/', path.posix)).toBe(true);
    expect(containsRepo(['/w/a'], '/w/b', path.posix)).toBe(false);
    expect(containsRepo(['/w/a'], undefined, path.posix)).toBe(false);
  });
});

describe('repoDisplayNames', () => {
  it('uses the folder name', () => {
    const names = repoDisplayNames(['/w/api', '/w/web'], path.posix);
    expect(names.get('/w/api')).toBe('api');
    expect(names.get('/w/web')).toBe('web');
  });

  it('disambiguates repos sharing a folder name with their parent', () => {
    const names = repoDisplayNames(['/work/api', '/personal/api', '/work/web'], path.posix);
    expect(names.get('/work/api')).toBe('work/api');
    expect(names.get('/personal/api')).toBe('personal/api');
    expect(names.get('/work/web')).toBe('web');
  });
});

describe('repoStateKey', () => {
  it('normalizes the path', () => {
    expect(repoStateKey('/w/a/', path.posix)).toBe('/w/a');
  });

  it('is case-insensitive on Windows', () => {
    expect(repoStateKey('C:\\Work\\Repo', path.win32)).toBe(repoStateKey('c:\\work\\repo', path.win32));
  });
});

describe('chooseActiveRepo', () => {
  const roots = ['/w/a', '/w/b', '/w/c'];

  it("prefers the active editor's repo", () => {
    expect(chooseActiveRepo(roots, { fromEditor: '/w/c', previous: '/w/b', remembered: '/w/a' }, path.posix)).toBe('/w/c');
  });

  it('keeps the previous repo when the editor has none', () => {
    expect(chooseActiveRepo(roots, { previous: '/w/b', remembered: '/w/a' }, path.posix)).toBe('/w/b');
  });

  it('falls back to the remembered repo, then the first', () => {
    expect(chooseActiveRepo(roots, { previous: '/w/gone', remembered: '/w/c' }, path.posix)).toBe('/w/c');
    expect(chooseActiveRepo(roots, { remembered: '/w/gone' }, path.posix)).toBe('/w/a');
  });

  it('returns the canonical root even when a candidate is spelled differently', () => {
    expect(chooseActiveRepo(roots, { previous: '/w/b/' }, path.posix)).toBe('/w/b');
  });

  it('is undefined when there are no repos', () => {
    expect(chooseActiveRepo([], { previous: '/w/a' }, path.posix)).toBeUndefined();
  });
});
