# Contributing to Chevron

Thanks for helping. Chevron does one thing — IntelliJ's *Compare With Branch* for VS Code,
including taking changes across — and most of this document is about keeping it that way.

- [Setup](#setup)
- [Build and debug](#build-and-debug)
- [Tests](#tests)
- [Adding a fixture-repo case](#adding-a-fixture-repo-case)
- [What Chevron will never build](#what-chevron-will-never-build)
- [Maintenance](#maintenance)
- [Release process](#release-process)

## Setup

Requirements: Node 22, [pnpm](https://pnpm.io) (the version is pinned in `package.json` →
`packageManager`; `corepack enable` picks it up), and `git` on your `PATH`.

**Use pnpm for everything** — never `npm`, `npx` or `yarn`.

```bash
pnpm install
```

## Build and debug

The extension is bundled by esbuild (`esbuild.js`) into a single `dist/extension.js`; TypeScript
is used only for type-checking.

```bash
pnpm run compile       # one-off development build (with sourcemaps)
pnpm run watch         # esbuild in watch mode
pnpm run package       # production build (minified, no sourcemaps)
pnpm run check-types   # tsc --noEmit
pnpm run lint          # eslint src test
```

**F5 debugging:** open the repo in VS Code and press `F5` (or Run and Debug → *Run Extension*).
`.vscode/launch.json` starts an Extension Development Host with Chevron loaded, after
`.vscode/tasks.json`'s default build task has started `pnpm run watch` in the background. Edits
rebuild automatically; reload the Development Host window (`Cmd/Ctrl+R`) to pick them up. The
`check-types (watch)` task runs `tsc --watch` if you want type errors in the Problems panel while
you work — esbuild does not type-check.

To try a packaged build instead:

```bash
pnpm run vsix                                   # production build + chevron-<version>.vsix
code --install-extension chevron-<version>.vsix
```

## Tests

There are two suites, and the split is a technical constraint, not a style choice: the `vscode`
module only exists inside an Extension Development Host.

| Suite | Location | Runner | Use it for |
| --- | --- | --- | --- |
| Unit | `test/unit/*.spec.ts` | Vitest, plain Node | Anything that doesn't import `vscode` at runtime: git output parsing, tree building, ordering/labelling logic. |
| Integration | `test/integration/*.test.ts` | `@vscode/test-cli` + `@vscode/test-electron` (Mocha, `tdd` UI) | Command registration, opening real diff editors, tree contents — anything that needs a live `vscode`. |
| Integration (multi-root) | `test/integration-multiroot/*.test.ts` | same, against a two-repo `.code-workspace` (`vscode-test --label multiroot`) | Repo discovery, per-repo comparison targets, active-repo switching, settings. |

```bash
pnpm run test:unit          # fast; run constantly
pnpm run test:integration   # compiles to out/, rebuilds the fixture repo, launches VS Code
pnpm run test               # check-types + compile + lint, then both suites
```

On Linux without a display (CI, containers, WSL), run the integration suite under a virtual
X server:

```bash
xvfb-run -a pnpm run test:integration
```

The first integration run downloads a VS Code build into `.vscode-test/`.

When adding logic, prefer writing it as a pure function in a module with at most a type-only
`import type * as vscode from 'vscode'`, so it can be tested in the unit suite. See
`.claude/skills/vscode-extension-dev/SKILL.md` for the repo's conventions in detail.

## Adding a fixture-repo case

The integration tests run against a scratch git repository built from scratch on every run by
[`test/setup/buildFixtureRepo.mjs`](test/setup/buildFixtureRepo.mjs) into
`.vscode-test/fixture-repo` (plus a bare `fixture-origin.git` remote and a `fixture-worktree`
linked worktree). Nothing under `.vscode-test/` is committed.

To cover a new situation (a rename, a binary file, another branch shape):

1. Add the state to `buildFixtureRepo.mjs` using its `git([...])` helper and `fs` writes. Put it
   in the right place in the history — e.g. before or after the `origin/main` push, or on
   `other-branch` — and leave a comment saying *why* the state exists and what a test proves
   with it.
2. Don't disturb the existing shape: `other-branch` must keep diverging from `main` (a commit only
   on each side) so the merge-base tests keep catching two-dot regressions; `untracked.txt` and
   the worktree's uncommitted edit must stay unstaged.
3. Assert on it from `test/integration/extension.test.ts`. Use the `ChevronApi` returned by
   `activate()` (e.g. `treeProvider.getChildren()`) for introspection, `stubQuickPickSelection` to
   drive pickers, and `waitFor` for UI state that settles asynchronously.
4. Run `pnpm run test:integration` twice in a row — the fixture must rebuild cleanly.

## What Chevron will never build

This is the triage policy for feature requests. Chevron's pitch is that it does one thing well;
each of these would turn it into a worse GitLens. Requests for them will be closed with a link
here — not because they're bad ideas, but because other extensions already do them.

- Pull-request review, or anything that talks to GitHub/GitLab/Bitbucket ("open on GitHub" included)
- AI anything
- Accounts, sign-in, or a paid tier
- A custom diff renderer (Chevron uses VS Code's own diff editor)
- Word/character-level highlighting beyond what VS Code's diff editor does
- Telemetry or any network access — Chevron runs local `git` and nothing else

### Not in 1.0, but possible later

These aren't ruled out; they just aren't planned yet. A feature request with a concrete use case
is welcome:

- Browsing commit history or a commit graph
- Interactive rebase
- Stash browsing and management
- A 3-way merge UI
- Move detection

If you're unsure whether an idea fits, open a feature request first and ask; that's much cheaper
than a pull request that can't be merged.

## Maintenance

Chevron's public commitments:

- **Every issue gets a maintainer reply within 7 days.**
- **A patch release at least every 90 days**, even if it only bumps dependencies. Being visibly
  maintained is part of the pitch, since most extensions in this niche are abandoned inside a year.

Success markers: **500 Marketplace installs by day 90** after launch, and **2,500 by day 365**.

Much of this is automated:

| What | How |
|---|---|
| Weekly status | `.github/workflows/maintenance.yml` updates a pinned "Maintenance status" issue every Monday, and @-mentions the maintainer when something needs attention. |
| In Claude Code | A SessionStart hook (`.claude/settings.json`) runs `scripts/maintenance-status.mjs`, so every session starts knowing what's due. `/maintenance` works through it: it drafts issue replies for approval, triages Dependabot PRs, prepares the patch release and handles dated deadlines. |
| Dependencies | Dependabot opens PRs weekly (npm) and monthly (GitHub Actions). |
| Config | `.claude/maintenance.json` holds the response target, the release cadence, the deadlines and the success markers. |

## Release process

CI runs on **Ubuntu only** for every push and PR, which keeps it quick and cheap. The Windows
and macOS runs, and all publishing, happen in one manual workflow: **Actions → Release → Run
workflow** (`.github/workflows/release.yml`). Nothing publishes from a tag push or a laptop.

1. **Prepare the release PR:**
   - bump `version` in `package.json` (`MAJOR.MINOR.PATCH`, no suffix; see below);
   - move the *Unreleased* entries in `CHANGELOG.md` under a new `## X.Y.Z` heading;
   - merge the PR into `main` once Ubuntu CI is green.
2. **Dry run.** Run **Release** on `main` with `version: X.Y.Z` and **publish unticked**. It
   checks the version against `package.json` and that the tag doesn't exist yet. Then it runs the
   full test suite on Ubuntu, Windows and macOS and builds the `.vsix` once, as the
   `chevron-release-vsix` artifact. It tags and publishes nothing.
3. **Manual QA.** Install that artifact in a clean VS Code profile and check it by hand.
   Before the first release, and whenever the UI changes visibly, re-record the README GIF, clips
   and screenshots with `node scripts/record-demo/record.mjs` (shots are defined in
   `scripts/record-demo/shots.mjs`; it runs in an isolated VS Code), then review
   them in a browser.
4. **Publish.** Run **Release** again with the same version and **publish ticked**. After the same
   checks and matrix pass, the `marketplace` environment waits for your approval. It then:
   - publishes the packaged `.vsix` to the VS Code Marketplace (Entra ID) and Open VSX;
   - creates tag `vX.Y.Z` at the tested commit;
   - creates a GitHub Release with the `.vsix` attached.

   A registry whose credentials aren't configured is skipped with a warning, so the other still
   goes out. If a step fails partway, **Re-run failed jobs** re-runs only the publish job with the
   same `.vsix`. The tag is created last, so a failed publish never leaves a tag behind.

**No pre-release suffixes.** The Marketplace only accepts `MAJOR.MINOR.PATCH`; a version like
`1.1.0-rc.1` is rejected by the workflow. If a pre-release channel is ever needed, use the
Marketplace convention instead — odd minor versions (`1.1.x`) published with
`vsce publish --pre-release` / `ovsx publish --pre-release`, even minors for stable — and extend
the workflow accordingly.

Publishing credentials (Settings → Environments → `marketplace`):

- Marketplace: the variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` for a user-assigned managed identity
  with a GitHub OIDC federated credential on the `marketplace` environment. The workflow publishes
  with `vsce publish --azure-credential`. There is no PAT, because Azure DevOps global PATs stop
  working on 1 Dec 2026.
- Open VSX: the secret `OVSX_PAT`, for the `MJEvansDev` namespace.
