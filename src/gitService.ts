import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BlameLine, ChangedFile, GitFileStatus, LineRange } from './types';
import { isSamePath } from './pathUtils';

/** Cap on a single git invocation's stdout — see `GitError`'s `'maxBuffer'` kind. */
export const GIT_MAX_BUFFER_BYTES = 1024 * 1024 * 32;

/**
 * The git binary to run. Defaults to `git` on `PATH`; `extension.ts` overrides it from the user's
 * `git.path` setting via `setGitBinary` (resolved there with `pickGitBinary`). Module-level config
 * rather than a `vscode` lookup so this file stays free of runtime `vscode` imports (and so
 * Vitest-importable) — see SKILL.md.
 */
let gitBinary = 'git';

export function setGitBinary(binary: string | undefined): void {
  gitBinary = binary || 'git';
}

export function getGitBinary(): string {
  return gitBinary;
}

/**
 * Picks the git binary from VS Code's `git.path` setting, which may be unset, a single path, or
 * an array of candidate paths (first one that exists wins — same semantics as the built-in Git
 * extension). Falls back to plain `git` (resolved via `PATH`) when nothing usable is configured.
 */
export function pickGitBinary(setting: unknown, exists: (candidate: string) => boolean): string {
  const candidates = Array.isArray(setting) ? setting : [setting];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '' && exists(candidate.trim())) {
      return candidate.trim();
    }
  }
  return 'git';
}

/**
 * Prepended to every invocation: stops git octal-escaping non-ASCII bytes in paths it prints
 * (`"\303\274.txt"`). Commands whose path output is actually parsed also use `-z`, which disables
 * quoting entirely; this covers everything else (e.g. blame's `filename` lines).
 */
const GLOBAL_ARGS = ['-c', 'core.quotepath=off'];

export type GitErrorKind =
  /** git ran and exited non-zero. */
  | 'git'
  /** The git binary couldn't be spawned at all (missing, or a bad `git.path`). */
  | 'notFound'
  /** Output exceeded `GIT_MAX_BUFFER_BYTES` — e.g. a diff across tens of thousands of files. */
  | 'maxBuffer';

export class GitError extends Error {
  constructor(
    message: string,
    readonly kind: GitErrorKind,
    readonly exitCode?: number,
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Thrown by `getFileContentAtRef` when the path genuinely doesn't exist at that ref — the one
 * failure where an empty pane is the right answer (the file was added on this side). Every other
 * failure is a real `GitError` and must not be rendered as an empty file.
 */
export class PathNotAtRefError extends Error {
  constructor(
    readonly ref: string,
    readonly relativePath: string,
  ) {
    super(`'${relativePath}' does not exist at ${ref}`);
    this.name = 'PathNotAtRefError';
  }
}

/**
 * Turns `execFile`'s callback error into a `GitError` with a user-presentable message. Pure so it's
 * unit-testable: `execFile` reports a spawn failure as a string `code` (`ENOENT`), an overflowing
 * buffer as `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, and a non-zero exit as a numeric `code`.
 */
export function classifyExecError(
  error: { code?: unknown; message: string },
  stderr: string,
  args: string[],
  binary: string,
): GitError {
  const code = error.code;
  if (code === 'ENOENT' || code === 'EACCES') {
    return new GitError(
      `Could not run git ('${binary}'). Is git installed, and is the "git.path" setting correct?`,
      'notFound',
    );
  }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    const subcommand = args.find((arg) => !arg.startsWith('-')) ?? '';
    return new GitError(
      `git ${subcommand} produced more than ${GIT_MAX_BUFFER_BYTES / (1024 * 1024)} MB of output — this comparison is too large to display.`,
      'maxBuffer',
    );
  }
  const trimmed = stripCarriageReturns(stderr).trim();
  return new GitError(trimmed || error.message, 'git', typeof code === 'number' ? code : undefined, trimmed);
}

/** Git for Windows can emit CRLF in its own messages; every parser here assumes LF. */
function stripCarriageReturns(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Runs git via `execFile` (never `exec` — no shell interpolation). `allowedExitCodes` lists
 * non-zero exit codes that are *not* errors for this call (see `runGitDiffNoIndex`). Every
 * rejection is a `GitError`.
 */
function runGitWithExitCodes(args: string[], cwd: string, allowedExitCodes: number[]): Promise<string> {
  const binary = gitBinary;
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...GLOBAL_ARGS, ...args],
      { cwd, maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const errorLike = error as unknown as { code?: unknown; message: string };
          if (typeof errorLike.code === 'number' && allowedExitCodes.includes(errorLike.code)) {
            resolve(stdout);
            return;
          }
          reject(classifyExecError(errorLike, stderr, args, binary));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function runGit(args: string[], cwd: string): Promise<string> {
  return runGitWithExitCodes(args, cwd, []);
}

/**
 * Like `runGit`, but for `git diff --no-index` invocations: `--no-index` mimics the classic
 * `diff` utility's exit codes (0 = identical, 1 = differences found, >1 = a real error), unlike
 * every other git subcommand this file calls, which exits 0 regardless of whether the diff itself
 * is empty. Treating exit 1 as an error (as `runGit` does) would make every worktree-to-worktree
 * diff that actually finds a difference look like a failure.
 */
function runGitDiffNoIndex(args: string[], cwd: string): Promise<string> {
  return runGitWithExitCodes(args, cwd, [1]);
}

/** Splits `-z` output into its NUL-terminated fields (dropping the empty tail after the last NUL). */
export function splitNul(output: string): string[] {
  if (output === '') {
    return [];
  }
  const fields = output.split('\0');
  if (fields[fields.length - 1] === '') {
    fields.pop();
  }
  return fields;
}

/** Placeholder side for a `--no-index` diff against a file that doesn't exist on one side, mimicking classic `diff`'s use of `/dev/null` for an add/delete. */
function nullDevice(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

async function pathExists(fsPath: string): Promise<boolean> {
  try {
    await fs.access(fsPath);
    return true;
  } catch {
    return false;
  }
}

/** `true` if two files' contents are byte-identical. Missing/unreadable files are never treated as identical. */
async function filesAreIdentical(a: string, b: string): Promise<boolean> {
  try {
    const [bufA, bufB] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return bufA.equals(bufB);
  } catch {
    return false;
  }
}

/** Untracked files larger than this don't get a line count (reading them isn't worth it). */
export const MAX_UNTRACKED_COUNT_BYTES = 2 * 1024 * 1024;
/** At most this many untracked files get a line count per refresh — the tree is truncated well before this matters. */
export const MAX_UNTRACKED_COUNTED_FILES = 5000;

/**
 * Line count for an untracked file's `+N` in the tree, or `undefined` for binary content — using
 * git's own heuristic (a NUL byte in the first 8000 bytes means binary), so untracked files render
 * the same way `--numstat` renders tracked ones. A final line without a trailing newline counts.
 */
export function countTextLines(content: Uint8Array): number | undefined {
  const sniff = Math.min(content.length, 8000);
  for (let i = 0; i < sniff; i++) {
    if (content[i] === 0) {
      return undefined;
    }
  }
  let lines = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0x0a) {
      lines++;
    }
  }
  if (content.length > 0 && content[content.length - 1] !== 0x0a) {
    lines++;
  }
  return lines;
}

async function countUntrackedLines(fsPath: string): Promise<number | undefined> {
  try {
    const stat = await fs.lstat(fsPath);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_COUNT_BYTES) {
      return undefined; // symlink, directory (e.g. a nested repo), or too big to be worth reading
    }
    return countTextLines(await fs.readFile(fsPath));
  } catch {
    return undefined;
  }
}

/** `Promise.all(items.map(fn))` with at most `limit` in flight — avoids EMFILE across thousands of files. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Why `getMergeBase` fell back to the ref's tip instead of a real merge-base. */
export type MergeBaseFallbackReason =
  /** No common ancestor: unrelated histories, or a shallow clone cut off before the fork point. */
  | 'noCommonAncestor'
  /** HEAD has no commits yet (fresh repo, or an `--orphan` branch). */
  | 'noCommits';

export type MergeBaseFallbackListener = (ref: string, reason: MergeBaseFallbackReason) => void;

export interface BranchRef {
  name: string;
  remote: boolean;
}

export interface AheadBehind {
  /** Commits reachable from the comparison branch but not from HEAD. */
  behind: number;
  /** Commits reachable from HEAD but not from the comparison branch. */
  ahead: number;
}

export interface WorktreeRef {
  /** Absolute path to the worktree's directory. */
  path: string;
  /** Branch checked out there — absent for a detached HEAD worktree. */
  branch?: string;
  /** HEAD commit SHA — used as the comparison target when `branch` is absent. */
  head: string;
}

export interface GitDirs {
  /** This worktree's own git dir — where `HEAD` and `index` live. */
  gitDir: string;
  /** The repository's shared git dir — where `refs/` and `packed-refs` live. Same as `gitDir` outside a linked worktree. */
  commonDir: string;
}

export interface ChangedFilesOptions {
  /** Include files never `git add`-ed (the `chevron.showUntrackedFiles` setting). Default `true`. */
  includeUntracked?: boolean;
}

/**
 * Whether `ref` would be parsed by git as an option rather than a revision (`--output=/some/file`).
 * `git branch`/`git tag` refuse such names, but a fetched remote or `update-ref` can still create
 * one — so they're dropped from listings and refused as comparison targets, and every revision
 * argument is additionally passed after `END_OF_OPTIONS`.
 */
export function looksLikeOption(ref: string): boolean {
  return ref.startsWith('-');
}

/**
 * Ends option parsing, so a revision that starts with `-` can never be read as an option. Every
 * command that parses revisions (`setup_revisions`/`parse_options`) supports it since git 2.24 —
 * Chevron's minimum. (`rev-parse` only learned it in 2.30, so `resolveCommit` rejects `-` refs
 * itself instead.)
 */
const END_OF_OPTIONS = '--end-of-options';

/** Most tags the branch picker lists (newest first); older ones are still reachable via "Enter a ref…". */
export const MAX_PICKER_TAGS = 200;

export class GitService {
  /** cwd → HEAD's commit SHA (`undefined` for a repo/branch with no commits yet). */
  private readonly headCache = new Map<string, Promise<string | undefined>>();
  /** `cwd \0 ref \0 headSha` → merge-base SHA (or the ref's tip, on fallback). */
  private readonly mergeBaseCache = new Map<string, Promise<string>>();
  private mergeBaseFallbackListener?: MergeBaseFallbackListener;

  /**
   * Drops the cached HEAD SHA and merge-bases. Called from `extension.ts`'s `scheduleRefresh`
   * whenever `.git` changes (HEAD moved, refs updated by a fetch/commit/branch delete) — the cache
   * key already includes HEAD's SHA, but that SHA is itself cached, and a ref can move without HEAD
   * moving.
   */
  invalidateCache(): void {
    this.headCache.clear();
    this.mergeBaseCache.clear();
  }

  /** Called (once per cache entry) when `getMergeBase` has to fall back to the ref's tip — lets the UI warn without this file importing `vscode`. */
  setMergeBaseFallbackListener(listener: MergeBaseFallbackListener | undefined): void {
    this.mergeBaseFallbackListener = listener;
  }

  async getRepoRoot(cwd: string): Promise<string> {
    const out = await runGit(['rev-parse', '--show-toplevel'], cwd);
    // git prints `C:/repo` on Windows; normalize to the platform's separators so `path.join` and
    // `Uri.file` round-trip cleanly.
    return path.normalize(out.trim());
  }

  /** The real git directories — `.git` is a *file* pointing elsewhere in a linked worktree or a submodule. */
  async getGitDirs(cwd: string): Promise<GitDirs> {
    const out = await runGit(['rev-parse', '--absolute-git-dir', '--git-common-dir'], cwd);
    const [gitDir, commonDir] = out.split(/\r?\n/).map((line) => line.trim());
    return {
      gitDir: path.normalize(gitDir),
      // `--git-common-dir` is relative to cwd unless it's somewhere else entirely.
      commonDir: path.resolve(cwd, commonDir || gitDir),
    };
  }

  /** Current branch's short name, or `''` for a detached HEAD. Works in a repo with no commits yet (unlike `rev-parse --abbrev-ref HEAD`). */
  async getCurrentBranch(cwd: string): Promise<string> {
    try {
      const out = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], cwd);
      return out.trim();
    } catch (error) {
      if (error instanceof GitError && error.kind !== 'git') {
        throw error;
      }
      return ''; // detached HEAD
    }
  }

  /**
   * What `origin/HEAD` points at, as a short name (e.g. `origin/main`), or `undefined` when it isn't
   * set — it only exists after a `git clone` or `git remote set-head origin --auto`.
   */
  async getOriginHead(cwd: string): Promise<string | undefined> {
    try {
      const out = await runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd);
      return out.trim() || undefined;
    } catch (error) {
      if (error instanceof GitError && error.kind !== 'git') {
        throw error;
      }
      return undefined;
    }
  }

  /**
   * Resolves `ref` (branch, tag, SHA, `HEAD~2`, …) to a commit SHA, or `undefined` if it doesn't
   * name a commit. Used to validate typed-in refs and to revalidate a stored comparison target.
   */
  async resolveCommit(ref: string, cwd: string): Promise<string | undefined> {
    if (ref.trim() === '' || looksLikeOption(ref)) {
      return undefined; // would be parsed as an option, not a ref
    }
    try {
      const out = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
      return out.trim() || undefined;
    } catch (error) {
      if (error instanceof GitError && error.kind !== 'git') {
        throw error;
      }
      return undefined;
    }
  }

  /** Local branches plus remote-tracking branches (e.g. `origin/main`), most recently committed first. */
  async listBranches(cwd: string): Promise<BranchRef[]> {
    const out = await runGit(
      [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname)\t%(refname:short)',
        'refs/heads/',
        'refs/remotes/',
      ],
      cwd,
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [fullName, shortName] = line.split('\t');
        return { name: shortName, remote: fullName.startsWith('refs/remotes/') };
      })
      .filter((branch) => !branch.name.endsWith('/HEAD')) // e.g. origin/HEAD — a symbolic ref, not a real branch
      .filter((branch) => !looksLikeOption(branch.name));
  }

  /** Tag names, newest first, capped at `limit`. */
  async listTags(cwd: string, limit = MAX_PICKER_TAGS): Promise<string[]> {
    const out = await runGit(
      ['for-each-ref', '--sort=-creatordate', `--count=${limit}`, '--format=%(refname:short)', 'refs/tags/'],
      cwd,
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name !== '' && !looksLikeOption(name));
  }

  /**
   * Other worktrees attached to this repo (`git worktree add`), excluding this one and any bare
   * repo entry. Each is resolved down to the branch it has checked out (or, for a detached HEAD,
   * its commit SHA) for display in the branch picker's "Worktrees" section — see
   * `branchOrdering.ts`'s `labelWorktrees` for how a pick
   * from that section becomes a live filesystem-to-filesystem comparison via
   * `getChangedFilesBetweenWorktrees`, rather than a plain branch comparison.
   */
  async listWorktrees(cwd: string): Promise<WorktreeRef[]> {
    const [out, repoRoot] = await Promise.all([
      runGit(['worktree', 'list', '--porcelain'], cwd),
      this.getRepoRoot(cwd),
    ]);
    return parseWorktreeList(out)
      .map((worktree) => ({ ...worktree, path: path.normalize(worktree.path) }))
      .filter((worktree) => !isSamePath(worktree.path, repoRoot));
  }

  private getHeadSha(cwd: string): Promise<string | undefined> {
    let head = this.headCache.get(cwd);
    if (!head) {
      head = this.resolveCommit('HEAD', cwd);
      this.cacheUnlessRejected(this.headCache, cwd, head);
    }
    return head;
  }

  /** Stores `promise` under `key`, removing it again if it rejects — a transient failure shouldn't be cached. */
  private cacheUnlessRejected<T>(cache: Map<string, Promise<T>>, key: string, promise: Promise<T>): void {
    cache.set(key, promise);
    promise.catch(() => {
      if (cache.get(key) === promise) {
        cache.delete(key);
      }
    });
  }

  /**
   * The merge-base of `ref` and HEAD — the commit they last shared before diverging. Diffing
   * against this instead of `ref`'s tip gives a three-dot-style diff (only what's changed on
   * *this* side since the branches diverged), matching what GitLens/IntelliJ show by default,
   * rather than also surfacing everything the other branch has done since — a two-dot diff would.
   *
   * Cached per (ref, HEAD SHA) — every diff pane, blame and changed-lines lookup needs it, so
   * re-shelling for each was a spawn storm. See `invalidateCache`.
   *
   * When there is no merge-base (unrelated histories, a shallow clone, or HEAD has no commits
   * yet), falls back to `ref`'s tip and notifies the fallback listener, rather than failing every
   * operation outright. An invalid ref still throws.
   */
  async getMergeBase(ref: string, cwd: string): Promise<string> {
    const head = await this.getHeadSha(cwd);
    const key = `${cwd}\0${ref}\0${head ?? ''}`;
    let base = this.mergeBaseCache.get(key);
    if (!base) {
      base = this.computeMergeBase(ref, cwd, head);
      this.cacheUnlessRejected(this.mergeBaseCache, key, base);
    }
    return base;
  }

  private async computeMergeBase(ref: string, cwd: string, head: string | undefined): Promise<string> {
    if (head) {
      try {
        const out = await runGit(['merge-base', END_OF_OPTIONS, ref, 'HEAD'], cwd);
        return out.trim();
      } catch (error) {
        // Exit 1 with nothing on stderr is merge-base's "no common ancestor" answer; anything else
        // (exit 128 for an unknown ref, a missing binary, …) is a real failure.
        if (!(error instanceof GitError && error.kind === 'git' && error.exitCode === 1 && !error.stderr)) {
          throw error;
        }
      }
    }
    const tip = await this.resolveCommit(ref, cwd);
    if (!tip) {
      throw new GitError(`'${ref}' is not a valid branch, tag or commit.`, 'git');
    }
    this.mergeBaseFallbackListener?.(ref, head ? 'noCommonAncestor' : 'noCommits');
    return tip;
  }

  /** How far HEAD and `branch` have diverged, in commit counts (same numbers `git status` shows for a tracking branch). */
  async getAheadBehind(branch: string, cwd: string): Promise<AheadBehind> {
    const out = await runGit(['rev-list', '--left-right', '--count', END_OF_OPTIONS, `${branch}...HEAD`], cwd);
    const [behind, ahead] = out.trim().split(/\s+/).map(Number);
    return { behind: behind || 0, ahead: ahead || 0 };
  }

  /** Files never `git add`-ed, excluding anything .gitignore'd. */
  async getUntrackedFiles(cwd: string): Promise<string[]> {
    const out = await runGit(['ls-files', '-z', '--others', '--exclude-standard'], cwd);
    return splitNul(out);
  }

  /**
   * Changed files: working tree (including uncommitted changes) vs the merge-base with `branch`.
   * One `git diff -z --raw --numstat` pass gives both the authoritative status/paths (raw records,
   * with rename detection) and the line counts (numstat records), merged by path in
   * `parseDiffRawNumstat`. Untracked files are appended with status `U` and a line count.
   */
  async getChangedFiles(branch: string, cwd: string, options: ChangedFilesOptions = {}): Promise<ChangedFile[]> {
    const includeUntracked = options.includeUntracked ?? true;
    const base = await this.getMergeBase(branch, cwd);
    const [diffOut, untracked] = await Promise.all([
      runGit(['diff', '--no-ext-diff', '-z', '-M', '--raw', '--numstat', END_OF_OPTIONS, base, '--'], cwd),
      includeUntracked ? this.getUntrackedFiles(cwd) : Promise.resolve([]),
    ]);

    const files = parseDiffRawNumstat(diffOut);

    const counts = await mapWithConcurrency(untracked.slice(0, MAX_UNTRACKED_COUNTED_FILES), 16, (relativePath) =>
      countUntrackedLines(path.join(cwd, relativePath)),
    );
    untracked.forEach((relativePath, index) => {
      const additions = counts[index];
      files.push(
        additions === undefined ? { status: 'U', path: relativePath } : { status: 'U', path: relativePath, additions, deletions: 0 },
      );
    });

    return files;
  }

  /**
   * If `relativePath` was renamed since the merge-base with `branch`, its path there — else
   * `undefined`. Needs the whole diff: a pathspec would hide the old path from rename detection.
   */
  async getPreviousPath(branch: string, relativePath: string, cwd: string): Promise<string | undefined> {
    const files = await this.getChangedFiles(branch, cwd, { includeUntracked: false });
    return files.find((file) => file.status === 'R' && file.path === relativePath)?.previousPath;
  }

  /**
   * File content as it exists at the merge-base with `branch`. Throws `PathNotAtRefError` if the
   * path doesn't exist there (the caller should show an empty pane), or a `GitError` for any real
   * failure (bad ref, missing git, …) — callers must not render those as an empty file.
   */
  async getFileContentAtRef(branch: string, relativePath: string, cwd: string): Promise<string> {
    const base = await this.getMergeBase(branch, cwd);
    try {
      return await runGit(['show', END_OF_OPTIONS, `${base}:${relativePath}`], cwd);
    } catch (error) {
      if (error instanceof GitError && error.kind === 'git' && !(await this.pathExistsAtCommit(base, relativePath, cwd))) {
        throw new PathNotAtRefError(branch, relativePath);
      }
      throw error;
    }
  }

  /**
   * Whether `relativePath` exists as a file in `commit`'s tree. Asked structurally (via `ls-tree`)
   * rather than by pattern-matching `git show`'s error text, which is localized.
   */
  private async pathExistsAtCommit(commit: string, relativePath: string, cwd: string): Promise<boolean> {
    try {
      const out = await runGit(['ls-tree', '-z', '--name-only', END_OF_OPTIONS, commit, '--', relativePath], cwd);
      return splitNul(out).includes(relativePath);
    } catch {
      return true; // can't tell — let the original error surface rather than claim "absent"
    }
  }

  /**
   * Per-line blame for the working tree — including uncommitted edits, which `git blame` reports
   * with an all-zero hash and author "Not Committed Yet" rather than omitting them. Used for the
   * local (working-tree) pane of the diff editor. Throws if the path isn't tracked by git.
   */
  async getBlame(relativePath: string, cwd: string): Promise<BlameLine[]> {
    const out = await runGit(['blame', '--line-porcelain', '--', relativePath], cwd);
    return parseBlamePorcelain(out);
  }

  /**
   * Per-line blame for the file as it exists at the merge-base with `branch` — matches the
   * content `getFileContentAtRef` serves for that same pane, rather than blaming the branch's
   * raw tip. Throws if the file doesn't exist there.
   */
  async getBlameAtRef(branch: string, relativePath: string, cwd: string): Promise<BlameLine[]> {
    const base = await this.getMergeBase(branch, cwd);
    // No `END_OF_OPTIONS`: `blame` rejects it. `base` is always a hex SHA from `getMergeBase`, never the raw ref.
    const out = await runGit(['blame', '--line-porcelain', base, '--', relativePath], cwd);
    return parseBlamePorcelain(out);
  }

  /**
   * Which lines of the working-tree copy of `relativePath` are added/modified relative to the
   * merge-base with `branch`, as inclusive 1-based ranges — used to restrict blame annotations to
   * changed lines instead of the whole file. New-side ranges only: annotations only ever render
   * on the working-tree pane (see `BlameAnnotationController`), so the old/branch-side ranges
   * `parseUnifiedDiffHunks` can also produce aren't needed here.
   */
  async getChangedLineRanges(branch: string, relativePath: string, cwd: string): Promise<LineRange[]> {
    const base = await this.getMergeBase(branch, cwd);
    const out = await runGit(['diff', '--no-ext-diff', '--unified=0', END_OF_OPTIONS, base, '--', relativePath], cwd);
    const ranges: LineRange[] = [];
    for (const hunk of parseUnifiedDiffHunks(out)) {
      if (hunk.new) {
        ranges.push(hunk.new);
      }
    }
    return ranges;
  }

  /**
   * Every file git considers part of a worktree: committed files (`ls-files`) plus
   * untracked-but-not-ignored ones (`getUntrackedFiles`). `git diff --no-index` doesn't know
   * about `.gitignore` or `.git/` itself — diffing two worktree directories wholesale would
   * surface every ignored file and the entire contents of `.git/` as "changes" — so the candidate
   * file list for a worktree-to-worktree diff has to come from each worktree's own git
   * bookkeeping instead.
   */
  private async listAllFiles(cwd: string, includeUntracked: boolean): Promise<Set<string>> {
    const [trackedOut, untracked] = await Promise.all([
      runGit(['ls-files', '-z'], cwd),
      includeUntracked ? this.getUntrackedFiles(cwd) : Promise.resolve([]),
    ]);
    return new Set([...splitNul(trackedOut), ...untracked]);
  }

  /**
   * Changed files between this worktree and another one — a live filesystem-to-filesystem diff,
   * not a diff against a committed ref, so the other worktree's own uncommitted edits show up
   * too. Unlike `getChangedFiles`, there
   * is no rename detection (each file is compared independently, with nothing to key a rename
   * off) and no merge-base (two working directories don't have one, only their respective
   * branches' tips do).
   *
   * Content equality is checked with a direct file read (`filesAreIdentical`) rather than
   * shelling out to `git diff --no-index` for every candidate — most files in a large repo
   * are unchanged, and spawning a git process per file just to learn that would be needlessly
   * expensive. `--no-index` is only invoked for files that actually differ (or are add/delete-
   * only), to get real `+added -deleted` counts via `parseNumstat`.
   */
  async getChangedFilesBetweenWorktrees(
    otherPath: string,
    cwd: string,
    options: ChangedFilesOptions = {},
  ): Promise<ChangedFile[]> {
    const includeUntracked = options.includeUntracked ?? true;
    const [mine, theirs] = await Promise.all([
      this.listAllFiles(cwd, includeUntracked),
      this.listAllFiles(otherPath, includeUntracked),
    ]);
    const allPaths = new Set([...mine, ...theirs]);
    const devNull = nullDevice();

    const results = await mapWithConcurrency(
      Array.from(allPaths),
      16,
      async (relativePath): Promise<ChangedFile | undefined> => {
        const inMine = mine.has(relativePath);
        const inTheirs = theirs.has(relativePath);
        const mineFile = path.join(cwd, relativePath);
        const theirsFile = path.join(otherPath, relativePath);

        if (inMine && inTheirs && (await filesAreIdentical(mineFile, theirsFile))) {
          return undefined;
        }

        const oldSide = inTheirs ? theirsFile : devNull;
        const newSide = inMine ? mineFile : devNull;
        const numstatOut = await runGitDiffNoIndex(['diff', '--no-ext-diff', '--no-index', '--numstat', '--', oldSide, newSide], cwd);
        const [stat] = parseNumstat(numstatOut);
        const status: GitFileStatus = !inTheirs ? 'A' : !inMine ? 'D' : 'M';
        return { status, path: relativePath, additions: stat?.additions, deletions: stat?.deletions };
      },
    );

    return results.filter((file): file is ChangedFile => file !== undefined);
  }

  /**
   * Which lines of the working-tree copy of `relativePath` differ from another worktree's copy,
   * as inclusive 1-based ranges — the worktree-comparison counterpart to `getChangedLineRanges`,
   * used to restrict blame annotations to changed lines when the comparison target is a worktree
   * rather than a branch. New-side ranges only, same as `getChangedLineRanges`.
   */
  async getChangedLineRangesAgainstWorktree(otherPath: string, relativePath: string, cwd: string): Promise<LineRange[]> {
    const otherFile = path.join(otherPath, relativePath);
    const thisFile = path.join(cwd, relativePath);
    const oldSide = (await pathExists(otherFile)) ? otherFile : nullDevice();

    const out = await runGitDiffNoIndex(['diff', '--no-ext-diff', '--no-index', '--unified=0', '--', oldSide, thisFile], cwd);
    const ranges: LineRange[] = [];
    for (const hunk of parseUnifiedDiffHunks(out)) {
      if (hunk.new) {
        ranges.push(hunk.new);
      }
    }
    return ranges;
  }
}

/** Maps git's raw diff status letters onto the subset the tree renders. */
function toFileStatus(letter: string): GitFileStatus {
  switch (letter) {
    case 'A':
    case 'C': // copy: the destination is a new file
      return 'A';
    case 'D':
      return 'D';
    case 'R':
      return 'R';
    default:
      return 'M'; // M, T (type change), U (unmerged), X
  }
}

/**
 * Parses `git diff -z --raw --numstat` output: first one raw record per file
 * (`:<modes> <shas> <STATUS>\0<path>\0`, or `...R<score>\0<old>\0<new>\0` for a rename/copy), then
 * one numstat record per file (`<added>\t<deleted>\t<path>\0`, or `<added>\t<deleted>\t\0<old>\0<new>\0`
 * for a rename/copy). Raw records are authoritative for status and paths; numstat counts are
 * attached by (new) path, not by position. `-` counts (binary files) become `undefined`.
 *
 * `-z` means paths are emitted verbatim — no C-quoting of spaces/non-ASCII, and no
 * `old => new`/`dir/{old => new}` rename notation to untangle.
 */
export function parseDiffRawNumstat(output: string): ChangedFile[] {
  const fields = splitNul(output);
  const files: ChangedFile[] = [];
  const counts = new Map<string, { additions?: number; deletions?: number }>();

  let i = 0;
  while (i < fields.length) {
    const field = fields[i++];
    if (field.startsWith(':')) {
      const letter = field.split(' ').pop()?.charAt(0) ?? 'M';
      if (letter === 'R' || letter === 'C') {
        const previousPath = fields[i++];
        const newPath = fields[i++];
        files.push(
          letter === 'R'
            ? { status: 'R', previousPath, path: newPath }
            : { status: toFileStatus(letter), path: newPath },
        );
      } else {
        files.push({ status: toFileStatus(letter), path: fields[i++] });
      }
      continue;
    }

    const [addedRaw, deletedRaw, inlinePath] = field.split('\t');
    if (deletedRaw === undefined) {
      continue; // not a numstat record — ignore rather than misparse
    }
    let statPath = inlinePath;
    if (inlinePath === '') {
      i++; // rename/copy: skip the old path, key by the new one
      statPath = fields[i++];
    }
    counts.set(statPath, {
      additions: addedRaw === '-' ? undefined : Number(addedRaw),
      deletions: deletedRaw === '-' ? undefined : Number(deletedRaw),
    });
  }

  for (const file of files) {
    const stat = counts.get(file.path);
    if (stat) {
      file.additions = stat.additions;
      file.deletions = stat.deletions;
    }
  }
  return files;
}

/**
 * Parses `git worktree list --porcelain` output: entries separated by blank lines, each a
 * `worktree <path>` line followed by `HEAD <sha>` and either `branch refs/heads/<name>`,
 * `detached`, or `bare`. Bare-repo entries are dropped (no working tree to compare against).
 */
export function parseWorktreeList(output: string): WorktreeRef[] {
  const entries: WorktreeRef[] = [];
  let worktreePath: string | undefined;
  let head: string | undefined;
  let branch: string | undefined;
  let bare = false;

  const flush = () => {
    if (worktreePath && head && !bare) {
      entries.push({ path: worktreePath, head, branch });
    }
    worktreePath = undefined;
    head = undefined;
    branch = undefined;
    bare = false;
  };

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      worktreePath = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      bare = true;
    }
  }
  flush();

  return entries;
}

interface NumstatEntry {
  additions?: number;
  deletions?: number;
}

/**
 * Parses newline-separated `git diff --numstat` output into per-line add/delete counts, in file
 * order. Binary files report `-` for both counts, which becomes `undefined` here. Only used for
 * the single-file `--no-index` diffs in `getChangedFilesBetweenWorktrees`, where the path column is
 * a pair of absolute paths and irrelevant; branch diffs use `parseDiffRawNumstat` instead, which
 * keys counts by path.
 */
export function parseNumstat(output: string): NumstatEntry[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [addedRaw, deletedRaw] = line.split('\t');
      const additions = addedRaw === '-' ? undefined : Number(addedRaw);
      const deletions = deletedRaw === '-' ? undefined : Number(deletedRaw);
      return { additions, deletions };
    });
}

const BLAME_HEADER_RE = /^([0-9a-f]{7,64}) \d+ (\d+)(?: \d+)?$/;

/**
 * Parses `git blame --line-porcelain` output. `--line-porcelain` (vs. plain `--porcelain`)
 * repeats the full commit metadata block for every blamed line rather than only the first time a
 * commit is seen — this parser tolerates either shape: it only overwrites a commit's cached
 * metadata when a metadata line is actually present, so a header with no metadata block (the
 * plain-`--porcelain` case) still resolves via the previously-seen block for that hash.
 */
export function parseBlamePorcelain(output: string): BlameLine[] {
  const lines = output.split(/\r?\n/);
  const metaByHash = new Map<string, { author: string; committer: string; authorTime: number; summary: string }>();
  const result: BlameLine[] = [];

  let i = 0;
  while (i < lines.length) {
    const header = BLAME_HEADER_RE.exec(lines[i]);
    if (!header) {
      i++;
      continue;
    }
    const hash = header[1];
    const finalLine = Number(header[2]);
    i++;

    let meta = metaByHash.get(hash);
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const line = lines[i];
      if (line.startsWith('author ')) {
        meta = meta ?? { author: '', committer: '', authorTime: 0, summary: '' };
        meta.author = line.slice('author '.length);
      } else if (line.startsWith('author-time ')) {
        meta = meta ?? { author: '', committer: '', authorTime: 0, summary: '' };
        meta.authorTime = Number(line.slice('author-time '.length));
      } else if (line.startsWith('committer ')) {
        meta = meta ?? { author: '', committer: '', authorTime: 0, summary: '' };
        meta.committer = line.slice('committer '.length);
      } else if (line.startsWith('summary ')) {
        meta = meta ?? { author: '', committer: '', authorTime: 0, summary: '' };
        meta.summary = line.slice('summary '.length);
      }
      i++;
    }
    if (i < lines.length && lines[i].startsWith('\t')) {
      i++; // consume the content line
    }

    if (meta) {
      metaByHash.set(hash, meta);
      result.push({ line: finalLine, hash, ...meta });
    }
  }

  return result;
}

export interface DiffHunk {
  /** Range in the pre-image (merge-base) file this hunk touches — absent for a pure addition. */
  old?: LineRange;
  /** Range in the post-image (working-tree/branch-tip) file this hunk touches — absent for a pure deletion. */
  new?: LineRange;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses `git diff --unified=0` hunk headers (`@@ -oldStart[,oldCount] +newStart[,newCount] @@`)
 * into old/new line ranges. `--unified=0` (no context lines) means every hunk is exactly the
 * changed lines, so no filtering of unchanged context lines is needed here. A count is omitted by
 * git when it's 1 (defaults applied below); a count of 0 means that side contributed no lines to
 * the hunk (a pure addition has no `old` range, a pure deletion has no `new` range).
 */
export function parseUnifiedDiffHunks(output: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (const line of output.split('\n')) {
    const match = HUNK_HEADER_RE.exec(line);
    if (!match) {
      continue;
    }
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    hunks.push({
      old: oldCount > 0 ? { start: oldStart, end: oldStart + oldCount - 1 } : undefined,
      new: newCount > 0 ? { start: newStart, end: newStart + newCount - 1 } : undefined,
    });
  }
  return hunks;
}

export default new GitService();
