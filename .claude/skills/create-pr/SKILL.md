---
name: create-pr
description: >
  Write (or rewrite) a pull request description that lets the repo owner gain confidence in a
  change WITHOUT reading all the code: a feature-level overview, a ranked review guide with
  permalinks to the code worth reading, before/after Mermaid diagrams when structure or flow
  changed, and validation evidence traced to each requirement. Use whenever creating a PR,
  updating a PR's description, or when asked to "write up", "summarise" or "explain" a PR.
---

# Create PR — confidence without a full code review

The reader is the repo owner. They will **not** read the whole diff. The description must let them
answer three questions in a few minutes:

1. **What does this give me?** (features, in user terms)
2. **Where could it be wrong?** (the handful of places worth their eyes, and what to check there)
3. **How do I know it works?** (evidence, traced to requirements, with gaps admitted)

Every claim needs a link or a test behind it. A confident description with nothing to click is
worse than a short one.

## Step 1 — Gather facts (don't write from memory)

Run these against the PR's base, which is usually the default branch:

```bash
BASE=origin/main   # the PR's base branch
git fetch -q origin
HEAD_SHA=$(git rev-parse HEAD)
git log --oneline "$BASE"..HEAD            # commit story
git diff --stat "$BASE"...HEAD | tail -40  # size and shape
git diff --name-status "$BASE"...HEAD      # added / modified / deleted / renamed
git diff "$BASE"...HEAD --name-only | grep -Ei '(test|spec)'   # test files touched
```

Also collect:
- **Requirements**: the task, issue, plan doc or user request the PR answers. List them explicitly;
  they drive the validation table. If they aren't written down, state the ones you're inferring.
- **CI**: the latest run on `HEAD_SHA`, its URL, and the result per job/platform (GitHub MCP
  `actions_list` → `list_workflow_runs` with `head_sha`/branch, then `list_workflow_jobs`). Never
  write "CI passes" without having seen that run's result for this exact head commit.
  In this repo, CI runs on **Ubuntu only**. Windows and macOS run only in the **Release** workflow.
  If the PR touches anything platform-sensitive (paths, git plumbing, file I/O, tests), trigger a
  dry run on the PR branch: `actions_run_trigger`, `release.yml`, ref `<branch>`, inputs
  `{version: <package.json version>, publish: false}`. Use its matrix as the Windows/macOS evidence.
  Otherwise mark Windows/macOS ⚠️ not verified; never ✅.
- **Test counts**: run the fast suites locally and note the numbers (e.g. `226 passed`).
- **PR template**: if `.github/pull_request_template.md` (or a variant) exists, keep its headings
  and fit the sections below inside them.

## Step 2 — Classify the diff by risk

Sort changed files into three buckets. This drives the review guide.

| Bucket | Typical contents |
|---|---|
| **Review** (high risk) | Code that mutates user data or files; security boundaries (process spawning, argument building, path handling, auth, input from URIs/network); concurrency and caching/invalidation; public API or manifest contracts (commands, settings, schemas, CLI flags); migrations; release/deploy pipelines; deletions of behaviour |
| **Skim** (medium) | New features in isolated new files with good tests; UI wiring; refactors with test coverage unchanged |
| **Skip** (low) | Docs, generated files, lockfiles, assets, test fixtures, formatting, renames with no content change |

Aim for **3–8 Review items**. More than that means the PR should have been split; say so.

## Step 3 — Write the description

Use this structure. Omit a section only when it truly doesn't apply, and say why in one line
(e.g. "No diagram: config-only change").

````markdown
## Summary
One or two sentences: what this PR delivers and why.

### What's in it
- **Feature name**: what a user can now do, in their terms. (1 line each, 3–8 bullets)
- ...

### Not in this PR
- Anything a reader might assume is included but isn't (deferred work, known gaps → issue links).

## Where to look
Ranked by risk. Each item: permalink, why it's risky, what to check. Reading these should take
under 15 minutes.

1. **[`src/foo.ts` L40–92 — `applyEdit()`](https://github.com/OWNER/REPO/blob/HEAD_SHA/src/foo.ts#L40-L92)**
   Mutates the user's file. Check: the staleness check and the edit happen with no `await` between them.
2. ...

<details><summary>Safe to skim / skip (N files)</summary>

- `docs/**`, `CHANGELOG.md`: documentation
- `pnpm-lock.yaml`: lockfile
</details>

## What changed
Before/after Mermaid diagrams (see rules below), then 2–5 bullets naming the structural changes the
diagrams show.

## Validation
### Requirements → evidence
| Requirement | Evidence | Status |
|---|---|---|
| Take never corrupts a file that changed underneath it | [`takeFromBranch.test.ts` "stale lens refused"](permalink) · CI [run](url) | ✅ verified |
| Works on Windows | Release dry-run `test (windows-latest)` job [link](url) | ✅ verified |
| Marketplace page renders correctly | not checkable before publishing | ⚠️ not verified |

### New and changed tests
- `test/unit/x.spec.ts` (+N tests): what they prove, in one line.
- ...

### CI
CI run [#N](url) on `HEAD_SHA_SHORT`: ubuntu ✅ (unit N, integration M). Release dry run [#M](url): windows ✅ · macos ✅ (if run).

### Not validated
Be explicit: manual checks not done, platforms not covered, behaviour only tested by fixtures.

### Verify it yourself
```bash
pnpm install && pnpm run test:unit
```
Plus one or two manual steps that exercise the headline feature end to end.

## Risks and follow-ups
- Known issues (link the issues), rollback notes, anything needing a human decision.
````

## Rules for the review guide ("Where to look")

- **Permalinks only**: `https://github.com/OWNER/REPO/blob/<full HEAD SHA>/<path>#L<a>-L<b>`. Never
  link a branch name, because the lines drift as the branch moves. Get line numbers with
  `grep -n` or by reading the file at `HEAD_SHA`. Re-check them after any later push, and
  regenerate the links if the head changed.
- Link the **function**, not the file. Keep ranges tight: under ~80 lines each.
- Each item says **why it's risky** and **what specifically to check**: a question the reader can
  answer by looking, not "review carefully".
- Rank by *consequence × likelihood*. Data loss and security go first.
- If a hotspot is well covered by tests, say which test, so the reader can trust it and skip it.

## Rules for Mermaid diagrams ("What changed")

- **Include them** when the PR changes architecture (new components or modules and how they
  connect), a data or control flow, a state machine, or a user-facing flow. **Skip them** for
  bug fixes local to one function, docs, config and dependency bumps, and say "No diagram:
  <reason>".
- Draw **Before** and **After** as two separate ```` ```mermaid ```` blocks with the same layout
  direction and the same node names for unchanged parts, so the eye can diff them.
- In **After**, highlight what's new or changed:
  `classDef new fill:#d1fae5,stroke:#059669,color:#064e3b;` and
  `classDef changed fill:#fef3c7,stroke:#d97706,color:#78350f;`, applied with `class A,B new;`.
  Add a one-line legend under the diagram.
- ≤ 15 nodes per diagram. If it needs more, draw the part that changed and collapse the rest into
  a single node.
- Use a `sequenceDiagram` for "what happens when the user does X" when the order of steps or a race
  matters (e.g. check-then-apply). Use a `flowchart` for structure.
- Quote labels containing punctuation: `A["gitService.getMergeBase()"]`. Avoid `<`, `>` and `&`
  in labels, or use `#lt;` / `#gt;`.
- **Validate before posting.** Use the Mermaid validation tool if one is available
  (`mcp__Mermaid_Chart__validate_and_render_mermaid_diagram`). Otherwise
  `pnpm dlx @mermaid-js/mermaid-cli -i d.mmd -o d.svg`. A diagram that fails to render on GitHub
  costs more trust than having none.

## Rules for validation

- **Every requirement gets a row.** Evidence is a link to a test (permalink to the `it`/`test`
  line), a CI job, or a described manual check with its result. "Covered by existing tests" needs
  the test named.
- Status is one of: ✅ verified (automated evidence on this head), 🧪 verified manually (say
  how), ⚠️ not verified (say why), ❌ known failing (link the issue).
- **Never upgrade a status.** Tests you wrote but haven't seen pass in CI or locally are ⚠️, not ✅.
  If CI didn't run a suite (e.g. integration tests skipped on one OS), say so.
- Describe new tests by **what they prove**, not by name alone.
- The "Verify it yourself" section should take the owner under five minutes.

## Style

- Lead with outcomes. Implementation details go only in "Where to look" and "What changed".
- Plain words, short bullets. No marketing ("robust", "seamless").
- Put long lists (every file, every test) inside `<details>` blocks. Keep the top-level body readable
  on one screen per section.
- Link issues and PRs as full URLs or `owner/repo#N`.
- End the body with the attribution lines the session requires.

## Creating vs updating

- **Creating**: gather → classify → write → validate diagrams → create the PR (`create_pull_request`).
  Only create a PR when the user asked for one.
- **Updating** after new pushes: regenerate permalinks against the new head SHA, refresh the CI
  section with the new run, add rows for anything new, and never leave stale ✅ statuses from an
  older head (`update_pull_request` with the new body).
