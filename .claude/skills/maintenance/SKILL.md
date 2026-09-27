---
name: maintenance
description: >
  Run Chevron's routine maintenance: reply to issues approaching or past the 7-day response
  target, handle Dependabot PRs, cut the quarterly patch release, and work through dated
  dated deadlines from the maintainer's local config. Use when the
  SessionStart maintenance status flags something, when the weekly "Maintenance status" issue
  pings, or when the user says "/maintenance", "maintenance", "triage" or "what needs doing".
---

# Chevron maintenance

Commitments (CONTRIBUTING.md → Maintenance):
- Reply to every issue within **7 days**.
- Ship a patch release at least **every 90 days**, even if it's only dependency bumps.
- Success markers: **500 installs by day 90**, and **2,500 by day 365**.

Config lives in `.claude/maintenance.json`. Status comes from `scripts/maintenance-status.mjs`.
The same script feeds the SessionStart hook and the weekly `maintenance.yml` workflow.

## 1. Get the current status

```bash
node scripts/maintenance-status.mjs --format=markdown
```

If issues show as "unavailable", use the GitHub MCP tools (`list_issues`, `issue_read`) on
`MJEvansDev/chevron` instead.

## 2. Work each item, most urgent first

### Issues awaiting a reply
1. Read the issue and its comments.
2. For a bug report, try to reproduce it:
   - Use the demo repo from `node scripts/make-demo-repo.mjs`, or a fixture.
   - Check the reporter's `git diff --name-status` output against what Chevron showed.
3. Draft a reply: thank them, say what you found, and give the next step (a fix, a question, or a
   pointer to the "never build" list for out-of-scope requests).
4. **Show the draft to the user and post it only once they approve.** Replies are public and go out
   under their name. End the comment with the attribution footer.
5. Label it `bug` or `enhancement`. If it's a confirmed bug with a small fix, offer to open a PR
   (use the `create-pr` skill).

### Dependabot PRs
- Check CI on the PR head.
- Green, and a dev-dependency minor/patch update: recommend merging.
- A major bump, or anything touching `@types/vscode` or `engines.vscode`: summarise the risk and
  ask. `@types/vscode` sets the minimum VS Code version users need.

### Patch release due (every 90 days)
1. Merge the pending Dependabot PRs first.
2. On a branch:
   - Bump the patch version in `package.json`.
   - Add a `## X.Y.Z` section to `CHANGELOG.md`, listing merged PRs since the last tag.
   - Run `pnpm run check-types && pnpm run lint && pnpm run test:unit`.
3. Open a PR with the `create-pr` skill.
4. After the user merges it, run the **Release** workflow as a **dry run**: GitHub MCP
   `actions_run_trigger`, `release.yml`, ref `main`, inputs `{version: "X.Y.Z", publish: false}`.
   This is safe, because it publishes nothing. It runs the Ubuntu/Windows/macOS matrix and builds
   `chevron-release-vsix`. Report the result.
5. **Publishing is the user's call.** Tell them to run **Release** with `publish` ticked. The
   `marketplace` environment also asks for their approval. Never trigger `publish: true` yourself.
   If anything user-facing changed, ask them to do a manual QA pass on the dry-run
   artifact first.

### Dated deadlines
Deadlines live in `.claude/maintenance.local.json` (gitignored; it exists only on the maintainer's
machine). Each entry's `action` says what to do. If the file is missing, there are no deadlines
to work.

When an item is done, update `.claude/maintenance.local.json`: remove it, or move its date forward
if it recurs. It isn't committed.

## 3. Report back

Summarise in three to six lines: what was handled, what's waiting on the user (drafts to approve,
PRs to merge, tags to push), and the next due date.
