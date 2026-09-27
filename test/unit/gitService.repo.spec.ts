// Exercises GitService against real scratch repos. No `vscode` import, so this runs under Vitest —
// it only needs a `git` binary on PATH, which every environment that builds this repo has.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitService, GitError, PathNotAtRefError, type MergeBaseFallbackReason } from '../../src/gitService';

let scratch: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function write(dir: string, relativePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(dir, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(dir, relativePath), content);
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chevron-git-'));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('GitService against a real repo', () => {
  let repo: string;
  const service = new GitService();

  beforeAll(() => {
    repo = initRepo('main-repo');
    write(repo, 'file.txt', 'original\n');
    write(repo, 'to-rename.txt', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
    write(repo, 'dir with space/file with space.txt', 'one\n');
    write(repo, 'ünïcödé.txt', 'unicode\n');
    commitAll(repo, 'initial');
    git(repo, ['tag', '-a', 'v0.1', '-m', 'annotated tag']);
    git(repo, ['branch', 'other']);

    git(repo, ['mv', 'to-rename.txt', 'renamed.txt']);
    write(repo, 'dir with space/file with space.txt', 'two\n');
    write(repo, 'ünïcödé.txt', 'unicode changed\n');
    write(repo, 'image.bin', Buffer.from([0x89, 0x00, 0x01, 0x02]));
    commitAll(repo, 'changes on main');

    write(repo, 'untracked.txt', 'a\nb\nc');
    write(repo, 'untracked.bin', Buffer.from([0x00, 0x01]));
  });

  it('reports renames, spaces, non-ASCII and binary files with path-keyed counts', async () => {
    const files = await service.getChangedFiles('other', repo);
    const byPath = new Map(files.map((file) => [file.path, file]));

    expect(byPath.get('renamed.txt')).toEqual({
      status: 'R',
      previousPath: 'to-rename.txt',
      path: 'renamed.txt',
      additions: 0,
      deletions: 0,
    });
    expect(byPath.get('dir with space/file with space.txt')).toMatchObject({ status: 'M', additions: 1, deletions: 1 });
    expect(byPath.get('ünïcödé.txt')).toMatchObject({ status: 'M', additions: 1, deletions: 1 });
    expect(byPath.get('image.bin')).toMatchObject({ status: 'A', additions: undefined, deletions: undefined });
  });

  it('gives untracked text files a line count and binary ones none', async () => {
    const files = await service.getChangedFiles('other', repo);
    const byPath = new Map(files.map((file) => [file.path, file]));

    expect(byPath.get('untracked.txt')).toEqual({ status: 'U', path: 'untracked.txt', additions: 3, deletions: 0 });
    expect(byPath.get('untracked.bin')).toEqual({ status: 'U', path: 'untracked.bin' });
  });

  it('leaves untracked files out when includeUntracked is false', async () => {
    const files = await service.getChangedFiles('other', repo, { includeUntracked: false });
    expect(files.some((file) => file.status === 'U')).toBe(false);
    expect(files.some((file) => file.path === 'renamed.txt')).toBe(true);
  });

  it('reads origin/HEAD, and reports undefined when it is not set', async () => {
    expect(await service.getOriginHead(repo)).toBeUndefined();

    const clone = path.join(scratch, 'clone-of-main-repo');
    git(scratch, ['clone', '-q', repo, clone]);
    expect(await service.getOriginHead(clone)).toBe('origin/main');
  });

  it('compares against an annotated tag and a raw SHA', async () => {
    const sha = git(repo, ['rev-parse', 'v0.1^{commit}']).trim();
    expect(await service.resolveCommit('v0.1', repo)).toBe(sha);
    expect(await service.resolveCommit(sha.slice(0, 10), repo)).toBe(sha);

    const viaTag = await service.getChangedFiles('v0.1', repo);
    expect(viaTag.some((file) => file.path === 'renamed.txt')).toBe(true);
    const viaSha = await service.getChangedFiles(sha, repo);
    expect(viaSha.map((file) => file.path).sort()).toEqual(viaTag.map((file) => file.path).sort());

    expect(await service.listTags(repo)).toContain('v0.1');
  });

  it('rejects refs that do not name a commit (or look like options)', async () => {
    expect(await service.resolveCommit('does-not-exist', repo)).toBeUndefined();
    expect(await service.resolveCommit('--all', repo)).toBeUndefined();
    expect(await service.resolveCommit('', repo)).toBeUndefined();
  });

  it('serves content at the merge-base for paths with spaces and non-ASCII names', async () => {
    expect(await service.getFileContentAtRef('other', 'dir with space/file with space.txt', repo)).toBe('one\n');
    expect(await service.getFileContentAtRef('other', 'ünïcödé.txt', repo)).toBe('unicode\n');
  });

  it("finds a renamed file's path at the merge-base, and nothing for other files", async () => {
    expect(await service.getPreviousPath('other', 'renamed.txt', repo)).toBe('to-rename.txt');
    expect(await service.getPreviousPath('other', 'file.txt', repo)).toBeUndefined();
    expect(await service.getPreviousPath('other', 'untracked.txt', repo)).toBeUndefined();
    const renamedContent = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    expect(await service.getFileContentAtRef('other', 'to-rename.txt', repo)).toBe(renamedContent);
  });

  it('distinguishes a path absent at the ref from a real git failure', async () => {
    await expect(service.getFileContentAtRef('other', 'renamed.txt', repo)).rejects.toBeInstanceOf(PathNotAtRefError);

    const badRef = service.getFileContentAtRef('no-such-branch', 'file.txt', repo);
    await expect(badRef).rejects.toBeInstanceOf(GitError);
    await expect(badRef).rejects.not.toBeInstanceOf(PathNotAtRefError);
  });

  it('caches the merge-base until invalidated', async () => {
    const local = new GitService();
    const first = await local.getMergeBase('other', repo);
    expect(first).toBe(git(repo, ['merge-base', 'other', 'HEAD']).trim());

    // Move `other` so its merge-base with HEAD changes; the cached value survives until invalidated.
    git(repo, ['branch', '-f', 'other', 'HEAD']);
    try {
      expect(await local.getMergeBase('other', repo)).toBe(first);
      local.invalidateCache();
      expect(await local.getMergeBase('other', repo)).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
    } finally {
      git(repo, ['branch', '-f', 'other', 'v0.1^{commit}']);
    }
  });

  it('resolves the git dirs of a normal repo and a linked worktree', async () => {
    const dirs = await service.getGitDirs(repo);
    expect(fs.realpathSync.native(dirs.gitDir)).toBe(fs.realpathSync.native(path.join(repo, '.git')));
    expect(fs.realpathSync.native(dirs.commonDir)).toBe(fs.realpathSync.native(path.join(repo, '.git')));

    const worktree = path.join(scratch, 'linked-worktree');
    git(repo, ['worktree', 'add', '-q', worktree, '-b', 'wt-branch']);
    const wtDirs = await service.getGitDirs(worktree);
    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);
    expect(fs.realpathSync.native(wtDirs.gitDir)).toBe(fs.realpathSync.native(path.join(repo, '.git', 'worktrees', 'linked-worktree')));
    expect(fs.realpathSync.native(wtDirs.commonDir)).toBe(fs.realpathSync.native(path.join(repo, '.git')));

    const listed = await service.listWorktrees(repo);
    expect(listed.map((entry) => fs.realpathSync.native(entry.path))).toEqual([fs.realpathSync.native(worktree)]);
  });

  it('reports the current branch, and an empty string for a detached HEAD', async () => {
    expect(await service.getCurrentBranch(repo)).toBe('main');
    const detached = path.join(scratch, 'detached-worktree');
    git(repo, ['worktree', 'add', '-q', '--detach', detached, 'HEAD']);
    expect(await service.getCurrentBranch(detached)).toBe('');
    // A detached HEAD still has a merge-base with a branch.
    expect(await service.getMergeBase('other', detached)).toBe(git(repo, ['merge-base', 'other', 'HEAD']).trim());
  });
});

describe('GitService merge-base fallbacks', () => {
  it('falls back to the ref tip for unrelated histories, notifying the listener', async () => {
    const repo = initRepo('unrelated');
    write(repo, 'a.txt', 'a\n');
    commitAll(repo, 'main root');
    git(repo, ['checkout', '-q', '--orphan', 'island']);
    git(repo, ['rm', '-rq', '--cached', '.']);
    fs.rmSync(path.join(repo, 'a.txt'));
    write(repo, 'b.txt', 'b\n');
    commitAll(repo, 'island root');

    const service = new GitService();
    const notified: [string, MergeBaseFallbackReason][] = [];
    service.setMergeBaseFallbackListener((ref, reason) => notified.push([ref, reason]));

    expect(await service.getMergeBase('main', repo)).toBe(git(repo, ['rev-parse', 'main']).trim());
    expect(notified).toEqual([['main', 'noCommonAncestor']]);

    // Cached: a second lookup doesn't notify again.
    await service.getMergeBase('main', repo);
    expect(notified).toHaveLength(1);

    const files = await service.getChangedFiles('main', repo);
    expect(files.map((file) => [file.status, file.path]).sort()).toEqual([
      ['A', 'b.txt'],
      ['D', 'a.txt'],
    ]);
  });

  it('falls back to the ref tip when HEAD has no commits yet', async () => {
    const repo = initRepo('orphan');
    write(repo, 'a.txt', 'a\n');
    commitAll(repo, 'root');
    git(repo, ['checkout', '-q', '--orphan', 'fresh']);

    const service = new GitService();
    const reasons: MergeBaseFallbackReason[] = [];
    service.setMergeBaseFallbackListener((_ref, reason) => reasons.push(reason));

    expect(await service.getMergeBase('main', repo)).toBe(git(repo, ['rev-parse', 'main']).trim());
    expect(reasons).toEqual(['noCommits']);
    expect(await service.getCurrentBranch(repo)).toBe('fresh');
  });

  it('still throws for a ref that does not exist', async () => {
    const repo = initRepo('bad-ref');
    write(repo, 'a.txt', 'a\n');
    commitAll(repo, 'root');
    await expect(new GitService().getMergeBase('nope', repo)).rejects.toBeInstanceOf(GitError);
  });

  it('works in a repo with no commits at all', async () => {
    const repo = initRepo('empty');
    const service = new GitService();
    expect(await service.listBranches(repo)).toEqual([]);
    expect(await service.listTags(repo)).toEqual([]);
    expect(await service.getCurrentBranch(repo)).toBe('main');
    await expect(service.getMergeBase('main', repo)).rejects.toBeInstanceOf(GitError);
  });
});

describe('GitService with refs that look like options', () => {
  // A fetched remote (or `update-ref`) can create a ref whose short name starts with `-`; passed to
  // git as a bare argument it would be parsed as an option — `--output=<file>` makes git write a file.
  let repo: string;
  const service = new GitService();
  const evil = '--output=pwned.txt';
  const evilBranch = '--output=pwned-branch.txt';

  beforeAll(() => {
    repo = initRepo('option-refs');
    write(repo, 'a.txt', 'one\n');
    commitAll(repo, 'first');
    write(repo, 'a.txt', 'two\n');
    commitAll(repo, 'second');
    git(repo, ['update-ref', `refs/tags/${evil}`, 'HEAD~1']);
    git(repo, ['update-ref', `refs/heads/${evilBranch}`, 'HEAD~1']);
  });

  it('is a real hazard without --end-of-options (control)', () => {
    const control = path.join(scratch, 'control-out.txt');
    try {
      git(repo, ['rev-list', '--left-right', '--count', `--output=${control}`, 'HEAD']);
    } catch {
      // Whether or not git then complains, the written file is what matters.
    }
    expect(fs.existsSync(control)).toBe(true);
  });

  it('leaves such refs out of the branch and tag listings', async () => {
    expect((await service.listBranches(repo)).map((branch) => branch.name)).toEqual(['main']);
    expect(await service.listTags(repo)).toEqual([]);
  });

  it('never lets git parse such a ref as an option', async () => {
    const first = git(repo, ['rev-parse', 'HEAD~1']).trim();
    // Each call treats the name as a revision — none of them may write the file.
    expect(await service.getAheadBehind(evil, repo)).toEqual({ behind: 0, ahead: 1 });
    expect(await service.getMergeBase(evil, repo)).toBe(first);
    expect((await service.getChangedFiles(evil, repo)).map((file) => file.path)).toEqual(['a.txt']);
    expect(await service.getFileContentAtRef(evil, 'a.txt', repo)).toBe('one\n');
    expect(await service.getBlameAtRef(evil, 'a.txt', repo)).toHaveLength(1);
    expect(await service.getChangedLineRanges(evil, 'a.txt', repo)).toEqual([{ start: 1, end: 1 }]);
    await expect(service.getFileContentAtRef(evil, 'missing.txt', repo)).rejects.toBeInstanceOf(PathNotAtRefError);
    expect(await service.resolveCommit(evil, repo)).toBeUndefined();
    expect(await service.getAheadBehind(evilBranch, repo)).toEqual({ behind: 0, ahead: 1 });
    expect(fs.existsSync(path.join(repo, 'pwned.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'pwned-branch.txt'))).toBe(false);
  });
});
