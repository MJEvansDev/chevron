#!/usr/bin/env node
// Records the release media (see shots.mjs): the hero GIF, the feature clips and the
// screenshots — by driving an isolated VS Code over the Chrome DevTools Protocol. No screen
// recording or accessibility permission needed; nothing in the user's own VS Code profile changes.
//
//   node scripts/record-demo/record.mjs [shot…] [--out docs/media] [--no-build] [--keep-open]
//
// Shots: hero, choose-branch, take-from-main, next-change, screenshots (default: all).
// Needs: git, ffmpeg, gifski (pngquant optional) and VS Code with the `code` CLI on PATH.
// macOS-first: the takes press ⌘ shortcuts (Meta+…); on Linux/Windows swap them for Ctrl.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeGif, optimisePng } from './encode.mjs';
import { openSession } from './session.mjs';
import { SHOTS } from './shots.mjs';
import { RecordingVSCode } from './vscode.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const outDir = path.resolve(option('--out', path.join(repoRoot, 'docs/media')));
const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const unknown = wanted.filter((name) => !SHOTS.some((s) => s.name === name));
if (unknown.length > 0 || flag('-h') || flag('--help')) {
  console.error(`Usage: node scripts/record-demo/record.mjs [${SHOTS.map((s) => s.name).join('|')}]… [--out dir] [--no-build] [--keep-open]`);
  for (const s of SHOTS) console.error(`  ${s.name.padEnd(15)} ${s.about}`);
  process.exit(unknown.length > 0 ? 2 : 0);
}
const shots = wanted.length === 0 ? SHOTS : SHOTS.filter((s) => wanted.includes(s.name));

function need(tool, hint, versionFlag = '--version') {
  try {
    execFileSync(tool, [versionFlag], { stdio: 'ignore' });
  } catch {
    console.error(`record-demo: ${tool} not found — ${hint}`);
    process.exit(1);
  }
}
need('git', 'install git');
need('ffmpeg', 'brew install ffmpeg', '-version');
need('gifski', 'brew install gifski');

// 1. The extension under test: a fresh VSIX from this checkout.
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const vsix = path.join(repoRoot, `chevron-${version}.vsix`);
if (!flag('--no-build') || !fs.existsSync(vsix)) {
  console.log('Building the VSIX…');
  execFileSync('pnpm', ['run', 'vsix'], { cwd: repoRoot, stdio: 'ignore' });
}

const vscode = new RecordingVSCode();
console.log(`Isolated VS Code: ${vscode.binary}\n  data: ${vscode.root}`);
vscode.installExtension(vsix);

const takesDir = path.join(vscode.root, 'takes');
fs.rmSync(takesDir, { recursive: true, force: true });
const results = [];
let takeNumber = 0;

try {
  for (const shot of shots) {
    // 2. A fresh demo repo per shot — Chevron remembers the comparison per folder, and a take
    //    edits src/pricing.ts. Same leaf name every time, so nothing visible changes.
    const folder = path.join(takesDir, String(++takeNumber), 'acme-shop');
    execFileSync('node', [path.join(repoRoot, 'scripts/make-demo-repo.mjs'), folder], { stdio: 'ignore' });
    vscode.writeSettings(shot.settings);
    console.log(`\n▶ ${shot.name}: ${shot.about}`);
    await vscode.launch(folder);
    const s = await openSession(vscode.port);
    try {
      if (shot.record) {
        const dir = path.join(vscode.root, 'raw', shot.name);
        await shot.record(s, dir);
        await s.stopRecording();
        const out = path.join(outDir, shot.output);
        const r = encodeGif(dir, out, { crop: shot.crop });
        results.push(`${path.relative(repoRoot, out)}  ${(r.bytes / 1e6).toFixed(2)} MB, ${r.seconds.toFixed(1)} s`);
      } else {
        const rawDir = path.join(vscode.root, 'raw', shot.name);
        fs.mkdirSync(rawDir, { recursive: true });
        await shot.screenshots(s, async (name, clip) => {
          const raw = path.join(rawDir, name);
          await s.screenshot(raw, clip);
          const out = path.join(outDir, name);
          const r = optimisePng(raw, out);
          results.push(`${path.relative(repoRoot, out)}  ${(r.bytes / 1e3).toFixed(0)} KB`);
        });
      }
    } catch (error) {
      const shotFile = path.join(vscode.root, 'raw', `${shot.name}-error.png`);
      await s.screenshot(shotFile).catch(() => undefined);
      console.error(`\n✖ ${shot.name} failed — the window at that moment: ${shotFile}`);
      throw error;
    } finally {
      s.close();
    }
  }
} finally {
  if (!flag('--keep-open')) await vscode.quit();
}

console.log(`\nWrote:\n  ${results.join('\n  ')}\n\nReview them in a browser (macOS Preview doesn't animate GIFs).`);
