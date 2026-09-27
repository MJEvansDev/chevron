// Pins the shape of the demo repo built by scripts/make-demo-repo.mjs, which the recorded media
// and manual QA rely on.
// Needs only `git` on PATH.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultComparisonCandidates } from '../../src/defaultBranch';

const script = path.resolve(__dirname, '..', '..', 'scripts', 'make-demo-repo.mjs');
let scratch: string;
let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).replace(/\n$/, '');
}

function runScript(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: scratch, encoding: 'utf8' });
}

function gitSucceeds(args: string[]): boolean {
  return spawnSync('git', args, { cwd: repo }).status === 0;
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chevron-demo-'));
  repo = path.join(scratch, 'demo');
  const result = runScript(repo);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}, 60_000);

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('make-demo-repo', () => {
  it('checks out feature/discounts, one behind and three ahead of main', () => {
    expect(git(['symbolic-ref', '--short', 'HEAD'])).toBe('feature/discounts');
    expect(git(['rev-list', '--left-right', '--count', 'main...HEAD']).split(/\s+/)).toEqual(['1', '3']);
  });

  it('diffs against the merge-base as: modified, added, renamed, binary, uncommitted', () => {
    const mergeBase = git(['merge-base', 'main', 'HEAD']);
    expect(git(['rev-parse', 'v1.0.0^{commit}'])).toBe(mergeBase);
    const lines = git(['diff', '--name-status', '-M', mergeBase]).split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        'M\tpublic/logo.png',
        'A\tsrc/discounts.ts',
        'M\tsrc/cart.ts',
        'M\tsrc/pricing.ts',
        expect.stringMatching(/^R\d+\tsrc\/api\/orders\.ts\tsrc\/api\/orderRoutes\.ts$/),
      ]),
    );
    expect(lines).toHaveLength(5);
    // main's own new commit (README) must not leak into the three-dot diff.
    expect(lines.some((line) => line.endsWith('README.md'))).toBe(false);
    expect(git(['diff', '--numstat', mergeBase, '--', 'public/logo.png'])).toMatch(/^-\t-\t/);
  });

  it('gives src/pricing.ts three separate hunks: a deleted line, a modified function, an added block', () => {
    const mergeBase = git(['merge-base', 'main', 'HEAD']);
    const diff = git(['diff', '-U0', mergeBase, '--', 'src/pricing.ts']);
    const hunks = diff.split('\n').filter((line) => line.startsWith('@@'));
    expect(hunks).toHaveLength(3);
    expect(diff).toContain("-  console.log('shipping: flat rate applied');");
    expect(diff).toContain('+export function total(cart: Cart, discountRate = 0): number {');
    expect(diff).toContain('+export function savings(cart: Cart, discountRate: number): number {');
  });

  it('leaves an uncommitted edit and an untracked file', () => {
    const status = git(['status', '--porcelain']).split('\n');
    expect(status).toEqual(expect.arrayContaining([' M src/cart.ts', '?? src/discounts.test.ts']));
    expect(status).toHaveLength(2);
  });

  it('has remote-tracking branches, a tag, a spike branch and a linked worktree', () => {
    const refs = git(['for-each-ref', '--format=%(refname)']).split('\n');
    expect(refs).toEqual(
      expect.arrayContaining([
        'refs/heads/main',
        'refs/heads/feature/discounts',
        'refs/heads/spike/free-shipping',
        'refs/heads/hotfix/rounding',
        'refs/remotes/origin/main',
        'refs/remotes/origin/release/1.0',
        'refs/remotes/origin/feature/discounts',
        'refs/tags/v1.0.0',
      ]),
    );
    const worktreeDir = `${repo}-hotfix`;
    expect(git(['worktree', 'list', '--porcelain'])).toContain('branch refs/heads/hotfix/rounding');
    expect(git(['status', '--porcelain'], worktreeDir)).toBe(' M src/pricing.ts');
  });

  it('makes Chevron auto-select local main (no origin/HEAD)', () => {
    expect(gitSucceeds(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).toBe(false);
    const candidates = defaultComparisonCandidates({ configured: '', originHead: undefined, currentBranch: 'feature/discounts' });
    const firstResolving = candidates.find((ref) => gitSucceeds(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]));
    expect(firstResolving).toBe('main');
  });

  it('dates commits relative to now so blame reads naturally', () => {
    const now = Date.now() / 1000;
    const ages = git(['log', '--format=%at', 'main', 'feature/discounts'])
      .split('\n')
      .map((stamp) => (now - Number(stamp)) / 86_400);
    expect(Math.max(...ages)).toBeGreaterThan(40);
    expect(Math.min(...ages)).toBeLessThan(1);
    expect(git(['log', '-1', '--format=%an <%ae>'])).toBe('Demo Author <demo@example.com>');
  });

  it('refuses to overwrite a non-empty directory without --force, and rebuilds with it', () => {
    const refused = runScript(repo);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('--force');

    fs.writeFileSync(path.join(repo, 'scribble.txt'), 'x');
    const rebuilt = runScript(repo, '--force');
    expect(rebuilt.status).toBe(0);
    expect(fs.existsSync(path.join(repo, 'scribble.txt'))).toBe(false);
    expect(git(['rev-list', '--left-right', '--count', 'main...HEAD']).split(/\s+/)).toEqual(['1', '3']);
  }, 60_000);
});
