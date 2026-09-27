# Chevron — Usage

What each command does, where to look for the result, and what "it's working" actually looks
like — written after a round of "I ran it and nothing showed up" that turned out to be about
knowing where to look, not a bug. See `README.md` for features and scope, and `CONTRIBUTING.md`
for building and installing a `.vsix`.

## Prerequisites

- The `.vsix` is installed (`code --install-extension chevron-<version>.vsix`, see `CONTRIBUTING.md`)
  and VS Code has been reloaded since installing/updating it (`Cmd/Ctrl+Shift+P` →
  **Developer: Reload Window** if unsure).
- The folder open in VS Code is (or is inside) a git repository. Chevron resolves the repo
  root itself via `git rev-parse --show-toplevel`, so opening a subfolder (e.g. `frontend/`
  inside a larger repo) still works — it walks up to find `.git`.

## Commands

All are available via the Command Palette (`Cmd/Ctrl+Shift+P`), search "Chevron".

### `Chevron: Select Branch to Compare`

Opens a Quick Pick listing your local branches under a "Local" heading and your remote-tracking
branches (e.g. `origin/main`) under a "Remote" heading, each group most recently committed first
and marked with a branch/cloud icon. Remote branches show up as soon as git knows about them
locally — via a clone, `git fetch`, or `git pull` — same as `git branch -a`; Chevron doesn't
fetch on your behalf, so a remote branch that's moved since your last fetch is compared against
the tip your local copy last saw, not whatever's actually on the server now. If you already have
a comparison branch selected, it's sorted to the top of its group with a checkmark
(`✓ branch-name`) and a "currently comparing" label, so re-opening the picker to change branches
makes obvious what you're changing *from*.

If the repo has other worktrees (`git worktree list`), they show up in a third "Worktrees" section
with a repo icon, labeled by the branch checked out there and described by that worktree's
directory. Picking one is a **live** comparison against that worktree's own working directory —
its uncommitted edits and untracked files are visible, not just what it's last committed — unlike
picking that same branch directly under "Local," which only ever sees committed state. A worktree
with a detached `HEAD` shows up labeled by a short commit SHA instead of a branch name.

**What you should see:** the Chevron panel (see below) opens automatically, and the **"Compare
to Branch"** heading now shows the branch name next to it (e.g. "COMPARE TO BRANCH · main"). This
sets the "comparison branch" for the workspace (stored per-workspace, survives window reloads)
and is a prerequisite for the other commands — but you no longer have to go find the result
yourself, picking a branch reveals it.

### `Chevron: Diff Current File Against Branch` (`Cmd+K Shift+D` / `Ctrl+K Shift+D`)

With a file open and focused in the editor, diffs it against the version on the comparison
branch. If you haven't picked a branch yet, this prompts the Quick Pick above first.

**What you should see:** VS Code's normal two-pane diff editor opens, titled
`<path> (<branch> ↔ Working Tree)`. Left pane is the file as it exists on the branch, right pane
is your working copy — including unsaved edits, since the right side is the real file, not a
snapshot.

**If the two panes look identical:** that's correct, not broken — it means the file doesn't
differ from that branch. Try a file you know you've changed, or check from a terminal first:
`git diff --name-status <branch>` in the repo root shows what Chevron is working from.

### `Chevron: Show Changed Files (Project)`

Whole-project equivalent of the above: reveals the **"Compare to Branch"** panel directly (same
auto-reveal as selecting a branch, above) and ensures a comparison branch is set (prompting if
needed).

**Where it lives:** Chevron has its own icon in the Activity Bar (the vertical strip of icons
on the far left/right of the window, alongside Explorer, Search, Source Control, etc.) — a
two-overlapping-circles glyph. Click it, or let any Chevron command reveal it for you, to see
the **"Compare to Branch"** tree. It's no longer nested inside the built-in Source Control view —
that was the original design and turned out to be easy to miss, especially with other extensions
(e.g. GitLens) or VS Code's own "Graph" view also contributing sections there with no way for an
extension to control its position among them.

**What you should see once a branch is selected — the heading shows which branch you're
comparing against, plus how far you've diverged (e.g. `main  ↓3 ↑5` for 3 commits behind, 5
ahead):**
- If no branch has been selected yet: the panel shows a prompt — "No comparison branch selected."
  with a **Select Branch** link.
- If a branch is selected and there are differences: a folder tree of every file that differs
  between your working tree and the merge-base with that branch (see "Merge-base diffing" below),
  plus any untracked files, each file tagged `A`/`M`/`D`/`R`/`U` (added/modified/deleted/renamed/
  untracked) with an icon colored to match — green for added, VS Code's usual "modified" color
  for modified, red for deleted, the "renamed" color for renamed, and the "untracked" color for
  untracked, the same colors the built-in Source Control view uses so they read consistently.
  Each file also shows its line-count delta (`+12 -4`); binary and untracked files just show the
  status letter, since there's no meaningful line count. Click any file to open its diff, or
  right-click it for **Copy Relative Path** / **Reveal in Explorer**.
- If a branch is selected and there are **no** differences (e.g. you compared to your own current
  branch with a clean working tree and no untracked files): the panel shows "No differences
  between the working tree and `<branch>`." instead of rendering empty.

**Comparing against a worktree instead:** the heading shows just the branch checked out there, no
`↓/↑` divergence counts — two working directories don't have the single ahead/behind number two
branches do. Renames also aren't detected in this mode (each file is compared independently); a
rename shows up as a delete plus an add rather than a single `R` entry.

### Merge-base diffing

Chevron diffs against the merge-base of your working tree and the comparison branch — the
commit they last shared before diverging — not the branch's raw tip. If the comparison branch has
moved on since you branched from it, its own new commits aren't shown as part of your diff; only
what's changed on your side since the fork point is. This matches how GitHub/GitLab PR views and
IntelliJ's "Compare with Branch" both work. **This doesn't apply to a worktree comparison** — there
is no merge-base between two working directories, so that mode instead diffs the two worktrees'
files directly, live, the same way `diff` would from a terminal.

### Blame on hover

Hover any line in either pane of a Chevron diff editor (or in a normal editor tab for a
tracked file) and a tooltip shows who last touched that line: author (plus **committed by
`<name>`**, when the committer differs from the author — e.g. after a rebase or cherry-pick),
date, commit summary, and short hash. An uncommitted local edit shows "Not committed yet" instead.

The two panes are blamed differently, matching what each one actually displays: the local
(working-tree) pane blames the working tree itself, so an uncommitted edit shows up as such; the
branch-side pane blames the file **as of the merge-base commit** — the same commit
`getFileContentAtRef` reads that pane's content from — not the branch's raw tip, so the two stay
consistent with each other. **Comparing against a worktree instead:** both panes blame the same
way (there's no merge-base to blame at), so an uncommitted edit in *either* worktree shows up as
"Not committed yet."

Hover itself has no separate command or toggle — it's always on, the same way VS Code's built-in
hovers work, and it runs on demand (only when you actually hover a line), so there's no ongoing
cost for files you never look at.

### `Chevron: Toggle Blame Annotations` (`Cmd+K Shift+B` / `Ctrl+K Shift+B`)

Shows a compact blame label in the left margin of every **changed** line — added or modified
relative to the comparison branch's merge-base, the same lines the changed-files tree and diff
editor already key off. A persistent view rather than one you have to hover to see. Off by
default; the hotkey (or the command from the palette) toggles it on/off. Hover blame keeps working
regardless of whether this is on (and on *any* line, not just changed ones, and on either pane of
the diff editor), and still shows the full detail (committer, absolute date/time, commit summary,
hash) this compact form leaves out.

**What you should see:** dimmed text like `Jane Doe, 2d ago` prefixed to the start of the code,
only on lines that differ from the comparison branch — everything else in the file is left alone.
An uncommitted local edit shows `Not committed yet` instead. **Requires a comparison branch to be
selected** (`Chevron: Select Branch to Compare`) — without one there's no base to call anything
"changed" against, so nothing is annotated; select a branch first if toggling this on does nothing
visible.

**Working-tree pane only.** In Chevron's diff editor, only the right-hand (local/working-tree)
pane gets annotated — never the left-hand branch-side pane. That's deliberate, not a gap: two
panes each carrying their own margin was one column too many, and the working-tree pane is always
the *most recent* version of the file (your unsaved edits included), where the branch-side pane is
a fixed historical snapshot — the more useful one to default to. A plain editor tab for a tracked
file (outside the diff view) is unaffected either way, since it's the same `file://` pane.

The label itself is deliberately terse — author name (truncated if very long) plus a relative time
only, no committer/hash — and rendered as `before` content at the very start of the line, which is
what actually reads as a margin column (an `after`-anchored trailing label reads more like an
inline comment). Since only changed lines carry a label at all, this only ever nudges code
rightward on the lines that already have one — VS Code has no API for putting arbitrary text in
the *real* gutter/glyph margin (only icons), so this is still an editor-content-area decoration
made to look like one, not a true margin annotation.

Annotations refresh automatically as you switch editors, edit the file (debounced ~300ms while
typing), switch the comparison branch, or do anything that changes `.git/HEAD`, `.git/index`, or
`.git/refs/**` (checkout, commit, pull) — e.g. committing a line immediately flips its label from
`Not committed yet` to the new commit, without needing to touch the file again.

### `Chevron: Refresh` (icon in the "Compare to Branch" panel's title bar)

Re-runs the diff against the current comparison branch. The tree also refreshes itself
automatically — after a file save, and after anything that touches `.git/HEAD`, `.git/index`, or
`.git/refs/**` (switching branches, committing, pulling) — so this is mostly there for the rare
case you want to force it (e.g. right after a change made outside VS Code).

## A full walkthrough

1. Make an actual change: edit a tracked file and save it (don't commit).
2. `Cmd/Ctrl+Shift+P` → **Chevron: Select Branch to Compare** → pick the branch you started
   from (or any branch that predates your edit).
3. With that file focused in the editor, `Cmd+K Shift+D` / `Ctrl+K Shift+D` — a diff editor opens showing
   your edit against the branch version.
4. Click the Chevron icon in the Activity Bar, find **Compare to Branch**, confirm the same
   file is listed there with status `M` (colored to match VS Code's modified-file color). Click
   it — same diff opens.

## Troubleshooting "nothing shows up"

In order of likelihood:

1. **You're looking in the wrong place.** Chevron has its own Activity Bar icon — click it, or
   any Chevron command should reveal the panel for you automatically. If it doesn't, the panel
   may just be minimized/resized to nothing; try dragging its edge.
2. **There's genuinely nothing to diff.** Comparing your current branch to itself with a clean
   working tree is a no-op by design. Confirm with `git diff --name-status <branch>` in a
   terminal — if that's empty too, Chevron is behaving correctly.
3. **The window wasn't reloaded after install/update.** Reload (`Developer: Reload Window`) and
   retry.
4. **Stale tree after switching branches, pulling, or saving a file.** This should now refresh
   itself automatically; if it hasn't, click the refresh icon in the "Compare to Branch" panel's
   title bar as a fallback.
5. **Several repositories open.** The panel shows one repository at a time — the one named at the
   start of its title line (`repo-name · main`). It follows the file you're editing; use the
   repository icon in the panel's title bar (or `Chevron: Select Repository`) to switch
   explicitly. Each repository keeps its own comparison branch.
6. **Untracked files missing.** Check `chevron.showUntrackedFiles` in Settings.

If none of those explain it, it's a real bug — file it with what `git diff --name-status
<branch>` shows from a terminal alongside what Chevron showed (or didn't).
