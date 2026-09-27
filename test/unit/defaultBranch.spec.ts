import { describe, it, expect } from 'vitest';
import { defaultComparisonCandidates } from '../../src/defaultBranch';

describe('defaultComparisonCandidates', () => {
  it('tries origin/HEAD, then main, then master when nothing is configured', () => {
    expect(defaultComparisonCandidates({ configured: '', originHead: 'origin/main', currentBranch: 'feature' })).toEqual([
      'origin/main',
      'main',
      'master',
    ]);
  });

  it('skips origin/HEAD when it is not set', () => {
    expect(defaultComparisonCandidates({ configured: '', currentBranch: 'feature' })).toEqual(['main', 'master']);
  });

  it('uses only the configured ref when one is set (no silent fallback)', () => {
    expect(
      defaultComparisonCandidates({ configured: 'develop', originHead: 'origin/main', currentBranch: 'feature' }),
    ).toEqual(['develop']);
  });

  it('trims the configured value, and treats whitespace as unset', () => {
    expect(defaultComparisonCandidates({ configured: '  develop ', currentBranch: 'feature' })).toEqual(['develop']);
    expect(defaultComparisonCandidates({ configured: '   ', currentBranch: 'feature' })).toEqual(['main', 'master']);
  });

  it('never picks the checked-out branch itself — substitutes origin/<branch>', () => {
    expect(defaultComparisonCandidates({ configured: '', currentBranch: 'main' })).toEqual(['origin/main', 'master']);
    expect(defaultComparisonCandidates({ configured: 'develop', currentBranch: 'develop' })).toEqual(['origin/develop']);
    expect(defaultComparisonCandidates({ configured: 'refs/heads/develop', currentBranch: 'develop' })).toEqual([
      'origin/develop',
    ]);
  });

  it('does not duplicate origin/<branch> when origin/HEAD already names it', () => {
    expect(defaultComparisonCandidates({ configured: '', originHead: 'origin/main', currentBranch: 'main' })).toEqual([
      'origin/main',
      'master',
    ]);
  });

  it('keeps origin/HEAD even when it tracks the checked-out branch (a remote ref is not the branch itself)', () => {
    expect(defaultComparisonCandidates({ configured: '', originHead: 'origin/master', currentBranch: 'master' })).toEqual([
      'origin/master',
      'main',
    ]);
  });

  it('does no substitution on a detached HEAD', () => {
    expect(defaultComparisonCandidates({ configured: '', currentBranch: '' })).toEqual(['main', 'master']);
  });
});
