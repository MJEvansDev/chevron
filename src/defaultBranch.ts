/**
 * Which refs to try, in order, when auto-selecting a comparison target for a repo that has none
 * (`chevron.defaultComparisonBranch` / `chevron.autoSelectComparisonBranch`).
 * Pure — the caller resolves each candidate with `git rev-parse` and takes the first that exists.
 *
 * - A configured ref is the only candidate (an explicit setting that doesn't resolve shouldn't
 *   silently fall back to something else).
 * - Otherwise: what `origin/HEAD` points at (e.g. `origin/main`), then `main`, then `master`.
 * - Never the checked-out branch itself — comparing a branch with itself is an empty diff. That
 *   candidate becomes `origin/<branch>` instead (the caller skips it if it doesn't exist).
 */
export function defaultComparisonCandidates(options: {
  /** `chevron.defaultComparisonBranch`; blank means "work it out". */
  configured: string;
  /** `origin/HEAD`'s target as a short name, e.g. `origin/main`. */
  originHead?: string;
  /** Short name of the checked-out branch; empty/undefined for a detached HEAD. */
  currentBranch?: string;
}): string[] {
  const configured = options.configured.trim();
  const base = configured ? [configured] : [options.originHead, 'main', 'master'];
  const current = options.currentBranch || undefined;

  const candidates: string[] = [];
  for (const ref of base) {
    if (!ref) {
      continue;
    }
    const candidate = current !== undefined && isSameBranch(ref, current) ? `origin/${current}` : ref;
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/** `main`, `heads/main` and `refs/heads/main` all name the local branch `main`. */
function isSameBranch(ref: string, branch: string): boolean {
  return ref === branch || ref === `heads/${branch}` || ref === `refs/heads/${branch}`;
}
