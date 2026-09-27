import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { ChevronApi } from '../../src/extension';
import type { TreeNode } from '../../src/treeBuilder';

// `← Take from <branch>` (per-hunk apply) and cross-file change navigation, against the fixture
// built by test/setup/buildFixtureRepo.mjs. Against `other-branch` (merge-base = the initial
// commit):
//   hunks.txt — line 2 modified, line 5 deleted, "added on main" added after line 8
//               → hunks anchored at 0-based lines 1, 4 and 7 of the working file.
//   crlf.txt  — CRLF file, line 2 modified.
//   new-file.txt — added on main (no old side), untracked.txt — untracked (no old side).
// This suite runs after extension.test.ts (Mocha loads files alphabetically) in the same VS Code
// instance, so every test leaves each document it touched un-dirty (undo/revert, never save).

const TAKE = 'chevron.takeHunkFromBranch';

const HUNKS_ON_MAIN =
  [
    'line 1',
    'line 2 changed on main',
    'line 3',
    'line 4',
    'line 6',
    'line 7',
    'line 8',
    'added on main',
    'line 9',
    'line 10',
  ].join('\n') + '\n';

/** `to-rename.txt` at the merge-base with other-branch — main renamed it to `renamed.txt` unchanged. */
const RENAMED_CONTENT = Array.from({ length: 20 }, (_, i) => `rename me, line ${i + 1}`).join('\n') + '\n';

function stubQuickPickSelection(match: (item: vscode.QuickPickItem) => boolean): () => void {
  const windowWithStub = vscode.window as unknown as { showQuickPick: typeof vscode.window.showQuickPick };
  const original = windowWithStub.showQuickPick;
  windowWithStub.showQuickPick = (async (items: vscode.QuickPickItem[]) =>
    items.find(match)) as unknown as typeof vscode.window.showQuickPick;
  return () => {
    windowWithStub.showQuickPick = original;
  };
}

async function selectTarget(match: (item: vscode.QuickPickItem) => boolean): Promise<void> {
  const restore = stubQuickPickSelection(match);
  try {
    await vscode.commands.executeCommand('chevron.selectCompareBranch');
  } finally {
    restore();
  }
}

/** The picker prefixes the currently compared entry with `$(check) ` — match either form. */
const bareLabel = (item: vscode.QuickPickItem) => item.label.replace(/^\$\(check\) /, '');

const selectOtherBranch = () =>
  selectTarget((item) => bareLabel(item) === 'other-branch' && !item.description?.includes('fixture-worktree'));
const selectWorktree = () =>
  selectTarget((item) => bareLabel(item) === 'worktree-branch' && Boolean(item.description?.includes('fixture-worktree')));

/**
 * `undo` acts on the *focused* editor. Selecting a comparison target reveals the changed-files view
 * (see extension.ts), which can take focus — put it back on the diff editor's working-tree pane.
 */
async function undo(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await vscode.commands.executeCommand('undo');
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function fileUri(relativePath: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'expected the fixture repo to be open as the workspace');
  return vscode.Uri.joinPath(folder.uri, relativePath);
}

/** Opens the Chevron diff for `relativePath` and returns its working-tree document (focused). */
async function openChevronDiff(relativePath: string): Promise<vscode.TextDocument> {
  const uri = fileUri(relativePath);
  await vscode.commands.executeCommand('chevron.openFileDiff', relativePath);
  await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString());
  return vscode.window.activeTextEditor!.document;
}

async function takeLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)) ?? [];
  return lenses.filter((lens) => lens.command?.command === TAKE).sort((a, b) => a.range.start.line - b.range.start.line);
}

async function runLens(lens: vscode.CodeLens): Promise<boolean> {
  return (await vscode.commands.executeCommand<boolean>(lens.command!.command, ...(lens.command!.arguments ?? [])))!;
}

/** Like `waitFor`, for a predicate that has to ask VS Code something asynchronously. */
async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function fixtureGit(args: string[]): string {
  const folder = vscode.workspace.workspaceFolders![0];
  return execFileSync('git', args, { cwd: folder.uri.fsPath, encoding: 'utf8' }).trim();
}

/** The original (branch/other) side of the open diff tab whose working-tree side is `uri`. */
function originalPaneOf(uri: vscode.Uri): vscode.Uri | undefined {
  for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
    if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === uri.toString()) {
      return tab.input.original;
    }
  }
  return undefined;
}

function flattenFiles(nodes: TreeNode[]): Extract<TreeNode, { kind: 'file' }>[] {
  return nodes.flatMap((node) => (node.kind === 'folder' ? flattenFiles(node.children) : [node]));
}

/** Reverts every dirty document and closes all editors, so the next test starts clean. */
async function resetEditors(): Promise<void> {
  for (const document of vscode.workspace.textDocuments) {
    if (document.isDirty && document.uri.scheme === 'file') {
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

suite('Take from branch & change navigation', () => {
  let api: ChevronApi;

  suiteSetup(async () => {
    api = (await vscode.extensions.getExtension<ChevronApi>('MJEvansDev.chevron')?.activate())!;
  });

  setup(async () => {
    await resetEditors();
    await selectOtherBranch();
  });

  suiteTeardown(async () => {
    await resetEditors();
  });

  test('registers the take and navigation commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [TAKE, 'chevron.nextChange', 'chevron.previousChange']) {
      assert.ok(commands.includes(id), `expected command ${id} to be registered`);
    }
  });

  test('shows one "← Take from <branch>" lens per hunk, at each hunk\'s head', async () => {
    const document = await openChevronDiff('hunks.txt');
    const lenses = await takeLenses(document.uri);
    assert.deepStrictEqual(
      lenses.map((lens) => lens.range.start.line),
      [1, 4, 7],
    );
    for (const lens of lenses) {
      assert.strictEqual(lens.command?.title, '← Take from other-branch');
    }
  });

  test('taking a modified hunk restores the branch text, leaves the file dirty and unsaved, and one undo reverts it', async () => {
    const document = await openChevronDiff('hunks.txt');
    const [modified] = await takeLenses(document.uri);

    assert.strictEqual(await runLens(modified), true);
    assert.strictEqual(document.getText(), HUNKS_ON_MAIN.replace('line 2 changed on main', 'line 2'));
    assert.ok(document.isDirty, 'expected the take to leave the document dirty, not saved');
    assert.strictEqual(fs.readFileSync(document.uri.fsPath, 'utf8'), HUNKS_ON_MAIN, 'expected the file on disk untouched');

    await undo();
    assert.strictEqual(document.getText(), HUNKS_ON_MAIN, 'expected a single undo to restore the hunk');
    assert.ok(!document.isDirty);
  });

  test('taking a pure-deletion hunk re-inserts the deleted line; one undo reverts it', async () => {
    const document = await openChevronDiff('hunks.txt');
    const lenses = await takeLenses(document.uri);
    const deletion = lenses.find((lens) => lens.range.start.line === 4);
    assert.ok(deletion);

    assert.strictEqual(await runLens(deletion!), true);
    assert.strictEqual(document.getText(), HUNKS_ON_MAIN.replace('line 4\n', 'line 4\nline 5\n'));

    await undo();
    assert.strictEqual(document.getText(), HUNKS_ON_MAIN);
  });

  test('taking a pure-addition hunk removes the added line; one undo reverts it', async () => {
    const document = await openChevronDiff('hunks.txt');
    const lenses = await takeLenses(document.uri);
    const addition = lenses.find((lens) => lens.range.start.line === 7);
    assert.ok(addition);

    assert.strictEqual(await runLens(addition!), true);
    assert.strictEqual(document.getText(), HUNKS_ON_MAIN.replace('added on main\n', ''));

    await undo();
    assert.strictEqual(document.getText(), HUNKS_ON_MAIN);
  });

  test('taking every hunk in turn reproduces the branch version exactly', async () => {
    const document = await openChevronDiff('hunks.txt');
    for (let guard = 0; guard < 5; guard++) {
      const [lens] = await takeLenses(document.uri);
      if (!lens) {
        break;
      }
      assert.strictEqual(await runLens(lens), true);
    }
    assert.strictEqual(document.getText(), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    assert.strictEqual((await takeLenses(document.uri)).length, 0, 'expected no lenses once the file matches the branch');
  });

  test('keeps a CRLF file CRLF', async () => {
    const document = await openChevronDiff('crlf.txt');
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    const [lens] = await takeLenses(document.uri);
    assert.ok(lens);

    assert.strictEqual(await runLens(lens), true);
    assert.strictEqual(document.getText(), 'alpha\r\nbeta\r\ngamma\r\n');

    await undo();
    assert.strictEqual(document.getText(), 'alpha\r\nBETA on main\r\ngamma\r\n');
  });

  test('computes hunks from the unsaved buffer, not the file on disk', async () => {
    const document = await openChevronDiff('hunks.txt');
    const insert = new vscode.WorkspaceEdit();
    insert.insert(document.uri, new vscode.Position(0, 0), 'unsaved line\n');
    assert.ok(await vscode.workspace.applyEdit(insert));

    const lenses = await takeLenses(document.uri);
    // The unsaved insert is itself a hunk at line 0, and every other hunk shifts down by one.
    assert.deepStrictEqual(
      lenses.map((lens) => lens.range.start.line),
      [0, 2, 5, 8],
    );

    const modified = lenses.find((lens) => lens.range.start.line === 2)!;
    assert.strictEqual(await runLens(modified), true);
    assert.strictEqual(document.getText(), `unsaved line\n${HUNKS_ON_MAIN.replace('line 2 changed on main', 'line 2')}`);
  });

  test('refuses a stale lens after the document changed above the hunk, without touching the file', async () => {
    const document = await openChevronDiff('hunks.txt');
    const lenses = await takeLenses(document.uri);
    const modified = lenses[0];

    const insert = new vscode.WorkspaceEdit();
    insert.insert(document.uri, new vscode.Position(0, 0), 'edited after the lens was shown\n');
    assert.ok(await vscode.workspace.applyEdit(insert));
    const textBefore = document.getText();

    assert.strictEqual(await runLens(modified), false);
    assert.strictEqual(document.getText(), textBefore, 'expected a stale take to change nothing');
  });

  test('refuses a stale lens after the hunk itself was edited', async () => {
    const document = await openChevronDiff('hunks.txt');
    const [modified] = await takeLenses(document.uri);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(1, 0, 1, document.lineAt(1).text.length), 'line 2 edited again');
    assert.ok(await vscode.workspace.applyEdit(edit));
    const textBefore = document.getText();

    assert.strictEqual(await runLens(modified), false);
    assert.strictEqual(document.getText(), textBefore);
  });

  test('takes the hunk under the cursor when invoked without arguments', async () => {
    const document = await openChevronDiff('hunks.txt');
    const editor = vscode.window.activeTextEditor!;
    editor.selection = new vscode.Selection(1, 3, 1, 3);

    assert.strictEqual(await vscode.commands.executeCommand<boolean>(TAKE), true);
    assert.strictEqual(document.getText(), HUNKS_ON_MAIN.replace('line 2 changed on main', 'line 2'));
  });

  test('offers nothing for an untracked file or a file added since the merge-base', async () => {
    for (const relativePath of ['untracked.txt', 'new-file.txt']) {
      const document = await openChevronDiff(relativePath);
      assert.strictEqual((await takeLenses(document.uri)).length, 0, `expected no take lenses on ${relativePath}`);
    }
  });

  test('offers nothing on the read-only branch pane', async () => {
    await openChevronDiff('hunks.txt');
    const diffTab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === 'chevron-ref');
    assert.ok(diffTab);
    const original = (diffTab!.input as vscode.TabInputTextDiff).original;
    await vscode.workspace.openTextDocument(original);
    assert.strictEqual((await takeLenses(original)).length, 0);
  });

  test('offers nothing when the file is not open in a Chevron diff', async () => {
    const document = await vscode.workspace.openTextDocument(fileUri('hunks.txt'));
    await vscode.window.showTextDocument(document);
    assert.strictEqual((await takeLenses(document.uri)).length, 0);
  });

  test('next/previous change walk the hunks, then roll over into the next/previous changed file', async () => {
    await openChevronDiff('hunks.txt');
    const editor = vscode.window.activeTextEditor!;
    editor.selection = new vscode.Selection(0, 0, 0, 0);

    const expectAt = (suffix: string, line: number) => {
      const active = vscode.window.activeTextEditor!;
      assert.ok(active.document.uri.fsPath.endsWith(suffix), `expected to be in ${suffix}, was ${active.document.uri.fsPath}`);
      assert.strictEqual(active.selection.active.line, line);
    };

    await vscode.commands.executeCommand('chevron.nextChange');
    expectAt('hunks.txt', 1);
    await vscode.commands.executeCommand('chevron.nextChange');
    expectAt('hunks.txt', 4);
    await vscode.commands.executeCommand('chevron.nextChange');
    expectAt('hunks.txt', 7);

    // Tree order against other-branch: crlf.txt, file.txt, hunks.txt, new-file.txt, untracked.txt.
    await vscode.commands.executeCommand('chevron.nextChange');
    expectAt('new-file.txt', 0);
    const newFileTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(newFileTab instanceof vscode.TabInputTextDiff, 'expected the next file to open in a Chevron diff');

    await vscode.commands.executeCommand('chevron.previousChange');
    expectAt('hunks.txt', 7);
    await vscode.commands.executeCommand('chevron.previousChange');
    expectAt('hunks.txt', 4);
  });

  test('previous change from the first hunk rolls back to the previous file\'s last hunk', async () => {
    await openChevronDiff('hunks.txt');
    vscode.window.activeTextEditor!.selection = new vscode.Selection(1, 0, 1, 0);

    await vscode.commands.executeCommand('chevron.previousChange');
    const active = vscode.window.activeTextEditor!;
    assert.ok(active.document.uri.fsPath.endsWith('file.txt') && !active.document.uri.fsPath.endsWith('hunks.txt'));
    assert.strictEqual(active.selection.active.line, 0);
  });

  test('against a worktree target, takes from the other worktree\'s live file', async () => {
    await selectWorktree();
    try {
      const document = await openChevronDiff('file.txt');
      const [lens] = await takeLenses(document.uri);
      assert.ok(lens, 'expected a take lens against the worktree');
      assert.strictEqual(lens.command?.title, '← Take from worktree-branch');

      assert.strictEqual(await runLens(lens), true);
      assert.strictEqual(document.getText(), 'changed in worktree, uncommitted\n');

      await undo();
      assert.strictEqual(document.getText(), 'changed on main\n');

      // The worktree side is a real file:// document too, but it's the *original* pane — never offered.
      const diffTab = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .find((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.fsPath.includes('fixture-worktree'));
      assert.ok(diffTab);
      assert.strictEqual((await takeLenses((diffTab!.input as vscode.TabInputTextDiff).original)).length, 0);
    } finally {
      await resetEditors();
      await selectOtherBranch();
    }
  });

  test("opening a renamed file's diff from the tree shows its old content, and takes from it", async () => {
    const files = flattenFiles(await api.treeProvider.getChildren());
    const renamed = files.find((file) => file.path === 'renamed.txt');
    assert.ok(renamed, 'expected renamed.txt in the changed-files tree');
    assert.strictEqual(renamed!.previousPath, 'to-rename.txt');

    // Click the tree item: run exactly the command (and arguments) it carries.
    const item = api.treeProvider.getTreeItem(renamed!);
    await vscode.commands.executeCommand(item.command!.command, ...(item.command!.arguments ?? []));
    const uri = fileUri('renamed.txt');
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === uri.toString());
    const document = vscode.window.activeTextEditor!.document;

    const pane = originalPaneOf(uri);
    assert.ok(pane && pane.scheme === 'chevron-ref', 'expected a Chevron branch pane on the left');
    assert.strictEqual((await vscode.workspace.openTextDocument(pane!)).getText(), RENAMED_CONTENT);
    assert.strictEqual((await takeLenses(uri)).length, 0, 'expected no changes: the rename kept the content');

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, 0, document.lineAt(0).text.length), 'edited after the rename');
    assert.ok(await vscode.workspace.applyEdit(edit));
    const lenses = await takeLenses(uri);
    assert.strictEqual(lenses.length, 1);
    assert.strictEqual(await runLens(lenses[0]), true);
    assert.strictEqual(document.getText(), RENAMED_CONTENT);
  });

  test("diffing the current file finds a rename's old path by itself", async () => {
    const document = await vscode.workspace.openTextDocument(fileUri('renamed.txt'));
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('chevron.diffCurrentFile');
    await waitFor(() => originalPaneOf(document.uri) !== undefined);
    const pane = originalPaneOf(document.uri)!;
    assert.strictEqual(pane.path, '/to-rename.txt');
    assert.strictEqual((await vscode.workspace.openTextDocument(pane)).getText(), RENAMED_CONTENT);
  });

  // Runs last: it creates (and deletes again) a throwaway branch in the shared fixture repo.
  test('re-reads an open branch pane when the merge-base moves, and the take lenses follow', async () => {
    const branch = 'chevron-moving-base';
    // Forked at the initial commit, like other-branch: hunks.txt's merge-base content is the original.
    fixtureGit(['branch', '-f', branch, 'other-branch']);
    try {
      await selectTarget((item) => bareLabel(item) === branch);
      const document = await openChevronDiff('hunks.txt');
      const paneUri = originalPaneOf(document.uri);
      assert.ok(paneUri && paneUri.scheme === 'chevron-ref');
      const pane = await vscode.workspace.openTextDocument(paneUri!);
      const hunksBase = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
      assert.strictEqual(pane.getText(), hunksBase);
      assert.strictEqual((await takeLenses(document.uri)).length, 3);

      // Move the merge-base without touching HEAD or the working tree (as a merge of main into
      // this branch would): it's now main's tip, where hunks.txt matches the working file.
      fixtureGit(['branch', '-f', branch, 'main']);
      await vscode.commands.executeCommand('chevron.refreshChangedFiles');

      await waitFor(() => pane.getText() === HUNKS_ON_MAIN, 10000);
      // The same URI, reopened (e.g. from the refreshed tree), must serve the new content too.
      assert.strictEqual((await vscode.workspace.openTextDocument(paneUri!)).getText(), HUNKS_ON_MAIN);
      // Taking would now be a no-op — not a revert of main's own changes.
      await waitForAsync(async () => (await takeLenses(document.uri)).length === 0);
    } finally {
      await resetEditors();
      await selectOtherBranch();
      fixtureGit(['branch', '-D', branch]);
    }
  });
});
