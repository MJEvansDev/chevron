// Builds the scratch git repo the integration suite opens as its workspace.
// Rebuilt fresh on every `test:integration` run — nothing here is checked into git.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '.vscode-test', 'fixture-repo');
const originRoot = path.join(here, '..', '..', '.vscode-test', 'fixture-origin.git');
const worktreeRoot = path.join(here, '..', '..', '.vscode-test', 'fixture-worktree');

function git(args) {
  execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
}

fs.rmSync(repoRoot, { recursive: true, force: true });
fs.mkdirSync(repoRoot, { recursive: true });
fs.rmSync(originRoot, { recursive: true, force: true });
fs.rmSync(worktreeRoot, { recursive: true, force: true });
execFileSync('git', ['init', '--bare', '-b', 'main', originRoot], { stdio: 'ignore' });

git(['init', '-b', 'main']);
git(['config', 'user.email', 'chevron-test@example.com']);
git(['config', 'user.name', 'Chevron Test']);
// Keep line endings byte-for-byte as written below (crlf.txt must stay CRLF on every platform).
git(['config', 'core.autocrlf', 'false']);

fs.writeFileSync(path.join(repoRoot, 'file.txt'), 'original\n');
// Multi-hunk and CRLF files for the `← Take from <branch>` / change-navigation tests
// (takeFromBranch.test.ts) — changed below in the "changes on main" commit, so against
// `other-branch` (whose merge-base with main is this initial commit) they diff as:
//   hunks.txt: a modification (line 2), a pure deletion (line 5), a pure addition (after line 8).
//   crlf.txt:  a one-line modification in a CRLF file.
const hunksBase = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
fs.writeFileSync(path.join(repoRoot, 'hunks.txt'), hunksBase.join('\n') + '\n');
fs.writeFileSync(path.join(repoRoot, 'crlf.txt'), 'alpha\r\nbeta\r\ngamma\r\n');
// Renamed on main below — enough identical content that rename detection (-M) pairs the two paths.
fs.writeFileSync(
  path.join(repoRoot, 'to-rename.txt'),
  Array.from({ length: 20 }, (_, i) => `rename me, line ${i + 1}`).join('\n') + '\n',
);
// Spaces in both the directory and file name, and a non-ASCII name — both modified on main below,
// to exercise `-z` path parsing and `git show <sha>:<path>` with awkward paths.
fs.mkdirSync(path.join(repoRoot, 'dir with space'));
fs.writeFileSync(path.join(repoRoot, 'dir with space', 'file with space.txt'), 'before\n');
fs.writeFileSync(path.join(repoRoot, 'ünïcödé.txt'), 'unicode before\n');
git(['add', '.']);
git(['commit', '-m', 'initial commit']);

// An annotated tag on the fork point — the "Tags" section of the branch picker, and a comparison
// target that has to be peeled to a commit (`^{commit}`) to resolve.
git(['tag', '-a', 'v0.1', '-m', 'first tag']);

git(['branch', 'other-branch']);

// Selected by the integration suite and then deleted out from under the extension, to check a
// stored comparison target that no longer resolves gets cleared rather than erroring forever.
git(['branch', 'doomed-branch']);

// Pushed here, before the "changes on main" commit below, so `origin/main` stays behind local
// `main` — giving the integration suite a remote-tracking branch with a real diff to compare
// against, the same way `other-branch` does for local branches.
git(['remote', 'add', 'origin', originRoot]);
git(['push', 'origin', 'main']);

// A commit that exists only on `other-branch`, made *after* it forked from `main` — this gives
// `other-branch` and `main` a real common-ancestor-then-diverge shape (rather than one simply
// being an ancestor of the other), so tests can confirm the merge-base ("three-dot") diff
// excludes `other-branch-only.txt`: a naive two-dot `git diff other-branch` would wrongly show
// it as deleted, since it exists on other-branch's tip but not on main.
git(['checkout', 'other-branch']);
fs.writeFileSync(path.join(repoRoot, 'other-branch-only.txt'), 'only on other-branch\n');
git(['add', '.']);
git(['commit', '-m', 'commit only on other-branch']);
git(['checkout', 'main']);

fs.writeFileSync(path.join(repoRoot, 'file.txt'), 'changed on main\n');
fs.writeFileSync(path.join(repoRoot, 'new-file.txt'), 'added on main\n');
fs.writeFileSync(
  path.join(repoRoot, 'hunks.txt'),
  [
    'line 1',
    'line 2 changed on main',
    'line 3',
    'line 4',
    'line 6',
    'line 7',
    'line 8',
    'added on main',
    'line 9',
    'line 10',
  ].join('\n') + '\n',
);
fs.writeFileSync(path.join(repoRoot, 'crlf.txt'), 'alpha\r\nBETA on main\r\ngamma\r\n');
git(['mv', 'to-rename.txt', 'renamed.txt']);
fs.writeFileSync(path.join(repoRoot, 'dir with space', 'file with space.txt'), 'after\n');
fs.writeFileSync(path.join(repoRoot, 'ünïcödé.txt'), 'unicode after\n');
git(['add', '.']);
git(['commit', '-m', 'changes on main']);

// Never `git add`-ed — exercises the untracked-files path, which a plain `git diff --name-status`
// never reports.
fs.writeFileSync(path.join(repoRoot, 'untracked.txt'), 'never added\n');

// A second checkout of the same repo, on its own branch — exercises the "Worktrees" section of
// the branch picker (see branchOrdering.ts's labelWorktrees / gitService.listWorktrees), which
// should offer this as a pick distinct from (but resolving to the same branch as) the plain
// "worktree-branch" entry `listBranches` already surfaces under "Local".
git(['branch', 'worktree-branch']);
git(['worktree', 'add', worktreeRoot, 'worktree-branch']);

// Uncommitted state in the worktree itself, never staged or committed there — the whole point of
// a worktree comparison is a live filesystem-to-filesystem diff, so tests
// need something in the *other* worktree's on-disk state that a diff against a committed ref
// could never see.
fs.writeFileSync(path.join(worktreeRoot, 'file.txt'), 'changed in worktree, uncommitted\n');
fs.writeFileSync(path.join(worktreeRoot, 'worktree-untracked.txt'), 'never added in the worktree\n');

// ---------------------------------------------------------------------------------------------
// Multi-root fixture (test/integration-multiroot, the "multiroot" config in .vscode-test.mjs):
// a .code-workspace with two repos, a second folder inside repo-a (must dedupe to one repo), and a
// folder that isn't a repo at all (must be skipped — .vscode-test.mjs sets GIT_CEILING_DIRECTORIES
// to multiRoot so git doesn't find the Chevron checkout this all lives inside).
//
//   repo-a: checked out on `feature`, forked from `main`. No stored target → auto-selects `main`.
//   repo-b: checked out on `main`, plus a `release` branch; no `origin`. Auto-selection must not
//           pick `main` (the checked-out branch — an empty diff), and there's no `origin/main`
//           or `master`, so repo-b starts with no target.
// Its user-data dir (workspaceState) is wiped here too, so every run starts with no stored targets.
const multiRoot = path.join(here, '..', '..', '.vscode-test', 'multiroot');
const multiRootUserData = path.join(here, '..', '..', '.vscode-test', 'user-data-multiroot');
fs.rmSync(multiRoot, { recursive: true, force: true });
fs.rmSync(multiRootUserData, { recursive: true, force: true });

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'chevron-test@example.com']);
  run(['config', 'user.name', 'Chevron Test']);
  run(['config', 'core.autocrlf', 'false']);
  return run;
}

const repoA = path.join(multiRoot, 'repo-a');
const gitA = initRepo(repoA);
fs.writeFileSync(path.join(repoA, 'a.txt'), 'a on main\n');
fs.mkdirSync(path.join(repoA, 'nested', 'deeper'), { recursive: true });
fs.writeFileSync(path.join(repoA, 'nested', 'deeper', 'n.txt'), 'nested on main\n');
gitA(['add', '.']);
gitA(['commit', '-m', 'repo-a initial']);
gitA(['checkout', '-b', 'feature']);
fs.writeFileSync(path.join(repoA, 'a.txt'), 'a on feature\n');
fs.writeFileSync(path.join(repoA, 'nested', 'deeper', 'n.txt'), 'nested on feature\n');
gitA(['add', '.']);
gitA(['commit', '-m', 'repo-a feature work']);

const repoB = path.join(multiRoot, 'repo-b');
const gitB = initRepo(repoB);
fs.writeFileSync(path.join(repoB, 'b.txt'), 'b at release\n');
gitB(['add', '.']);
gitB(['commit', '-m', 'repo-b initial']);
gitB(['branch', 'release']);
fs.writeFileSync(path.join(repoB, 'b.txt'), 'b on main\n');
fs.mkdirSync(path.join(repoB, 'src'));
fs.writeFileSync(path.join(repoB, 'src', 'added.txt'), 'added on main\n');
gitB(['add', '.']);
gitB(['commit', '-m', 'repo-b main work']);
// Untracked — for chevron.showUntrackedFiles.
fs.writeFileSync(path.join(repoB, 'b-untracked.txt'), 'never added\n');

fs.mkdirSync(path.join(multiRoot, 'not-a-repo'));
fs.writeFileSync(path.join(multiRoot, 'not-a-repo', 'readme.txt'), 'not in any repository\n');

fs.writeFileSync(
  path.join(multiRoot, 'multiroot.code-workspace'),
  JSON.stringify(
    {
      folders: [{ path: 'repo-a' }, { path: 'repo-b' }, { path: 'repo-a/nested' }, { path: 'not-a-repo' }],
      settings: {},
    },
    null,
    2,
  ) + '\n',
);
