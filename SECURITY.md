# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Report it privately through
GitHub's security advisories instead:
[Report a vulnerability](https://github.com/MJEvansDev/chevron/security/advisories/new)
(repository → **Security** tab → **Report a vulnerability**).

Include the Chevron version, your editor and version, your OS, and steps to reproduce. You should
get an acknowledgement within a week. Once a fix is released, the advisory is published with
credit to you unless you'd rather stay anonymous.

## Supported versions

Only the latest released version receives fixes.

## What Chevron does and doesn't do

Useful context when assessing an issue:

- Chevron makes **no network requests** and collects **no telemetry**. It has no runtime
  dependencies — everything it ships is its own code, bundled into a single file.
- Its only interaction with the rest of the system is running the local `git` executable
  (via `execFile`, never a shell) in your workspace's repository and its worktrees, and reading
  files from those working trees.
- `git` itself honours your repository's configuration. If you open an untrusted repository,
  its local git config (for example a custom diff driver or `textconv`) applies to Chevron's git
  calls just as it would to running `git diff` in a terminal. VS Code's Workspace Trust is the
  guard for that; Chevron does not add another.
