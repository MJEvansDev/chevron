import { describe, it, expect } from 'vitest';
import {
  parseDiffRawNumstat,
  parseNumstat,
  parseBlamePorcelain,
  parseUnifiedDiffHunks,
  parseWorktreeList,
  splitNul,
  countTextLines,
  pickGitBinary,
  classifyExecError,
  GitError,
} from '../../src/gitService';

describe('parseDiffRawNumstat', () => {
  const raw = (status: string, ...paths: string[]) => `:100644 100644 abc1234 def5678 ${status}\0${paths.join('\0')}\0`;
  const stat = (added: string, deleted: string, filePath: string) => `${added}\t${deleted}\t${filePath}\0`;
  const renameStat = (added: string, deleted: string, from: string, to: string) =>
    `${added}\t${deleted}\t\0${from}\0${to}\0`;

  it('parses modified, added, and deleted files with their counts', () => {
    const output =
      raw('M', 'src/extension.ts') +
      raw('A', 'src/newFile.ts') +
      raw('D', 'src/oldFile.ts') +
      stat('12', '4', 'src/extension.ts') +
      stat('7', '0', 'src/newFile.ts') +
      stat('0', '20', 'src/oldFile.ts');

    expect(parseDiffRawNumstat(output)).toEqual([
      { status: 'M', path: 'src/extension.ts', additions: 12, deletions: 4 },
      { status: 'A', path: 'src/newFile.ts', additions: 7, deletions: 0 },
      { status: 'D', path: 'src/oldFile.ts', additions: 0, deletions: 20 },
    ]);
  });

  it('parses renames (with a similarity score) and keys their counts by the new path', () => {
    const output =
      raw('R096', 'dir/old.txt', 'dir/new.txt') +
      raw('M', 'other.txt') +
      renameStat('1', '0', 'dir/old.txt', 'dir/new.txt') +
      stat('2', '3', 'other.txt');

    expect(parseDiffRawNumstat(output)).toEqual([
      { status: 'R', previousPath: 'dir/old.txt', path: 'dir/new.txt', additions: 1, deletions: 0 },
      { status: 'M', path: 'other.txt', additions: 2, deletions: 3 },
    ]);
  });

  it('attaches counts by path even if numstat lists files in a different order', () => {
    const output = raw('M', 'a.txt') + raw('M', 'b.txt') + stat('5', '5', 'b.txt') + stat('1', '1', 'a.txt');

    expect(parseDiffRawNumstat(output)).toEqual([
      { status: 'M', path: 'a.txt', additions: 1, deletions: 1 },
      { status: 'M', path: 'b.txt', additions: 5, deletions: 5 },
    ]);
  });

  it('keeps files without a numstat record, rather than dropping every count', () => {
    const output = raw('M', 'a.txt') + raw('M', 'b.txt') + stat('1', '2', 'a.txt');

    expect(parseDiffRawNumstat(output)).toEqual([
      { status: 'M', path: 'a.txt', additions: 1, deletions: 2 },
      { status: 'M', path: 'b.txt' },
    ]);
  });

  it('handles paths with spaces, tabs-free punctuation, non-ASCII and arrow-like text verbatim', () => {
    const output =
      raw('M', 'dir with space/file name.txt') +
      raw('A', 'ünïcödé/日本語.txt') +
      raw('M', 'weird => name.txt') +
      stat('1', '1', 'dir with space/file name.txt') +
      stat('3', '0', 'ünïcödé/日本語.txt') +
      stat('4', '4', 'weird => name.txt');

    expect(parseDiffRawNumstat(output)).toEqual([
      { status: 'M', path: 'dir with space/file name.txt', additions: 1, deletions: 1 },
      { status: 'A', path: 'ünïcödé/日本語.txt', additions: 3, deletions: 0 },
      { status: 'M', path: 'weird => name.txt', additions: 4, deletions: 4 },
    ]);
  });

  it('treats "-" counts (binary files) as undefined', () => {
    const output = raw('M', 'image.png') + stat('-', '-', 'image.png');

    expect(parseDiffRawNumstat(output)).toEqual([
      { status: 'M', path: 'image.png', additions: undefined, deletions: undefined },
    ]);
  });

  it('maps copies to added and type-changes/unmerged to modified', () => {
    const output = raw('C075', 'a.txt', 'copy.txt') + raw('T', 'link') + raw('U', 'conflicted.txt');

    expect(parseDiffRawNumstat(output)).toEqual([
      { status: 'A', path: 'copy.txt' },
      { status: 'M', path: 'link' },
      { status: 'M', path: 'conflicted.txt' },
    ]);
  });

  it('returns an empty array for no changes', () => {
    expect(parseDiffRawNumstat('')).toEqual([]);
  });
});

describe('splitNul', () => {
  it('splits NUL-terminated fields and drops the trailing empty field', () => {
    expect(splitNul('a\0b c\0')).toEqual(['a', 'b c']);
  });

  it('returns no fields for empty output', () => {
    expect(splitNul('')).toEqual([]);
  });
});

describe('countTextLines', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('counts newline-terminated lines', () => {
    expect(countTextLines(bytes('a\nb\n'))).toBe(2);
  });

  it('counts a final line without a trailing newline', () => {
    expect(countTextLines(bytes('a\nb'))).toBe(2);
  });

  it('counts CRLF lines once each', () => {
    expect(countTextLines(bytes('a\r\nb\r\n'))).toBe(2);
  });

  it('returns 0 for an empty file', () => {
    expect(countTextLines(bytes(''))).toBe(0);
  });

  it('returns undefined for binary content (NUL byte)', () => {
    expect(countTextLines(new Uint8Array([0x61, 0x00, 0x62]))).toBeUndefined();
  });
});

describe('pickGitBinary', () => {
  const exists = (candidate: string) => candidate.startsWith('/exists');

  it('defaults to git when unset', () => {
    expect(pickGitBinary(undefined, exists)).toBe('git');
    expect(pickGitBinary(null, exists)).toBe('git');
    expect(pickGitBinary('', exists)).toBe('git');
  });

  it('uses a configured path that exists', () => {
    expect(pickGitBinary('/exists/git', exists)).toBe('/exists/git');
  });

  it('falls back to git when the configured path does not exist', () => {
    expect(pickGitBinary('/missing/git', exists)).toBe('git');
  });

  it('takes the first existing entry from an array', () => {
    expect(pickGitBinary(['/missing/git', '/exists/a', '/exists/b'], exists)).toBe('/exists/a');
  });

  it('ignores non-string entries', () => {
    expect(pickGitBinary([42, '/exists/git'], exists)).toBe('/exists/git');
  });
});

describe('classifyExecError', () => {
  it('classifies a missing binary', () => {
    const error = classifyExecError({ code: 'ENOENT', message: 'spawn git ENOENT' }, '', ['status'], 'git');
    expect(error).toBeInstanceOf(GitError);
    expect(error.kind).toBe('notFound');
    expect(error.message).toContain('git.path');
  });

  it('classifies an exceeded maxBuffer with a clear message', () => {
    const error = classifyExecError(
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: 'stdout maxBuffer length exceeded' },
      '',
      ['diff', '-z'],
      'git',
    );
    expect(error.kind).toBe('maxBuffer');
    expect(error.message).toContain('git diff');
    expect(error.message).toContain('too large');
  });

  it('keeps the exit code and stderr (CRLF-normalized) for an ordinary git failure', () => {
    const error = classifyExecError({ code: 128, message: 'Command failed' }, 'fatal: bad revision\r\n', ['show'], 'git');
    expect(error.kind).toBe('git');
    expect(error.exitCode).toBe(128);
    expect(error.stderr).toBe('fatal: bad revision');
    expect(error.message).toBe('fatal: bad revision');
  });

  it('falls back to the process error message when stderr is empty', () => {
    const error = classifyExecError({ code: 1, message: 'Command failed: git merge-base' }, '', ['merge-base'], 'git');
    expect(error.exitCode).toBe(1);
    expect(error.stderr).toBe('');
    expect(error.message).toBe('Command failed: git merge-base');
  });
});


describe('parseNumstat', () => {
  it('parses added/deleted line counts in file order', () => {
    const output = '12\t4\tsrc/extension.ts\n7\t0\tsrc/newFile.ts\n0\t20\tsrc/oldFile.ts\n';

    expect(parseNumstat(output)).toEqual([
      { additions: 12, deletions: 4 },
      { additions: 7, deletions: 0 },
      { additions: 0, deletions: 20 },
    ]);
  });

  it('treats "-" (binary files) as undefined rather than NaN', () => {
    expect(parseNumstat('-\t-\tsrc/image.png\n')).toEqual([{ additions: undefined, deletions: undefined }]);
  });

  it('returns an empty array for no changes', () => {
    expect(parseNumstat('')).toEqual([]);
  });
});

describe('parseBlamePorcelain', () => {
  it('parses a commit whose metadata is repeated for every line (--line-porcelain)', () => {
    const output = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2',
      'author Jane Doe',
      'author-mail <jane@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'committer Jane Doe',
      'committer-time 1700000000',
      'summary Add feature',
      'filename src/a.ts',
      '\tconst a = 1;',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2',
      'author Jane Doe',
      'author-mail <jane@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'committer Jane Doe',
      'committer-time 1700000000',
      'summary Add feature',
      'filename src/a.ts',
      '\tconst b = 2;',
      '',
    ].join('\n');

    expect(parseBlamePorcelain(output)).toEqual([
      { line: 1, hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', author: 'Jane Doe', committer: 'Jane Doe', authorTime: 1700000000, summary: 'Add feature' },
      { line: 2, hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', author: 'Jane Doe', committer: 'Jane Doe', authorTime: 1700000000, summary: 'Add feature' },
    ]);
  });

  it('resolves a repeat header with no metadata block (--porcelain) from the first-seen metadata', () => {
    const output = [
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1 1 2',
      'author John Smith',
      'author-time 1600000000',
      'committer John Smith',
      'summary Initial commit',
      'filename src/b.ts',
      '\tfirst line',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2',
      'filename src/b.ts',
      '\tsecond line',
      '',
    ].join('\n');

    expect(parseBlamePorcelain(output)).toEqual([
      { line: 1, hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', author: 'John Smith', committer: 'John Smith', authorTime: 1600000000, summary: 'Initial commit' },
      { line: 2, hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', author: 'John Smith', committer: 'John Smith', authorTime: 1600000000, summary: 'Initial commit' },
    ]);
  });

  it('captures a committer that differs from the author (e.g. a rebased or cherry-picked commit)', () => {
    const output = [
      'cccccccccccccccccccccccccccccccccccccccc 1 1 1',
      'author Jane Doe',
      'author-time 1650000000',
      'committer John Smith',
      'committer-time 1660000000',
      'summary Rebase onto main',
      'filename src/d.ts',
      '\tconst d = 4;',
      '',
    ].join('\n');

    expect(parseBlamePorcelain(output)).toEqual([
      {
        line: 1,
        hash: 'cccccccccccccccccccccccccccccccccccccccc',
        author: 'Jane Doe',
        committer: 'John Smith',
        authorTime: 1650000000,
        summary: 'Rebase onto main',
      },
    ]);
  });

  it('reports uncommitted lines with the all-zero hash and "Not Committed Yet"', () => {
    const output = [
      '0000000000000000000000000000000000000000 1 1 1',
      'author Not Committed Yet',
      'author-mail <not.committed.yet>',
      'author-time 1700000001',
      'committer Not Committed Yet',
      'summary Version of src/c.ts from src/c.ts',
      'filename src/c.ts',
      '\tuncommitted edit',
      '',
    ].join('\n');

    expect(parseBlamePorcelain(output)).toEqual([
      {
        line: 1,
        hash: '0000000000000000000000000000000000000000',
        author: 'Not Committed Yet',
        committer: 'Not Committed Yet',
        authorTime: 1700000001,
        summary: 'Version of src/c.ts from src/c.ts',
      },
    ]);
  });

  it('returns an empty array for no output', () => {
    expect(parseBlamePorcelain('')).toEqual([]);
  });
});

describe('parseUnifiedDiffHunks', () => {
  it('parses a modified hunk with explicit counts on both sides', () => {
    const output = ['@@ -10,2 +10,3 @@ function foo() {', '-old line', '-old line 2', '+new line', '+new line 2', '+new line 3'].join(
      '\n',
    );

    expect(parseUnifiedDiffHunks(output)).toEqual([{ old: { start: 10, end: 11 }, new: { start: 10, end: 12 } }]);
  });

  it('defaults an omitted count to 1', () => {
    expect(parseUnifiedDiffHunks('@@ -5 +5 @@\n-a\n+b')).toEqual([{ old: { start: 5, end: 5 }, new: { start: 5, end: 5 } }]);
  });

  it('has no old range for a pure addition (old count 0)', () => {
    expect(parseUnifiedDiffHunks('@@ -10,0 +11,3 @@\n+a\n+b\n+c')).toEqual([
      { old: undefined, new: { start: 11, end: 13 } },
    ]);
  });

  it('has no new range for a pure deletion (new count 0)', () => {
    expect(parseUnifiedDiffHunks('@@ -11,3 +10,0 @@\n-a\n-b\n-c')).toEqual([
      { old: { start: 11, end: 13 }, new: undefined },
    ]);
  });

  it('parses multiple hunks from the same output', () => {
    const output = ['@@ -1 +1 @@', '-a', '+b', '@@ -20,2 +20,2 @@', '-c', '-d', '+e', '+f'].join('\n');

    expect(parseUnifiedDiffHunks(output)).toEqual([
      { old: { start: 1, end: 1 }, new: { start: 1, end: 1 } },
      { old: { start: 20, end: 21 }, new: { start: 20, end: 21 } },
    ]);
  });

  it('returns an empty array for no output', () => {
    expect(parseUnifiedDiffHunks('')).toEqual([]);
  });
});

describe('parseWorktreeList', () => {
  it('parses multiple worktrees, each with its checked-out branch', () => {
    const output = [
      'worktree /repo/main',
      'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/feature-wt',
      'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'branch refs/heads/feature-x',
      '',
    ].join('\n');

    expect(parseWorktreeList(output)).toEqual([
      { path: '/repo/main', head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', branch: 'main' },
      { path: '/repo/feature-wt', head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', branch: 'feature-x' },
    ]);
  });

  it('leaves branch undefined for a detached HEAD worktree', () => {
    const output = [
      'worktree /repo/detached-wt',
      'HEAD cccccccccccccccccccccccccccccccccccccccc',
      'detached',
      '',
    ].join('\n');

    expect(parseWorktreeList(output)).toEqual([
      { path: '/repo/detached-wt', head: 'cccccccccccccccccccccccccccccccccccccccc', branch: undefined },
    ]);
  });

  it('drops a bare repo entry', () => {
    const output = ['worktree /repo/.bare', 'bare', '', 'worktree /repo/main', 'HEAD dddddddddddddddddddddddddddddddddddddddd', 'branch refs/heads/main', ''].join(
      '\n',
    );

    expect(parseWorktreeList(output)).toEqual([
      { path: '/repo/main', head: 'dddddddddddddddddddddddddddddddddddddddd', branch: 'main' },
    ]);
  });

  it('returns an empty array for no output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});
