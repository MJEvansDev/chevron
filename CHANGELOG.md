# Changelog

All notable changes to Chevron are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## 1.0.0

Initial public release.

### Added

- **Compare with any branch, tag or commit.** A picker grouping local branches, remote-tracking
  branches, tags and other worktrees, plus free-form entry of any ref or commit SHA.
- **Merge-base ("three-dot") diffing**, so only your side's changes since divergence are shown.
- **Changed-files view** in its own Activity Bar container: status colours matching Source Control,
  untracked files, `+added −deleted` line counts, ahead/behind counts, auto-refresh on save, commit,
  checkout and pull, and Copy Relative Path / Reveal in Explorer.
- **`← Take from <branch>`** on every changed hunk of a Chevron diff: replaces the hunk with the
  branch's version in one undoable edit, and refuses to apply if the file changed underneath it.
- **Next / Previous Change across files** (`Alt+F7` / `Shift+Alt+F7`), rolling over into the next
  changed file.
- **Diff Current File Against Branch** (`Ctrl/Cmd+K Shift+D`) in VS Code's native diff editor, with
  unsaved edits.
- **Blame**: hover on either side of a diff; optional margin annotations on changed lines
  (`Ctrl/Cmd+K Shift+B`).
- **Live worktree comparison** against another `git worktree` checkout's files on disk.
- **Multi-root workspaces and multiple repositories**: each repository keeps its own comparison;
  the view follows the active editor's repository, with `Chevron: Select Repository` to switch.
- **Settings** for the default comparison branch (auto-selected on first use: `origin/HEAD`'s
  target, then `main`, then `master`, never the checked-out branch itself), blame defaults and date
  format, untracked files, tree or flat-list layout, and take-from-branch.
- Honours VS Code's `git.path` setting.

### Robustness

- Merge-base results cached per comparison and HEAD.
- Git failures are reported instead of being shown as an empty diff; shallow clones and unrelated
  histories fall back to diffing against the ref tip, with a warning.
- Paths with spaces and non-ASCII names, renames and CRLF files handled; binary files show a
  placeholder instead of raw bytes.
- Auto-refresh works inside worktrees and submodules.
- Large repositories: the tree is capped at 5,000 files and blame skips very large files.
- A comparison branch deleted since it was selected is cleared, rather than failing silently.

### Notes

- Chevron was developed under the name *BranchDiff* before its first public release.
