import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { relativePathInside, isSamePath } from '../../src/pathUtils';

describe('relativePathInside', () => {
  describe('posix', () => {
    it('returns a forward-slash relative path for a file inside the root', () => {
      expect(relativePathInside('/repo', '/repo/src/a.ts', path.posix)).toBe('src/a.ts');
    });

    it('returns undefined for a file outside the root', () => {
      expect(relativePathInside('/repo', '/other/a.ts', path.posix)).toBeUndefined();
      expect(relativePathInside('/repo', '/repo-sibling/a.ts', path.posix)).toBeUndefined();
    });

    it('returns undefined for the root itself', () => {
      expect(relativePathInside('/repo', '/repo', path.posix)).toBeUndefined();
    });

    it('accepts a file whose name merely starts with ".."', () => {
      expect(relativePathInside('/repo', '/repo/..hidden', path.posix)).toBe('..hidden');
    });
  });

  describe('win32', () => {
    it('converts backslashes to forward slashes', () => {
      expect(relativePathInside('C:\\repo', 'C:\\repo\\src\\a.ts', path.win32)).toBe('src/a.ts');
    });

    it('treats drive-letter casing and git-style forward slashes as the same root', () => {
      expect(relativePathInside('C:/repo', 'c:\\repo\\src\\a.ts', path.win32)).toBe('src/a.ts');
    });

    it('returns undefined for a file on a different drive', () => {
      expect(relativePathInside('C:\\repo', 'D:\\repo\\a.ts', path.win32)).toBeUndefined();
    });

    it('returns undefined for a sibling directory', () => {
      expect(relativePathInside('C:\\repo', 'C:\\other\\a.ts', path.win32)).toBeUndefined();
    });
  });
});

describe('isSamePath', () => {
  it('ignores case and separator style on Windows', () => {
    expect(isSamePath('C:/Repo/wt', 'c:\\repo\\wt\\', path.win32)).toBe(true);
  });

  it('is case-sensitive on posix', () => {
    expect(isSamePath('/repo/wt', '/Repo/wt', path.posix)).toBe(false);
    expect(isSamePath('/repo/wt/', '/repo/wt', path.posix)).toBe(true);
  });
});
