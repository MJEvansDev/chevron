import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DEFAULT_VIEW_TITLE, formatAheadBehind, formatFileDescription, formatViewDescription, viewHeaderTitle } from '../../src/treeDescription';

describe('formatAheadBehind', () => {
  it('shows behind then ahead', () => {
    expect(formatAheadBehind({ ahead: 5, behind: 3 })).toBe('↓3 ↑5');
  });

  it('is undefined when level', () => {
    expect(formatAheadBehind({ ahead: 0, behind: 0 })).toBeUndefined();
  });
});

describe('formatViewDescription', () => {
  it('keeps the single-repo format unchanged', () => {
    expect(formatViewDescription({ targetLabel: 'main', suffix: '↓3 ↑5' })).toBe('main  ↓3 ↑5');
    expect(formatViewDescription({ targetLabel: 'main' })).toBe('main');
    expect(formatViewDescription({})).toBeUndefined();
  });

  it('prefixes the repo name when there are several repos', () => {
    expect(formatViewDescription({ repoName: 'api', targetLabel: 'main', suffix: '↓3 ↑5' })).toBe('api · main  ↓3 ↑5');
    expect(formatViewDescription({ repoName: 'api', targetLabel: 'v1.0' })).toBe('api · v1.0');
  });

  it('shows just the repo name when that repo has no target', () => {
    expect(formatViewDescription({ repoName: 'api' })).toBe('api');
  });
});

describe('formatFileDescription', () => {
  it('shows status and counts', () => {
    expect(formatFileDescription({ status: 'M', additions: 3, deletions: 1 })).toBe('M  +3 -1');
    expect(formatFileDescription({ status: 'U', additions: 2 })).toBe('U  +2 -0');
  });

  it('shows just the status without counts (binary)', () => {
    expect(formatFileDescription({ status: 'A' })).toBe('A');
  });

  it('leads with the directory in the flat-list layout', () => {
    expect(formatFileDescription({ status: 'M', additions: 1, deletions: 0, directory: 'src/utils' })).toBe(
      'src/utils  M  +1 -0',
    );
  });
});

describe('viewHeaderTitle', () => {
  it('puts the description in the title', () => {
    expect(viewHeaderTitle('main  ↓1 ↑3')).toBe('main  ↓1 ↑3');
  });

  it('falls back to the manifest name with nothing to compare', () => {
    expect(viewHeaderTitle(undefined)).toBe(DEFAULT_VIEW_TITLE);
  });

  it('matches the view name in package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const view = manifest.contributes.views.chevron.find((v: { id: string }) => v.id === 'chevron.changedFilesView');
    expect(view?.name).toBe(DEFAULT_VIEW_TITLE);
  });
});
