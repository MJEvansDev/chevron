---
name: vscode-extension-dev
description: >
  Conventions for developing the Chevron VS Code extension in this repo — manifest shape,
  esbuild bundling, git plumbing, UI idioms, the Vitest/Extension-Host test split, and packaging.
  Use when adding or changing anything under src/, test/, package.json's contributes block,
  esbuild.js, or the test setup. No external skill covers VS Code extension authoring
  specifically (checked the official Anthropic marketplace and community directories — nothing
  trustworthy exists for this niche) — this skill is this repo's substitute for one.
---

# Chevron — VS Code Extension Conventions

Chevron is a local-only git diff tool: compare the working tree to any branch, at single-file
or whole-project scope, on top of VS Code's native diff editor. It is deliberately **not**
attempting IntelliJ-parity fidelity — no word/char intraline highlighting beyond VS Code's own,
no Local History integration, no browser/PR review. Commit history, interactive rebase, stash
management, a 3-way merge UI and move detection aren't ruled out but aren't planned either (see
`CONTRIBUTING.md` → "Not in 1.0, but possible later"). If a change starts drifting toward any of
these, stop and confirm scope before building it.

## Package management: pnpm, always

`pnpm install` / `pnpm add -D <dep>` / `pnpm run <script>` — never `npm`/`yarn`/`npx`. This is a
cross-project standard for this user, not specific to this repo.

## Manifest (`package.json` → `contributes`)

- `activationEvents: []` — commands/views declared under `contributes` activate the extension
  implicitly on modern VS Code. Never add `*` or manually list `onCommand:*` entries.
- Command IDs are namespaced `chevron.<verb>` (e.g. `chevron.diffCurrentFile`). Internal
  commands not meant for the palette (`chevron.openFileDiff`) still get a `title` for the
  manifest but aren't added to `menus.commandPalette`.
- The changed-files tree has its **own `contributes.viewsContainers.activitybar` entry** (id
  `chevron`, icon `resources/chevron-icon.svg`), not the built-in `scm` container. It
  started nested inside Source Control (conceptually closer to IntelliJ's "Compare Branches"
  placement) but moved out for two concrete reasons: (1) VS Code's manifest has **no field to
  order a view relative to another extension's or a built-in view sharing the same container** —
  when the user asked to place it above the built-in "Graph" view, there was no declarative way
  to do that inside `scm`, only by not sharing it; (2) it was easy to miss among other sections
  (GitLens, Graph, Changes). Don't move it back into `scm` without solving both problems first.
- The view itself (`chevron.changedFilesView`) has **no `when` clause** — it's the only thing
  in its own container, so there's no reason to hide it. The "no branch selected" prompt is
  instead a `viewsWelcome` entry with its own `when: "!chevron.hasComparisonBranch"`. This
  matters: a view's own `when` and a `viewsWelcome` targeting it are two different gates — a
  welcome entry can never show while the view itself is hidden by its own `when`, so if a future
  change reintroduces a `when` on the view, the welcome prompt becomes permanently unreachable.
  `chevron.hasComparisonBranch` still exists and still gets set by `comparisonState.setTarget`
  — it now only drives the welcome content (and the navigation keybindings), not view
  visibility. It reflects the **active repo's** target (`ComparisonState.updateContextKey`).
- `chevron.multipleRepositories` (set by `RepositoryManager` after discovery) gates everything
  repo-picker-related — `chevron.selectRepository` in the palette and view title, and a second
  welcome entry. With one repo, the UI is exactly the single-repo UI.
- Settings live under `contributes.configuration` (title "Chevron") and are read through
  `src/settings.ts` **at the point of use**, never cached; `extension.ts`'s
  `onDidChangeConfiguration` handler redraws whatever a change affects. Current settings:
  `chevron.defaultComparisonBranch` (resource-scoped — read with the repo root as scope),
  `chevron.autoSelectComparisonBranch`, `chevron.blame.annotationsEnabledByDefault`,
  `chevron.blame.dateFormat`, `chevron.showUntrackedFiles`, `chevron.treeLayout` (window-scoped;
  the `chevron.viewAsList`/`viewAsTree` view-title pair toggles it via `when:
  config.chevron.treeLayout …`), `chevron.takeFromBranch.enabled`. Add new ones the same way, and
  add them to the README's settings table.

## Bundling: esbuild, not webpack

- `esbuild.js` is a script (not bare CLI flags) so watch/production/sourcemap modes are
  scriptable — see the file for the exact `esbuild.context()` config (`bundle: true, external:
  ['vscode'], platform: 'node', format: 'cjs'`).
- Because esbuild inlines all dependencies into `dist/extension.js` at build time, pnpm's strict
  (symlinked, non-hoisted) `node_modules` layout is a non-issue — resolution happens once at
  build time, not at extension runtime. Don't second-guess this if a dependency "seems missing"
  at runtime; check the esbuild bundle output first.
- `tsconfig.json` is `noEmit: true` — TypeScript is type-checking only (`pnpm run check-types`).
  A separate `tsconfig.test.json` (`noEmit: false, outDir: out`) exists solely to compile test
  files to JS for the Mocha-based integration runner — see Testing below.

## Git plumbing (`src/gitService.ts`)

- Shell out via `child_process.execFile('git', [...args], { cwd })` — **never** `exec` (avoids
  shell-interpolation/quoting issues) and **never** a library like `simple-git` (unnecessary
  dependency surface for a handful of stable CLI outputs).
- Parsing logic (`parseDiffRawNumstat`, `parseNumstat`, `parseBlamePorcelain`, …) is a pure exported function specifically so
  it's testable under Vitest without touching the `vscode` module — keep that separation when
  adding new git plumbing. If a new git operation needs parsing, write the parser as a standalone
  pure function next to the command that calls it.
- Diffing is merge-base-based, not against the raw branch tip: `getChangedFiles` and
  `getFileContentAtRef` both call `getMergeBase(branch, cwd)` (`git merge-base branch HEAD`)
  first and diff against that commit, not `branch` directly. This is deliberate — a straight
  `git diff branch` (two-dot) also surfaces the comparison branch's own commits since divergence
  as if they were part of your diff, which is wrong when the branches have actually diverged
  rather than one being a strict ancestor of the other (the common case, where the two forms
  coincide). Don't reintroduce a raw-tip diff without discussing the tradeoff first.
- `getChangedFiles` makes two git calls: a single `git diff -z -M --raw --numstat <base> --`
  (raw records give the authoritative status/paths, including renames; numstat records give line
  counts) and `ls-files -z --others --exclude-standard` (untracked files, synthesized as status
  `U` — plain `git diff` never reports these at all). `parseDiffRawNumstat` attaches counts to
  files **by (new) path**, not by position, so a missing or reordered numstat record only loses
  that one file's counts. `-z` is what makes path keying reliable: paths come out verbatim (no
  C-quoting of spaces/non-ASCII, no `old => new` / `dir/{old => new}` rename notation — a rename's
  numstat record is `a\td\t\0old\0new\0`). Don't go back to parsing the non-`-z` form. Untracked
  files get `+N` from `countTextLines` (git's binary heuristic: a NUL in the first 8000 bytes →
  no counts), skipped for symlinks and files over `MAX_UNTRACKED_COUNT_BYTES`.
- Every invocation goes through `runGitWithExitCodes`, which prepends `-c core.quotepath=off`,
  uses `execFile(gitBinary, …)` where `gitBinary` is injected from `extension.ts` via
  `setGitBinary(pickGitBinary(<git.path setting>, exists))` (string or string[]; first existing
  wins; falls back to `git` on `PATH`) — keep gitService.ts free of runtime `vscode` imports — and
  rejects only with a `GitError` whose `kind` is `'git'` (non-zero exit; `exitCode`/`stderr`
  kept), `'notFound'` (binary couldn't spawn) or `'maxBuffer'` (output over
  `GIT_MAX_BUFFER_BYTES`). Callers that need to tell failures apart switch on `kind`/`exitCode`,
  never on stderr text (it's localized).
- **Refs are untrusted input.** A fetched remote can bring a ref whose short name starts with `-`
  (`--output=/some/file`), which git would parse as an option. So: every revision argument goes
  after `END_OF_OPTIONS` (`--end-of-options`, git ≥ 2.24 — except `blame`, which rejects it and
  only ever gets a merge-base SHA, and `rev-parse`, which only learned it in 2.30, so
  `resolveCommit` rejects `-` refs itself); `listBranches`/`listTags` drop such names
  (`looksLikeOption`); and `ComparisonState` refuses/ignores such a branch target. Keep all three
  when adding a git call that takes a ref.
- `getMergeBase` is cached per `(cwd, ref, HEAD sha)` (HEAD's SHA is itself cached per cwd).
  `gitService.invalidateCache()` drops both — `extension.ts` calls it at the start of every
  `scheduleRefresh()` and in the manual refresh. When there's no merge-base (exit 1 with empty
  stderr: unrelated histories or a shallow clone; or HEAD has no commits yet) it falls back to the
  ref's tip and calls the listener set via `setMergeBaseFallbackListener` — `extension.ts` turns
  that into a one-time warning per ref. An invalid ref still throws.
- `getFileContentAtRef` throws `PathNotAtRefError` only when `ls-tree` confirms the path is absent
  at the merge-base; `BranchContentProvider` renders exactly that case as an empty pane. Every other
  failure is reported (deduplicated toast, `errorReporting.ts`) and rethrown — never render a git
  failure as an empty file, that's a diff claiming every line is new.
- Path comparisons: use `relativePathInside`/`isSamePath` (`src/pathUtils.ts`) rather than
  `path.relative(...).startsWith('..')` — git prints `C:/repo` on Windows, `Uri.fsPath` gives
  `c:\repo`, and a different-drive target makes `path.relative` return an absolute path.
  `getRepoRoot` and `listWorktrees` `path.normalize` what git prints.
- `vscode.diff` needs two resolvable `vscode.Uri`s. The "branch" side is served by
  `BranchContentProvider` (`src/branchContentProvider.ts`), a `TextDocumentContentProvider`
  registered under the custom `chevron-ref` scheme; it runs `git show <branch>:<path>`. Its URI
  is `chevron-ref:/<path>?branch=<ref>&repo=<repo root>` (`branchRefUri`/`parseBranchRefUri`) —
  the repo is in the URI because with several repos open the pane must read from the repo the
  diff was opened for, not whichever is active later; `chevron-empty` URIs carry `repo=` too.
  The URI names the ref, not the merge-base, so its content changes when the merge-base moves:
  `refreshNow()` calls `BranchContentProvider.refreshOpenDocuments()` (fires `onDidChange` for every
  open `chevron-ref` document) after invalidating the cache — otherwise VS Code keeps the first
  snapshot and `← Take from` would revert the other branch's own changes. Old-side text read from
  git/disk for comparison against a document goes through `stripBom` (VS Code strips the BOM).
  The provider only runs git in a repo `RepositoryManager.knownRepo` recognizes — a URI is
  user-reachable input, and git in an arbitrary directory honours that directory's config. A
  binary file (NUL in the first 8000 bytes) renders as `BINARY_PANE_PLACEHOLDER`
  (`hunkApply.branchPaneText`), and `isUntakeableOldText` stops take/navigation treating that
  placeholder as content. The "local" side is always the real `file://` URI so unsaved edits
  show up live — don't read file contents manually for that side.
- `getChangedFiles` / `getChangedFilesBetweenWorktrees` take `{ includeUntracked }`
  (`chevron.showUntrackedFiles`); callers that list files for the user (tree, change navigation)
  pass the setting so both agree on the same file list.

## UI idioms

- Branch selection: `vscode.window.showQuickPick`, wrapped in `src/branchPicker.ts`. Don't
  inline `showQuickPick` calls elsewhere — route through this module so it stays the single
  place a test needs to stub (see Testing).
- The picker's item-ordering/labeling logic (sort the current comparison branch to the top,
  `$(check)` prefix, "currently comparing"/"current branch" descriptors) lives in
  `src/branchOrdering.ts` as a **pure function** (`orderAndLabelBranches`), deliberately split out
  of `branchPicker.ts`. This isn't just style: `branchPicker.ts` has a runtime `import * as vscode
  from 'vscode'` (for the actual `showQuickPick` call), and ES module imports are evaluated
  eagerly regardless of whether the import is used — so *any* logic living in a file with a
  runtime `vscode` import is unreachable from Vitest, even logic that itself never touches
  `vscode`. `branchOrdering.ts` only has `import type * as vscode from 'vscode'` (type-only,
  erased at build time), which is what makes it Vitest-testable. When adding new logic that needs
  `vscode.QuickPickItem`/`vscode.TreeItem`/etc. *types* but not the runtime module, follow this
  pattern rather than adding to a file that already has a runtime `vscode` import.
  `orderAndLabelBranches` returns a plain discriminated union (`BranchRow | SeparatorRow`), not
  `vscode.QuickPickItem`s directly — `branchPicker.ts` is what maps a `SeparatorRow` to
  `{ kind: vscode.QuickPickItemKind.Separator }` and a `BranchRow` to a real `QuickPickItem` with
  a `vscode.ThemeIcon`, since both of those are runtime `vscode` values, not just types.
- `gitService.listBranches` returns `BranchRef[]` (`{ name, remote }`), tagged from the *full*
  refname (`refs/heads/...` vs `refs/remotes/...`) at the source rather than guessing from the
  short name — a local branch can itself contain a `/` (e.g. `feature/foo`), so classifying by
  string shape alone would misfire.
- The changed-files tree's `message` (shown when a comparison branch has zero differences) and
  header (branch name + ahead/behind counts) are both set from *inside*
  `ChangedFilesTreeProvider.getChildren()`, via a `TreeView` reference the provider holds after
  `extension.ts` calls `treeProvider.attachTreeView(treeView)` post-construction (the `TreeView`
  can't exist before the provider does, so it can't be constructor-injected). Do this rather than
  duplicating the git calls needed to word them at a second call site — `getChildren` already has
  the data. The wording is pure (`src/treeDescription.ts`, Vitest-tested): single repo
  `main  ↓3 ↑5` (unchanged from before multi-repo), several repos `repo-name · main  ↓3 ↑5`.
  It goes in the view's **`title`**, not its `description` (`ChangedFilesTreeProvider.setHeader`
  sets one and clears the other): the view is alone in its container, so VS Code merges its
  header into the container's — "CHEVRON: MAIN ↓3 ↑5" — and never shows a description. Tests
  assert on `api.treeView.title`.
  `chevron.treeLayout: "list"` swaps `buildChangedFilesTree` for `buildChangedFilesList` (flat,
  sorted by path, `FileNode.directory` shown in the item description) via
  `buildChangedFilesLayout` — change navigation uses the same layout so "next file" matches the
  view's order.
- Auto-refresh has two triggers, both landing on `treeProvider.refresh()` through a single
  300ms-debounced `scheduleRefresh()` in `extension.ts` (so e.g. a `git checkout` touching several
  ref files in quick succession doesn't fire several back-to-back refreshes): file-system watchers
  on `{HEAD,index}` in the git dir and `{refs/**,packed-refs}` in the common dir, both resolved
  with `git rev-parse --absolute-git-dir --git-common-dir` (in a linked worktree or submodule
  `.git` is a *file*, so a `<root>/.git/...` pattern never fires; one watcher set per known repo,
  kept in step with discovery by `GitRefWatchers.sync` — see `createGitRefWatcher`), and
  `vscode.workspace.onDidSaveTextDocument`. The manual
  `chevron.refreshChangedFiles` command stays un-debounced (it's a deliberate user action, not a
  batch of filesystem events). Both paths go through `refreshNow()`, which invalidates the
  merge-base cache and revalidates **every repo's** stored comparison target first: a
  branch/tag/SHA that no longer resolves (or a worktree directory that's gone) is cleared via
  `comparisonState.clearTarget(repoRoot)` (fires `onDidClearComparisonTarget`, not
  `onDidChangeComparisonTarget` — the latter's listeners can rely on a defined target), with an
  info message, bringing back the welcome view. Discovery (`rediscover()`) does the same check.
- The branch picker's first row is "$(edit) Enter a tag, commit SHA or ref…" (`alwaysShow`, so
  typing a SHA doesn't filter it out), which opens an InputBox validated by `validateRefSyntax`
  then `gitService.resolveCommit` (`rev-parse --verify --quiet <ref>^{commit}`). Tags get their own
  "Tags" section (newest first, capped at `MAX_PICKER_TAGS`). Both store a plain
  `{ kind: 'branch', name }` target — every branch-target git call takes any commit-ish — and
  `comparisonTargetLabel` abbreviates a full SHA to 7 characters.
- Performance guards live in `src/limits.ts`: no blame (hover or annotations) above
  `MAX_BLAME_LINES`/`MAX_BLAME_CHARS` (`BlameSource.isTooLarge`), and the tree renders at most
  `MAX_TREE_FILES` files with a "Showing the first N of M" view message. `getChildren` never
  rejects: a git failure becomes the view message plus a deduplicated toast.
- Context-menu commands on tree items (`chevron.copyRelativePath`,
  `chevron.revealInExplorer`, wired via `contributes.menus["view/item/context"]` gated on
  `viewItem == chevron.file`) receive the raw `TreeNode` element as their first argument —
  that's different from `item.command.arguments` (used for the tree item's own click-to-diff
  command), which explicitly passes `[element.path, repoRoot, element.previousPath]`. Don't assume
  the two commands' arg shapes match.
- **Renames.** `FileNode.previousPath` (from `parseDiffRawNumstat`) is threaded through the tree
  item, `chevron.openFileDiff`, `diffOpener.openFileDiff` (the `chevron-ref` pane reads
  `previousPath ?? path`) and change navigation; `diffCurrentFile` and navigation's git fallback
  look it up with `gitService.getPreviousPath`. Take reads the pane, so it works unchanged.
- Status colors in the changed-files tree (`src/diffTreeProvider.ts`) use the same theme color
  tokens VS Code's own git decorations use — `gitDecoration.addedResourceForeground` /
  `modifiedResourceForeground` / `deletedResourceForeground` / `renamedResourceForeground` —
  applied via `new vscode.ThemeIcon(id, new vscode.ThemeColor(token))`. This colors the status
  icon only, not the label text (there's no public `TreeItem` API for per-item label color; that
  would require a custom `FileDecorationProvider`, which was deliberately avoided here since one
  registered for `file://` URIs would recolor the Explorer/editor tabs globally based on
  Chevron's branch comparison, not just this tree — a bigger footprint than asked for).
- **Repositories (multi-root / multi-repo).** `src/repositoryManager.ts` owns the list of open
  repos and the *active* one. Discovery shells out — `git rev-parse --show-toplevel` per
  workspace folder, deduplicated, non-repos skipped — deliberately *not* the `vscode.git`
  extension API (no soft dependency). It re-runs on
  `onDidChangeWorkspaceFolders` and `git.path` changes. The active repo follows the active
  editor (`followEditor`: a document in a known repo — `file://` inside it, or a
  `chevron-ref`/`chevron-empty` pane naming it — makes that repo active; anything else leaves
  it), can be picked with `chevron.selectRepository`, and is remembered in `workspaceState`. The
  pure parts (dedupe, deepest-containing-repo lookup, display names, storage key, active-repo
  choice) are in `src/repositories.ts`, Vitest-tested.
  **Rule of thumb for consumers:** anything about a *document* (blame, changed lines, hunks/take,
  navigation from an editor, `diffCurrentFile`, the branch pane) uses
  `repositories.repoForUri(document.uri)` and `comparisonState.getTarget(thatRepo)`; anything
  about *the view* (tree, `selectCompareBranch`, tree-item commands, `showChangedFilesTree`) uses
  `repositories.activeRepository` / `comparisonState.target`. Never reach for "the" repo root —
  there isn't one. `chevron.openFileDiff` takes `(relativePath, repoRoot?)`; pass the repo.
- Shared "what am I comparing against" state lives in `src/comparisonState.ts`, **one target per
  repo root** in `workspaceState` under `chevron.comparisonTarget:<repoStateKey(root)>` (a
  pre-multi-repo single `chevron.comparisonTarget` value is migrated to the first repo on
  discovery). `getTarget(root)` / `setTarget(root, target, { automatic? })` /
  `clearTarget(root)`; the `target` getter is the active repo's. Events carry `{ repoRoot,
  target, automatic }` / `{ repoRoot }`. The state is a
  `ComparisonTarget` (`src/types.ts`): a discriminated union of `{ kind: 'branch'; name }` and
  `{ kind: 'worktree'; path; label }`, not a plain branch-name string — see "Worktree comparison"
  below. Any new UI entry point that needs the comparison target should read
  `comparisonState.getTarget(repo)` and, if unset, prompt via `branchPicker` and call
  `comparisonState.setTarget(repo, …)` — never maintain a second copy of this state, and never
  assume it's a branch without checking `target.kind` first.
- Auto-selection (`chevron.autoSelectComparisonBranch`, default on): a repo with no stored target
  gets `chevron.defaultComparisonBranch` if it resolves, else (setting empty) `origin/HEAD`'s
  target, then `main`, then `master` — never the checked-out branch itself (becomes
  `origin/<branch>`). Candidate order is the pure `defaultComparisonCandidates`
  (`src/defaultBranch.ts`). It runs for repos first seen by a discovery (awaited in `activate`, so
  it can't land after the user's first pick) and when either setting changes — *not* after a
  target was cleared because its branch vanished. It sets `automatic: true`, which suppresses
  the view reveal.
- `extension.ts` has a single `comparisonState.onDidChangeComparisonTarget` listener that, for
  the active repo, both sets the view header (`syncTreeDescription` → `treeProvider.setHeader`) and reveals
  the tree (`chevron.changedFilesView.focus`, skipped for `automatic` changes) — this fires for
  *every* path that changes the
  target (explicit select, or the implicit first-pick inside `diffCurrentFile`), so don't
  duplicate that reveal/description logic in individual command handlers. Note
  `vscode.EventEmitter.fire()` doesn't await async listeners — `comparisonState.setTarget()`
  resolves once the synchronous part of the listener has run (so `treeView.title` is
  reliably set by then) but the `.focus()` call may still be in flight; a test asserting
  `treeView.visible` needs to poll rather than
  assert immediately (see Testing).
- Whole-project tree: `src/diffTreeProvider.ts` wraps the pure `buildChangedFilesTree` function
  (`src/treeBuilder.ts`, also Vitest-tested) as a `vscode.TreeDataProvider`. Tree items route
  through the shared `src/diffOpener.ts` helper — the same one `diffCurrentFile` uses — so there
  is exactly one place that calls `vscode.commands.executeCommand('vscode.diff', ...)`.

## `← Take from <branch>` and change navigation

- Hunks for both features come from `src/lineDiff.ts` — a pure-TS Myers line diff of the old
  side's text against `document.getText()` — **not** from `git diff` on disk, because "take" edits
  the live buffer and the buffer may be dirty. Lines compare as tokens (content + normalized `\n`
  if terminated), which makes CRLF-vs-LF invisible and "no newline at end of file" a real change.
  The edit math and stale checks are in `src/hunkApply.ts`, ordering in `src/changeNavigation.ts`
  — all vscode-free and unit-tested; keep it that way, this is the code that writes user files.
- Lenses (`src/takeFromBranch.ts`) are only provided for a `file://` document that is the
  *modified* side of an open diff tab whose *original* side is Chevron's (`chevron-ref`, or a file
  in the current worktree target) — found via `vscode.window.tabGroups` in `src/hunkSource.ts` —
  and the old text is read from that tab's original document, i.e. exactly what the left pane
  shows. Not offered when the other side is missing/empty (added/untracked files) or binary.
- Applying never trusts the lens's hunk: it recomputes the diff, requires an identical hunk
  (same positions and text on both sides), re-checks the range text, then applies one
  `WorkspaceEdit` (one undo step, no save) with no `await` in between; otherwise it bails.
- VS Code hides CodeLenses in diff editors unless `diffEditor.codeLens` is on (default off).
  Chevron offers to turn it on once rather than overriding the default for every diff editor.

## Worktree comparison

Read this before touching any of it. A worktree target is a genuinely different
diff *engine* (live filesystem-to-filesystem, via `git diff --no-index`) rather than just another
entry that resolves to a branch name. Load-bearing points not to relitigate:

- `getChangedFilesBetweenWorktrees`/`getChangedLineRangesAgainstWorktree` (`src/gitService.ts`)
  never diff the two worktree directories wholesale — `--no-index` doesn't know about
  `.gitignore` or `.git/` itself, so a directory-level diff surfaces every ignored file and the
  entire contents of `.git/` as "changes." The candidate file list always comes from each
  worktree's own `ls-files`/untracked-files output instead.
- Content equality between the two worktrees' copies of a file is checked with a direct
  `fs.readFile` + `Buffer.equals` (`filesAreIdentical`), not by shelling out to `git diff
  --no-index` for every candidate — most files in a real repo are unchanged, and spawning a git
  process per file just to learn that would be needlessly expensive. `--no-index` is only invoked
  for files that actually differ (to get real `+added -deleted` counts via the same `parseNumstat`
  `getChangedFiles` already uses).
- There's no rename detection and no merge-base for a worktree target — neither is fixable without a fundamentally different approach. Don't add ahead/behind counts
  for a worktree target either; two working directories don't have the single divergence number
  `getAheadBehind` computes between two branches (only their respective branches' tips do), so
  `ChangedFilesTreeProvider` deliberately skips that suffix for `{ kind: 'worktree' }` targets.
- The diff editor's "other side" for a worktree target is a real `file://` URI straight into the
  other worktree's directory (`diffOpener.ts`'s `openWorktreeFileDiff`) — not a `git show`
  snapshot — so its own uncommitted edits show up, and it's a real editable document. When that
  file doesn't exist there (add/delete relative to the other worktree), it falls back to
  `emptyContentProvider.ts`'s `chevron-empty` scheme, the same "missing shows as empty"
  convention `BranchContentProvider` uses for a file missing at a ref.
- `BlameSource.resolveRequest` (`src/blameSource.ts`) recognizes a `file://` document outside
  every open repo but under some repo's worktree target directory and blames it the same way as
  the local pane (plain `getBlame`, cwd'd at that worktree) rather than needing the `'ref'`
  treatment a branch comparison's other side gets — this is what makes hover blame work on both
  sides of a worktree diff. `BlameAnnotationController`'s margin annotations stay local-pane-only
  regardless, via `ChangedLinesSource` gating on the document being inside an open repo (not a
  comparison target's directory) — see that class's doc comment.

## Testing: Vitest for unit tests, `@vscode/test-electron` only where it can't be avoided

This split is a **technical constraint**, not a style choice: the `vscode` module only exists
inside the Electron-hosted Extension Development Host that `@vscode/test-electron` launches.
Vitest runs in plain Node and cannot import or mock a working `vscode` module for anything that
needs real editor/window/command behavior.

- `test/unit/*.spec.ts` — pure-logic tests, run by **Vitest** (`pnpm run test:unit`). Anything
  that doesn't import `vscode` belongs here: git output parsing, the tree builder, URI
  encode/decode helpers. When adding logic, default to writing it as a pure function specifically
  so it lands in this bucket rather than the slower integration suite.
  `test/unit/gitService.repo.spec.ts` also lives here: it drives `GitService` against real scratch
  repos in `os.tmpdir()` (renames, spaces/non-ASCII, tags, unrelated histories, orphan branches,
  linked worktrees) — it needs only a `git` binary, not `vscode`, so it's the fast way to check
  git-plumbing behaviour without an Extension Host.
- `test/integration/*.test.ts` — tests that need a live `vscode` module (command registration,
  `vscode.diff` actually opening an editor tab, tree rendering), run via `@vscode/test-cli` +
  `@vscode/test-electron` (`pnpm run test:integration`). Written with Mocha's `tdd` interface
  (`suite`/`test`/`suiteSetup` globals — no import needed, configured in `.vscode-test.mjs`).
  - `suiteSetup` **must** explicitly activate the extension
    (`await vscode.extensions.getExtension('MJEvansDev.chevron')?.activate()`) before any
    assertion that depends on registered commands — contributed commands don't reliably show up
    in `vscode.commands.getCommands()` before the extension has actually run its
    `registerCommand` calls. This bit a first draft of the suite; don't remove it.
  - To drive a command that would otherwise show a `QuickPick`, monkey-patch
    `vscode.window.showQuickPick` for the duration of the test (cast through `unknown`, VS Code's
    overloaded signature won't cast directly) and restore it in a `finally` block — the shared
    `stubQuickPickSelection(label)` helper in `test/integration/extension.test.ts` does this.
    There's no other way to script QuickPick selection in these tests.
  - `activate()` returns a `ChevronApi` (`{ comparisonState, treeView, treeProvider, repositories }`),
    retrievable in tests via
    `vscode.extensions.getExtension<ChevronApi>('MJEvansDev.chevron')!.activate()`. This
    is the sanctioned way to get test-only introspection into extension internals (VS Code's own
    docs pattern) — use it rather than exporting internals some other way, and extend the
    interface if a test needs to reach something new. `treeProvider` in particular is what lets a
    test call `getChildren()` directly to inspect the changed-files tree's actual contents
    (statuses, untracked files) rather than only asserting on `TreeView`-level state.
  - Assertions on UI state that depends on an un-awaited side effect (e.g. `treeView.visible`
    after a branch-change listener fires — see UI idioms above) need a short poll, not a bare
    assert. Use the `waitFor(predicate, timeoutMs?)` helper already in the test file.
  - The workspace these tests open is a scratch git repo, rebuilt fresh on every run by
    `test/setup/buildFixtureRepo.mjs` (never checked into git) and pointed to via
    `workspaceFolder` in `.vscode-test.mjs`. If a test needs different fixture state (more
    branches, uncommitted changes, a rename), extend that script rather than hand-crafting state
    inside the test itself. It already gives `other-branch` a real fork-then-diverge shape (a
    commit only on `other-branch`, plus a separate commit only on `main`) specifically so tests
    can assert the merge-base diff excludes the other side's unique commit — don't collapse that
    back into "`other-branch` is a strict ancestor of `main`," which wouldn't catch a two-dot
    regression. It also leaves one file untracked (`untracked.txt`) for the same reason. The
    fork-point commit also carries an annotated tag `v0.1`, files that `main` then renames
    (`to-rename.txt` → `renamed.txt`) and modifies with awkward names (`dir with space/file with
    space.txt`, `ünïcödé.txt`), and a `doomed-branch` the suite deletes mid-test to check a stale
    comparison target gets cleared — that test runs last-ish and deletes the branch for the rest
    of the run. The
    `worktree-branch` worktree it adds also gets its own uncommitted edit and untracked file,
    never staged or committed there — needed to prove a worktree-target diff is actually live
    (see "Worktree comparison" above); a diff against that worktree's last commit alone
    couldn't tell a live diff from a snapshot one. Note the single-repo fixture starts with an
    auto-selected target (`origin/main` — `main` is checked out), so a test that needs a specific
    target selects it explicitly rather than relying on `diffCurrentFile`'s first-use prompt.
  - `.vscode-test.mjs` defines **two** configs (`label`s): `single-repo` (the above) and
    `multiroot` — `test/integration-multiroot/*.test.ts` against
    `.vscode-test/multiroot/multiroot.code-workspace` (two repos, a second folder inside one of
    them, and a non-repo folder; built by the same fixture script). The multiroot config has its
    own `--user-data-dir` (wiped by the fixture script, so no workspaceState survives between
    runs) and sets `GIT_CEILING_DIRECTORIES` so the non-repo folder isn't found to be inside the
    Chevron checkout itself. `vscode-test` runs both; `vscode-test --label multiroot` runs one.
  - Test files are plain TypeScript but Mocha needs compiled JS — `pnpm run test:integration`
    runs `tsc -p tsconfig.test.json` first, which compiles `src/` + `test/` into `out/` in
    parallel structure. Don't try to point `@vscode/test-cli` at `.ts` files directly.
- `pnpm run test` runs `pretest` (check-types, compile, lint) then Vitest then the integration
  suite, in that order — cheap failures surface before paying for an Extension Host launch.

## Packaging

`pnpm dlx @vscode/vsce package` (or `pnpm run vsix`) produces a local `.vsix`. Publishing only ever
happens through `.github/workflows/release.yml` (manual dispatch with `publish` ticked), never from a
laptop or a tag push. Windows and macOS tests also run only there. CI (`ci.yml`) is Ubuntu-only, and both
call the reusable `test.yml`.
`publisher: "MJEvansDev"` is the real Marketplace publisher and Open VSX namespace; it is
permanent, so never change it. Verify a new `.vsix` with
`code --install-extension chevron-<version>.vsix` before considering a change done.
