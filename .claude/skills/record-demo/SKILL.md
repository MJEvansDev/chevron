---
name: record-demo
description: >
  Record, re-record or change Chevron's README/Marketplace media: the hero GIF (docs/media/demo.gif),
  the feature clips (choose-branch, take-from-main, next-change) and the screenshots (picker,
  tree, blame). It drives an isolated VS Code over the Chrome DevTools Protocol, so it needs no
  screen-recording or accessibility permission and never touches the user's own VS Code. Use
  when the user asks to record, refresh or redo the demo GIF, clips or screenshots, when UI
  changes have made the media stale, or when a new feature needs a clip.
---

# Recording Chevron's demo media

`scripts/record-demo/shots.mjs` defines every shot: one hero plus small clips, and the
screenshots. The rest of `scripts/record-demo/` records them, automated end to end.

## 1. Record

```bash
node scripts/record-demo/record.mjs                  # everything → docs/media/
node scripts/record-demo/record.mjs hero next-change # just some shots
node scripts/record-demo/record.mjs --no-build       # reuse the existing chevron-<version>.vsix
node scripts/record-demo/record.mjs --out /tmp/media # somewhere else (drafts, A/B takes)
node scripts/record-demo/record.mjs --help           # list shots
```

One full run takes about 2 minutes. Run it in the foreground (it quits its VS Code at the end;
`--keep-open` leaves it running for poking at). What it does:

1. Builds the VSIX from this checkout (`pnpm run vsix`), so the media shows *this* code.
2. Starts an isolated VS Code (`/tmp/chevron-record/{u,ext}`: its own user data and extensions)
   at 1280 × 800, with the recording settings (`BASE_SETTINGS` in `vscode.mjs`).
3. Per shot: a fresh demo repo (`scripts/make-demo-repo.mjs` → `/tmp/chevron-record/takes/<n>/acme-shop`),
   a fresh launch with that shot's settings overrides, the scripted take, then encoding.
4. GIFs: CDP screencast → resampled to 12 fps → optional crop → `gifski` at 960 px wide.
   PNGs: CDP screenshots (2× pixel ratio) → `pngquant` if installed.

Prerequisites: `git`, `ffmpeg`, `gifski` (`brew install ffmpeg gifski`), optionally `pngquant`;
VS Code with `code` on PATH. It's macOS-first: takes press `Meta+…` (⌘). Set `VSCODE_BIN` to the
Electron binary if VS Code isn't found.

## 2. Review before committing

Always look at the output, not just the exit code. Nothing asserts that a beat *looked* right.

- Build a contact sheet per GIF and read it:
  ```bash
  ffmpeg -loglevel error -y -i /tmp/chevron-record/raw/hero/seq/s%05d.png \
    -vf "select='not(mod(n\,16))',scale=480:-1,tile=4x3" -frames:v 1 /tmp/hero-sheet.png
  ```
  (`raw/<shot>/crop/` for cropped clips.) Then Read the PNG.
- Check each shot's key beats are visible: the pointer, the lens
  highlight, `total()` snapping back, the ⌘Z/⌥F7 badges, the header `CHEVRON: MAIN ↓1 ↑3`.
- Size budget: hero < 5 MB, clips < 1 MB, PNGs < 500 KB. A run prints the sizes.
- Tell the user to review in a **browser**: macOS Preview doesn't animate GIFs, so they look
  broken or pointer-less there.

If a take throws, `record.mjs` saves the window at that moment to
`/tmp/chevron-record/raw/<shot>-error.png`. Read it first; it usually shows the cause at once.

## 3. Changing or adding a shot

Shots live in `scripts/record-demo/shots.mjs`, one object each:

- `record(s, dir)` for a GIF: pre-roll (open the view, select a branch, open a file) happens
  *before* `s.startRecording(dir)`; everything after is in the clip. `s.mark(name)` labels
  beats (printed timings help tuning). Or `screenshots(s, shoot)` for PNGs: `shoot(name, clip)`.
- `crop` (window pixels) for clips: crop to the region that matters, so the text is readable
  at 960 px.
- `settings` overrides `BASE_SETTINGS` for that shot only.

The session API (`session.mjs`): `moveTo` (eased), `clickAt` (move + click), `click`/`jump`
(instant), `press('Meta+z', '⌘ Z')` (chord parts space-separated; the label shows the keystroke
badge), `type`, `wheel`, `box(selector, filterExpr)` (find elements in the DOM, don't hard-code
points), `waitFor(expr)`, `showPointer`, `keyBadgeAt`. Add missing keys to `KEYS` in `cdp.mjs`.

## Gotchas already paid for

Each of these cost a failed take. Don't rediscover them:

- **No OS-level control.** An agent's shell usually lacks Screen Recording/Accessibility
  permission (`screencapture`, `osascript`, `cliclick` all fail). CDP needs neither, and it's
  why the pointer and keystroke badge are drawn into the page: screencast frames have no OS
  cursor.
- **Launching VS Code from inside VS Code.** The extension host leaks `ELECTRON_RUN_AS_NODE`
  (the binary starts as Node: "bad option: --user-data-dir") and `VSCODE_IPC_HOOK` (it hands
  off to the running instance). `vscode.mjs` strips `VSCODE_*`. The `code` CLI wrapper drops
  `--remote-debugging-port`, so the Electron binary is launched directly.
- **Socket path length.** The user-data dir holds an IPC socket; macOS caps its path at 103
  bytes, so the data root is `/tmp/chevron-record`, not a deep scratch directory.
- **Window size.** Electron exposes no CDP window-bounds call; the bounds are written into
  `storage.json` before launch.
- **One fresh folder per take.** Chevron remembers the comparison per folder, and takes edit
  `src/pricing.ts`.
- **Keys on macOS.** Blame is ⌘K ⇧B. ⌃K is the editor's "delete to end of line", so it edits
  the file.
- **Incidental chrome.** Editor hovers pop up wherever the pointer rests (they covered the lens
  and the click missed); occurrence highlighting lights every `export` after ⌥F7; the lightbulb
  follows clicks; a workbench tooltip appears wherever the *real* OS pointer sits over the
  window. `BASE_SETTINGS` and the injected style handle all four. Blame screenshots turn
  `editor.hover.enabled` back on.
- **Next Change doesn't wrap.** `pricing.ts` is the last file in the tree, so the rollover
  clip starts in `cart.ts`. A jump is invisible unless `editor.renderLineHighlight` is on (it's
  `none` elsewhere).
- **Screencast frames arrive only on change.** The encoder runs to the take's `end` mark, or a
  still ending would be cut.
- **The lens tooltip is a native OS tooltip.** It can't be captured this way; the lens just
  highlights on hover.
- **Header text.** `CHEVRON: MAIN ↓1 ↑3` comes from the view *title* (see the
  vscode-extension-dev skill). If the media shows `CHEVRON: COMPARE TO BRANCH` with a branch
  selected, that's a regression in the extension, not the recorder.

## 4. Hand-off

Commit `docs/media/` together with any script changes on a branch and open a PR
(`create-pr` skill). The README already references every existing file by **relative** path
(`docs/media/<file>`), so re-recorded media needs no README change. A **new** shot also needs a
README image, beside the feature it shows, with alt text describing what happens in it.

Keep README image paths relative. They render in VS Code's preview and on GitHub even while the
repo is private, and `vsce package` rewrites them to
`https://github.com/MJEvansDev/chevron/raw/HEAD/...` for the Marketplace (check with
`unzip -p chevron-*.vsix extension/readme.md | grep docs/media`). Hard-coded
`raw.githubusercontent.com` URLs 404 everywhere while the repo is private.
