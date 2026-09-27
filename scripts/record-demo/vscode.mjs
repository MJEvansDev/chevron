// An isolated VS Code instance for recording: its own user-data and extensions directories (the
// user's profile, theme and extensions stay out of the shot and untouched), a fixed 1280 × 800
// window, and a Chrome DevTools Protocol port the takes drive it through.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sleep } from './session.mjs';

export const WINDOW = { width: 1280, height: 800 };

// Storyboard §1.2, plus what the automated takes showed was needed to keep incidental chrome out:
// occurrence/selection highlights light up every `export` after an Alt+F7 jump, the lightbulb
// appears wherever a click lands, and editor hovers pop up wherever the pointer rests.
export const BASE_SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern',
  'editor.fontSize': 15,
  'editor.lineHeight': 22,
  'window.zoomLevel': 0,
  'editor.minimap.enabled': false,
  'breadcrumbs.enabled': false,
  'editor.stickyScroll.enabled': false,
  'editor.cursorBlinking': 'solid',
  'editor.renderLineHighlight': 'none',
  'editor.occurrencesHighlight': 'off',
  'editor.selectionHighlight': false,
  'editor.lightbulb.enabled': 'off',
  'editor.hover.enabled': false,
  'window.title': 'acme-shop',
  'window.commandCenter': false,
  'workbench.layoutControl.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'chat.commandCenter.enabled': false,
  'chat.disableAIFeatures': true,
  'update.mode': 'none',
  'update.showReleaseNotes': false,
  'extensions.ignoreRecommendations': true,
  'telemetry.telemetryLevel': 'off',
  'security.workspace.trust.enabled': false,
  'git.autofetch': false,
  'diffEditor.codeLens': true,
  'diffEditor.renderSideBySide': true,
  'diffEditor.hideUnchangedRegions.enabled': false,
  'diffEditor.experimental.showMoves': false,
  'chevron.autoSelectComparisonBranch': false,
};

/** The Electron binary behind the `code` CLI (the CLI wrapper swallows --remote-debugging-port). */
export function findVSCodeBinary() {
  if (process.env.VSCODE_BIN) return process.env.VSCODE_BIN;
  const candidates = [];
  try {
    // macOS: /usr/local/bin/code → …/Visual Studio Code.app/Contents/Resources/app/bin/code
    const cli = fs.realpathSync(execFileSync('which', ['code'], { encoding: 'utf8' }).trim());
    const contents = path.resolve(path.dirname(cli), '../../..');
    candidates.push(path.join(contents, 'MacOS/Code'), path.join(contents, 'MacOS/Electron'));
    // Linux: /usr/share/code/bin/code → /usr/share/code/code
    candidates.push(path.resolve(path.dirname(cli), '../code'));
  } catch {
    // no `code` on PATH — fall through to the default install location
  }
  candidates.push('/Applications/Visual Studio Code.app/Contents/MacOS/Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  const found = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  if (!found) throw new Error('record-demo: VS Code not found. Set VSCODE_BIN to its Electron binary.');
  return found;
}

// Everything VS Code sets in its own children. Inherited from a parent VS Code (an integrated
// terminal, or an agent running in an extension host), ELECTRON_RUN_AS_NODE makes the binary
// start as plain Node ("bad option: --user-data-dir") and VSCODE_IPC_HOOK points it at the
// parent instance.
function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === 'ELECTRON_RUN_AS_NODE' || (name.startsWith('VSCODE_') && name !== 'VSCODE_BIN' && name !== 'VSCODE_CLI')) delete env[name];
  }
  return env;
}

export class RecordingVSCode {
  /**
   * `root` holds the user-data dir, extensions and takes. Keep it short: VS Code's IPC socket
   * lives in the user-data dir and macOS caps socket paths at 103 bytes.
   */
  constructor({ root = path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'chevron-record'), port = 9333 } = {}) {
    this.root = root;
    this.userData = path.join(root, 'u');
    this.extensions = path.join(root, 'ext');
    this.port = port;
    this.binary = findVSCodeBinary();
    fs.mkdirSync(path.join(this.userData, 'User'), { recursive: true });
    fs.mkdirSync(this.extensions, { recursive: true });
  }

  installExtension(vsix) {
    // The `code` CLI wrapper, not the Electron binary: installing is a CLI-only operation.
    execFileSync(process.env.VSCODE_CLI ?? 'code', ['--user-data-dir', this.userData, '--extensions-dir', this.extensions, '--install-extension', vsix, '--force'], {
      env: cleanEnv(),
      stdio: 'ignore',
    });
  }

  writeSettings(overrides = {}) {
    const file = path.join(this.userData, 'User', 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ ...BASE_SETTINGS, ...overrides }, null, 2));
  }

  /** Opens `folder` in a fresh 1280 × 800 window and waits until the Chevron view can be opened. */
  async launch(folder) {
    await this.quit();
    this.presetWindowSize();
    this.child = spawn(this.binary, ['--user-data-dir', this.userData, '--extensions-dir', this.extensions, `--remote-debugging-port=${this.port}`, '--new-window', folder], {
      env: cleanEnv(),
      stdio: 'ignore',
    });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        if (targets.some((t) => t.type === 'page' && t.url.includes('workbench'))) break;
      } catch {
        // not listening yet
      }
      await sleep(300);
    }
    if (Date.now() >= deadline) throw new Error('record-demo: VS Code did not open a debuggable window.');
  }

  /**
   * VS Code restores the last window's bounds from storage.json, and there's no CDP call to size
   * an Electron window — so write the bounds before launching.
   */
  presetWindowSize() {
    const file = path.join(this.userData, 'User', 'globalStorage', 'storage.json');
    let storage = {};
    try {
      storage = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const state = (storage.windowsState ??= {});
    state.lastActiveWindow = { ...(state.lastActiveWindow ?? {}), uiState: { mode: 1, x: 80, y: 60, ...WINDOW } };
    state.openedWindows = [];
    fs.writeFileSync(file, JSON.stringify(storage));
  }

  async quit() {
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, sleep(8000)]);
    await sleep(500);
  }
}
