import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import type { ChevronApi } from '../../src/extension';
import type { TreeNode } from '../../src/treeBuilder';

function flattenFiles(nodes: TreeNode[]): Extract<TreeNode, { kind: 'file' }>[] {
  return nodes.flatMap((node) => (node.kind === 'folder' ? flattenFiles(node.children) : [node]));
}

function stubQuickPickSelection(match: string | ((item: vscode.QuickPickItem) => boolean)): () => void {
  const predicate = typeof match === 'string' ? (item: vscode.QuickPickItem) => item.label === match : match;
  const windowWithStub = vscode.window as unknown as {
    showQuickPick: typeof vscode.window.showQuickPick;
  };
  const original = windowWithStub.showQuickPick;
  windowWithStub.showQuickPick = (async (items: vscode.QuickPickItem[]) =>
    items.find(predicate)) as unknown as typeof vscode.window.showQuickPick;
  return () => {
    windowWithStub.showQuickPick = original;
  };
}

/** Captures the items a QuickPick-driving command would have shown, without selecting any of them. */
async function captureQuickPickItems(command: string): Promise<vscode.QuickPickItem[]> {
  const windowWithStub = vscode.window as unknown as {
    showQuickPick: typeof vscode.window.showQuickPick;
  };
  const original = windowWithStub.showQuickPick;
  let captured: vscode.QuickPickItem[] = [];
  windowWithStub.showQuickPick = (async (items: vscode.QuickPickItem[]) => {
    captured = items;
    return undefined;
  }) as unknown as typeof vscode.window.showQuickPick;
  try {
    await vscode.commands.executeCommand(command);
  } finally {
    windowWithStub.showQuickPick = original;
  }
  return captured;
}

/** Makes `vscode.window.showInputBox` resolve to `value` without showing anything; returns a restore function. */
function stubInputBox(value: string | undefined): () => void {
  const windowWithStub = vscode.window as unknown as {
    showInputBox: typeof vscode.window.showInputBox;
  };
  const original = windowWithStub.showInputBox;
  windowWithStub.showInputBox = (async () => value) as unknown as typeof vscode.window.showInputBox;
  return () => {
    windowWithStub.showInputBox = original;
  };
}

async function selectComparison(match: string | ((item: vscode.QuickPickItem) => boolean)): Promise<void> {
  const restoreQuickPick = stubQuickPickSelection(match);
  try {
    await vscode.commands.executeCommand('chevron.selectCompareBranch');
  } finally {
    restoreQuickPick();
  }
}

function fixtureGit(args: string[]): string {
  const folder = vscode.workspace.workspaceFolders![0];
  return execFileSync('git', args, { cwd: folder.uri.fsPath, encoding: 'utf8' }).trim();
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

suite('Chevron Extension', () => {
  let api: ChevronApi;

  suiteSetup(async () => {
    // Contributed commands only show up in getCommands() once the extension has actually
    // activated and run its registerCommand calls — force that before any assertions run,
    // rather than relying on incidental activation order between tests.
    const extension = vscode.extensions.getExtension<ChevronApi>('MJEvansDev.chevron');
    api = (await extension?.activate())!;
  });

  test('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'chevron.selectCompareBranch',
      'chevron.diffCurrentFile',
      'chevron.showChangedFilesTree',
      'chevron.refreshChangedFiles',
      'chevron.openFileDiff',
    ]) {
      assert.ok(commands.includes(id), `expected command ${id} to be registered`);
    }
  });

  test('diffCurrentFile opens a diff editor against the selected branch', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected the fixture repo to be open as the workspace');

    const fileUri = vscode.Uri.joinPath(folder.uri, 'file.txt');
    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document);

    const restoreQuickPick = stubQuickPickSelection('other-branch');
    try {
      await vscode.commands.executeCommand('chevron.diffCurrentFile');
    } finally {
      restoreQuickPick();
    }

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const diffTab = tabs.find((tab) => tab.input instanceof vscode.TabInputTextDiff);
    assert.ok(diffTab, 'expected a diff editor tab to be open after diffCurrentFile');
  });

  test('diffCurrentFile opens a diff editor against a remote-tracking branch', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected the fixture repo to be open as the workspace');

    const fileUri = vscode.Uri.joinPath(folder.uri, 'file.txt');
    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document);

    // Explicitly select the branch first — diffCurrentFile only prompts when no comparison
    // branch is already set, and an earlier test in this suite may have already set one.
    const restoreQuickPick = stubQuickPickSelection('origin/main');
    try {
      await vscode.commands.executeCommand('chevron.selectCompareBranch');
      await vscode.commands.executeCommand('chevron.diffCurrentFile');
    } finally {
      restoreQuickPick();
    }

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const diffTab = tabs.find(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        // The query also carries `repo=<root>` (multi-repo), so compare the `branch` param only.
        new URLSearchParams(tab.input.original.query).get('branch') === 'origin/main',
    );
    assert.ok(diffTab, 'expected a diff editor tab open against origin/main');
  });

  test('selecting a branch shows its name on the tree view and reveals it', async () => {
    const restoreQuickPick = stubQuickPickSelection('other-branch');
    try {
      await vscode.commands.executeCommand('chevron.selectCompareBranch');
    } finally {
      restoreQuickPick();
    }

    // Set synchronously as soon as the branch changes; getChildren later appends an
    // ahead/behind suffix once the (async, subprocess-backed) git calls resolve — see the next
    // test, which waits for that richer form instead of asserting the plain name here.
    assert.ok(api.treeView.title?.toString().startsWith('other-branch'));
    await waitFor(() => api.treeView.visible);
  });

  test('tree view description eventually shows ahead/behind counts against the comparison branch', async () => {
    const restoreQuickPick = stubQuickPickSelection('other-branch');
    try {
      await vscode.commands.executeCommand('chevron.selectCompareBranch');
    } finally {
      restoreQuickPick();
    }

    // Fixture: `other-branch` has one commit main doesn't (behind), and main has one commit
    // `other-branch` doesn't (ahead) — see buildFixtureRepo.mjs.
    await waitFor(() => api.treeView.title === 'other-branch  ↓1 ↑1');
  });

  test('changed-files tree excludes commits unique to the comparison branch (merge-base diff)', async () => {
    const restoreQuickPick = stubQuickPickSelection('other-branch');
    try {
      await vscode.commands.executeCommand('chevron.selectCompareBranch');
    } finally {
      restoreQuickPick();
    }

    const files = flattenFiles(await api.treeProvider.getChildren());

    // A naive two-dot `git diff other-branch` would show this as deleted (it exists on
    // other-branch's tip but not on main) — the merge-base diff should exclude it entirely,
    // since it's not part of what changed since the branches forked.
    assert.ok(
      !files.some((file) => file.path === 'other-branch-only.txt'),
      'expected other-branch-only.txt to be excluded from a merge-base diff',
    );
  });

  test('changed-files tree includes untracked files with status U', async () => {
    const restoreQuickPick = stubQuickPickSelection('other-branch');
    try {
      await vscode.commands.executeCommand('chevron.selectCompareBranch');
    } finally {
      restoreQuickPick();
    }

    const files = flattenFiles(await api.treeProvider.getChildren());
    const untracked = files.find((file) => file.path === 'untracked.txt');

    assert.ok(untracked, 'expected untracked.txt to appear in the changed-files tree');
    assert.strictEqual(untracked?.status, 'U');
  });

  test('branch picker lists a linked worktree under a "Worktrees" section', async () => {
    const items = await captureQuickPickItems('chevron.selectCompareBranch');

    const separatorIndex = items.findIndex(
      (item) => item.kind === vscode.QuickPickItemKind.Separator && item.label === 'Worktrees',
    );
    assert.ok(separatorIndex >= 0, 'expected a "Worktrees" section in the branch picker');

    const worktreeItem = items[separatorIndex + 1];
    assert.strictEqual(worktreeItem.label, 'worktree-branch');
    assert.ok(
      worktreeItem.description?.includes('fixture-worktree'),
      'expected the worktree entry\'s description to name its directory',
    );
  });

  test('selecting a worktree entry sets a worktree comparison target', async () => {
    const restoreQuickPick = stubQuickPickSelection(
      (item) => item.label === 'worktree-branch' && Boolean(item.description?.includes('fixture-worktree')),
    );
    try {
      await vscode.commands.executeCommand('chevron.selectCompareBranch');
    } finally {
      restoreQuickPick();
    }

    const target = api.comparisonState.target;
    assert.strictEqual(target?.kind, 'worktree');
    assert.ok(target?.kind === 'worktree' && target.path.includes('fixture-worktree'));
    assert.strictEqual(target?.kind === 'worktree' ? target.label : undefined, 'worktree-branch');
  });

  test('changed-files tree reflects the other worktree\'s live uncommitted state, not its last commit', async () => {
    const restoreQuickPick = stubQuickPickSelection(
      (item) => item.label === 'worktree-branch' && Boolean(item.description?.includes('fixture-worktree')),
    );
    try {
      await vscode.commands.executeCommand('chevron.selectCompareBranch');
    } finally {
      restoreQuickPick();
    }

    const files = flattenFiles(await api.treeProvider.getChildren());
    const byPath = new Map(files.map((file) => [file.path, file]));

    // main's file.txt ("changed on main") differs from the worktree's uncommitted edit ("changed
    // in worktree, uncommitted") -- a diff against worktree-branch's last commit (still
    // "original") would also show this as modified, so this alone doesn't prove liveness, but
    // combined with the untracked-file assertions below it does.
    assert.strictEqual(byPath.get('file.txt')?.status, 'M');

    // Untracked in main only -- present on our side, absent on the worktree's.
    assert.strictEqual(byPath.get('untracked.txt')?.status, 'A');

    // Untracked in the worktree only, and never committed anywhere -- a branch-ref diff has no
    // way to ever see this file; only a live read of the other worktree's directory does.
    assert.strictEqual(byPath.get('worktree-untracked.txt')?.status, 'D');
  });

  test('diffing a file against a worktree target shows the worktree\'s uncommitted content', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected the fixture repo to be open as the workspace');

    const fileUri = vscode.Uri.joinPath(folder.uri, 'file.txt');
    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document);

    const restoreQuickPick = stubQuickPickSelection(
      (item) => item.label === 'worktree-branch' && Boolean(item.description?.includes('fixture-worktree')),
    );
    try {
      await vscode.commands.executeCommand('chevron.selectCompareBranch');
      await vscode.commands.executeCommand('chevron.diffCurrentFile');
    } finally {
      restoreQuickPick();
    }

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const diffTab = tabs.find(
      (tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.fsPath.includes('fixture-worktree'),
    );
    assert.ok(diffTab, 'expected a diff editor tab open against the worktree\'s own file');

    const otherUri = (diffTab!.input as vscode.TabInputTextDiff).original;
    const otherDocument = await vscode.workspace.openTextDocument(otherUri);
    assert.strictEqual(otherDocument.getText(), 'changed in worktree, uncommitted\n');
  });

  test('diffing a file that only exists in this worktree shows an empty document on the worktree side', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'expected the fixture repo to be open as the workspace');

    const fileUri = vscode.Uri.joinPath(folder.uri, 'untracked.txt');
    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document);

    const restoreQuickPick = stubQuickPickSelection(
      (item) => item.label === 'worktree-branch' && Boolean(item.description?.includes('fixture-worktree')),
    );
    try {
      await vscode.commands.executeCommand('chevron.selectCompareBranch');
      await vscode.commands.executeCommand('chevron.diffCurrentFile');
    } finally {
      restoreQuickPick();
    }

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const diffTab = tabs.find(
      (tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === 'chevron-empty',
    );
    assert.ok(diffTab, 'expected a diff editor tab whose other side is the empty virtual document');

    const otherDocument = await vscode.workspace.openTextDocument((diffTab!.input as vscode.TabInputTextDiff).original);
    assert.strictEqual(otherDocument.getText(), '');
  });

  test('changed-files tree reports a rename, with line counts keyed by path', async () => {
    await selectComparison('other-branch');

    const files = flattenFiles(await api.treeProvider.getChildren());
    const renamed = files.find((file) => file.path === 'renamed.txt');

    assert.ok(renamed, 'expected renamed.txt in the changed-files tree');
    assert.strictEqual(renamed?.status, 'R');
    assert.strictEqual(renamed?.previousPath, 'to-rename.txt');
    // Identical content, so +0 -0 — but defined: counts are attached by path, not dropped.
    assert.strictEqual(renamed?.additions, 0);
    assert.strictEqual(renamed?.deletions, 0);
    assert.ok(!files.some((file) => file.path === 'to-rename.txt'), 'expected the old path not to be listed separately');
  });

  test('changed-files tree handles spaces and non-ASCII characters in paths', async () => {
    await selectComparison('other-branch');

    const files = flattenFiles(await api.treeProvider.getChildren());
    const byPath = new Map(files.map((file) => [file.path, file]));

    const spaced = byPath.get('dir with space/file with space.txt');
    assert.strictEqual(spaced?.status, 'M');
    assert.strictEqual(spaced?.additions, 1);
    assert.strictEqual(spaced?.deletions, 1);

    assert.strictEqual(byPath.get('ünïcödé.txt')?.status, 'M');
  });

  test('untracked files get an added-line count', async () => {
    await selectComparison('other-branch');

    const files = flattenFiles(await api.treeProvider.getChildren());
    const untracked = files.find((file) => file.path === 'untracked.txt');

    assert.strictEqual(untracked?.status, 'U');
    assert.strictEqual(untracked?.additions, 1);
  });

  test('opening a diff for a file with spaces in its path shows the merge-base content', async () => {
    await selectComparison('other-branch');
    await vscode.commands.executeCommand('chevron.openFileDiff', 'dir with space/file with space.txt');

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const diffTab = tabs.find(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.original.scheme === 'chevron-ref' &&
        tab.input.original.path === '/dir with space/file with space.txt',
    );
    assert.ok(diffTab, 'expected a diff tab for the file with spaces');

    const original = await vscode.workspace.openTextDocument((diffTab!.input as vscode.TabInputTextDiff).original);
    assert.strictEqual(original.getText(), 'before\n');
  });

  test('branch picker lists tags under a "Tags" section, and a tag can be compared against', async () => {
    const items = await captureQuickPickItems('chevron.selectCompareBranch');
    const separatorIndex = items.findIndex(
      (item) => item.kind === vscode.QuickPickItemKind.Separator && item.label === 'Tags',
    );
    assert.ok(separatorIndex >= 0, 'expected a "Tags" section in the branch picker');
    assert.ok(
      items.slice(separatorIndex + 1).some((item) => item.label === 'v0.1'),
      'expected v0.1 under the Tags section',
    );

    // No branch in the fixture is called v0.1, so the only row with that label is the tag's.
    await selectComparison('v0.1');

    assert.deepStrictEqual(api.comparisonState.target, { kind: 'branch', name: 'v0.1' });
    const files = flattenFiles(await api.treeProvider.getChildren());
    const byPath = new Map(files.map((file) => [file.path, file]));
    // v0.1 is the fork point, so this matches the other-branch comparison.
    assert.strictEqual(byPath.get('renamed.txt')?.status, 'R');
    assert.strictEqual(byPath.get('new-file.txt')?.status, 'A');
    await waitFor(() => api.treeView.title?.toString().startsWith('v0.1') ?? false);
  });

  test('"Enter a ref" accepts a commit SHA and labels it by its short form', async () => {
    const sha = fixtureGit(['rev-parse', 'v0.1^{commit}']);

    const restoreInputBox = stubInputBox(sha);
    try {
      await selectComparison((item) => item.label.includes('Enter a tag, commit SHA or ref'));
    } finally {
      restoreInputBox();
    }

    assert.deepStrictEqual(api.comparisonState.target, { kind: 'branch', name: sha });
    assert.ok(api.treeView.title?.toString().startsWith(sha.slice(0, 7)));
    assert.ok(!api.treeView.title?.toString().includes(sha), 'expected the full SHA to be abbreviated');

    const files = flattenFiles(await api.treeProvider.getChildren());
    assert.ok(files.some((file) => file.path === 'renamed.txt'));
  });

  test('"Enter a ref" rejects something that is not a commit', async () => {
    await selectComparison('other-branch');

    const restoreInputBox = stubInputBox('definitely-not-a-ref');
    try {
      await selectComparison((item) => item.label.includes('Enter a tag, commit SHA or ref'));
    } finally {
      restoreInputBox();
    }

    assert.deepStrictEqual(api.comparisonState.target, { kind: 'branch', name: 'other-branch' });
  });

  test('a comparison branch deleted after selection is cleared on refresh', async () => {
    await selectComparison('doomed-branch');
    assert.deepStrictEqual(api.comparisonState.target, { kind: 'branch', name: 'doomed-branch' });

    fixtureGit(['branch', '-D', 'doomed-branch']);
    await vscode.commands.executeCommand('chevron.refreshChangedFiles');

    await waitFor(() => api.comparisonState.target === undefined);
    assert.deepStrictEqual(await api.treeProvider.getChildren(), []);
    assert.strictEqual(api.treeView.message, undefined);
  });
});
