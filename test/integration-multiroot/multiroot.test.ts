import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChevronApi } from '../../src/extension';
import type { TreeNode } from '../../src/treeBuilder';

// Multi-root / multi-repo and settings, against the .code-workspace built
// by test/setup/buildFixtureRepo.mjs:
//   repo-a (on `feature`, forked from `main`), repo-b (on `main`, plus `release`), repo-a/nested (a
//   second folder in repo-a) and not-a-repo. Fresh user-data dir each run → no stored state.
// Tests run in order and build on each other's state (active repo, targets).

function flattenFiles(nodes: TreeNode[]): Extract<TreeNode, { kind: 'file' }>[] {
  return nodes.flatMap((node) => (node.kind === 'folder' ? flattenFiles(node.children) : [node]));
}

function stubQuickPickSelection(match: (item: vscode.QuickPickItem) => boolean): () => void {
  const windowWithStub = vscode.window as unknown as { showQuickPick: typeof vscode.window.showQuickPick };
  const original = windowWithStub.showQuickPick;
  windowWithStub.showQuickPick = (async (items: vscode.QuickPickItem[]) =>
    items.find(match)) as unknown as typeof vscode.window.showQuickPick;
  return () => {
    windowWithStub.showQuickPick = original;
  };
}

async function runWithQuickPick(command: string, match: (item: vscode.QuickPickItem) => boolean): Promise<void> {
  const restore = stubQuickPickSelection(match);
  try {
    await vscode.commands.executeCommand(command);
  } finally {
    restore();
  }
}

/** The picker prefixes the currently compared entry with `$(check) ` — match either form. */
const bareLabel = (item: vscode.QuickPickItem) => item.label.replace(/^\$\(check\) /, '');

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function folder(name: string): vscode.WorkspaceFolder {
  const match = vscode.workspace.workspaceFolders?.find((candidate) => candidate.name === name);
  assert.ok(match, `expected workspace folder ${name}`);
  return match;
}

function sameDir(a: string, b: string): boolean {
  return path.relative(a, b) === '';
}

async function showFile(folderName: string, relativePath: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder(folderName).uri, relativePath));
  return vscode.window.showTextDocument(document);
}

suite('Chevron multi-root workspace', () => {
  let api: ChevronApi;
  let repoA: string;
  let repoB: string;

  suiteSetup(async () => {
    api = (await vscode.extensions.getExtension<ChevronApi>('MJEvansDev.chevron')!.activate())!;
    repoA = folder('repo-a').uri.fsPath;
    repoB = folder('repo-b').uri.fsPath;
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('discovers each repo once, skipping folders that are not repos', () => {
    const roots = api.repositories.repositories;
    const multiRoot = path.dirname(repoA);
    const inFixture = roots.filter((root) => !path.relative(multiRoot, root).startsWith('..'));
    assert.strictEqual(inFixture.length, 2, `expected repo-a and repo-b only, got ${inFixture.join(', ')}`);
    assert.ok(inFixture.some((root) => sameDir(root, repoA)));
    assert.ok(inFixture.some((root) => sameDir(root, repoB)));
    assert.ok(!roots.some((root) => sameDir(root, folder('not-a-repo').uri.fsPath)));
    assert.ok(!roots.some((root) => sameDir(root, folder('nested').uri.fsPath)), 'repo-a/nested is part of repo-a');
  });

  test('auto-selects the default branch per repo, never the checked-out branch', () => {
    // repo-a is on `feature`, and `main` exists → main.
    assert.deepStrictEqual(api.comparisonState.getTarget(repoA), { kind: 'branch', name: 'main' });
    // repo-b is on `main`; no origin/main, no master → nothing.
    assert.strictEqual(api.comparisonState.getTarget(repoB), undefined);
  });

  test('registers chevron.selectRepository', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['chevron.selectRepository', 'chevron.viewAsList', 'chevron.viewAsTree']) {
      assert.ok(commands.includes(id), `expected command ${id} to be registered`);
    }
  });

  test('the active repo follows the active editor', async () => {
    await showFile('repo-b', 'b.txt');
    await waitFor(() => sameDir(api.repositories.activeRepository ?? '', repoB));

    // A file opened through the nested folder still belongs to repo-a.
    await showFile('nested', 'deeper/n.txt');
    await waitFor(() => sameDir(api.repositories.activeRepository ?? '', repoA));

    // A file outside every repo leaves the active repo alone.
    await showFile('not-a-repo', 'readme.txt');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(sameDir(api.repositories.activeRepository ?? '', repoA));
  });

  test('the tree view description names the active repo', async () => {
    await showFile('repo-a', 'a.txt');
    await waitFor(() => sameDir(api.repositories.activeRepository ?? '', repoA));
    await api.treeProvider.getChildren();
    await waitFor(() => api.treeView.title?.toString().startsWith('repo-a · main') ?? false);
  });

  test('selecting a branch sets the target for the active repo only', async () => {
    await showFile('repo-b', 'b.txt');
    await waitFor(() => sameDir(api.repositories.activeRepository ?? '', repoB));

    await runWithQuickPick('chevron.selectCompareBranch', (item) => bareLabel(item) === 'release');

    assert.deepStrictEqual(api.comparisonState.getTarget(repoB), { kind: 'branch', name: 'release' });
    assert.deepStrictEqual(api.comparisonState.getTarget(repoA), { kind: 'branch', name: 'main' });
    assert.deepStrictEqual(api.comparisonState.target, { kind: 'branch', name: 'release' });

    const files = flattenFiles(await api.treeProvider.getChildren());
    const paths = files.map((file) => file.path).sort();
    assert.deepStrictEqual(paths, ['b-untracked.txt', 'b.txt', 'src/added.txt']);
    await waitFor(() => api.treeView.title?.toString().startsWith('repo-b · release') ?? false);
  });

  test('diffCurrentFile uses the repo and target of the file, not the tree', async () => {
    // A repo-a file (opened through the nested folder) in the editor, while the tree is switched
    // back to repo-b (whose target is `release`) — the diff must still be repo-a's, against `main`.
    const editor = await showFile('nested', 'deeper/n.txt');
    await waitFor(() => sameDir(api.repositories.activeRepository ?? '', repoA));
    await runWithQuickPick('chevron.selectRepository', (item) => item.label === 'repo-b');
    assert.ok(sameDir(api.repositories.activeRepository ?? '', repoB));
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), editor.document.uri.toString());

    await vscode.commands.executeCommand('chevron.diffCurrentFile');

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const diffTab = tabs.find(
      (tab) =>
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.modified.toString() === editor.document.uri.toString() &&
        tab.input.original.scheme === 'chevron-ref',
    );
    assert.ok(diffTab, 'expected a Chevron diff tab for repo-a/nested/deeper/n.txt');
    const original = (diffTab!.input as vscode.TabInputTextDiff).original;
    const params = new URLSearchParams(original.query);
    assert.strictEqual(params.get('branch'), 'main');
    assert.ok(sameDir(params.get('repo') ?? '', repoA));
    assert.strictEqual(original.path, '/nested/deeper/n.txt');
    assert.strictEqual((await vscode.workspace.openTextDocument(original)).getText(), 'nested on main\n');
  });

  test('chevron.selectRepository switches the active repo', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await runWithQuickPick('chevron.selectRepository', (item) => item.label === 'repo-b');
    assert.ok(sameDir(api.repositories.activeRepository ?? '', repoB));
    await runWithQuickPick('chevron.selectRepository', (item) => item.label === 'repo-a');
    assert.ok(sameDir(api.repositories.activeRepository ?? '', repoA));
    assert.deepStrictEqual(api.comparisonState.target, { kind: 'branch', name: 'main' });
  });

  test('chevron.treeLayout "list" flattens the view, with each file\'s directory', async () => {
    const config = vscode.workspace.getConfiguration('chevron');
    await config.update('treeLayout', 'list', vscode.ConfigurationTarget.Workspace);
    try {
      const nodes = await api.treeProvider.getChildren();
      assert.ok(nodes.every((node) => node.kind === 'file'), 'expected no folder nodes in list layout');
      const nested = nodes.find((node) => node.path === 'nested/deeper/n.txt');
      assert.ok(nested && nested.kind === 'file');
      assert.strictEqual(nested.name, 'n.txt');
      assert.strictEqual(nested.directory, 'nested/deeper');
    } finally {
      await config.update('treeLayout', undefined, vscode.ConfigurationTarget.Workspace);
    }
    const nodes = await api.treeProvider.getChildren();
    assert.ok(nodes.some((node) => node.kind === 'folder'), 'expected folders again in tree layout');
  });

  test('chevron.showUntrackedFiles false hides untracked files', async () => {
    await runWithQuickPick('chevron.selectRepository', (item) => item.label === 'repo-b');
    const config = vscode.workspace.getConfiguration('chevron');
    await config.update('showUntrackedFiles', false, vscode.ConfigurationTarget.Workspace);
    try {
      const files = flattenFiles(await api.treeProvider.getChildren());
      assert.ok(!files.some((file) => file.path === 'b-untracked.txt'));
      assert.ok(files.some((file) => file.path === 'b.txt'));
    } finally {
      await config.update('showUntrackedFiles', undefined, vscode.ConfigurationTarget.Workspace);
    }
    const files = flattenFiles(await api.treeProvider.getChildren());
    assert.ok(files.some((file) => file.path === 'b-untracked.txt'));
  });

  test('chevron.defaultComparisonBranch auto-selects for a repo with no target when changed', async () => {
    await api.comparisonState.clearTarget(repoB);
    assert.strictEqual(api.comparisonState.getTarget(repoB), undefined);

    const config = vscode.workspace.getConfiguration('chevron');
    await config.update('defaultComparisonBranch', 'release', vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => api.comparisonState.getTarget(repoB)?.kind === 'branch');
      assert.deepStrictEqual(api.comparisonState.getTarget(repoB), { kind: 'branch', name: 'release' });
      // repo-a already had a target — untouched.
      assert.deepStrictEqual(api.comparisonState.getTarget(repoA), { kind: 'branch', name: 'main' });
    } finally {
      await config.update('defaultComparisonBranch', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
