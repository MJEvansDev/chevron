// Every release-media deliverable, as a script. Each shot gets a fresh demo repo and
// a fresh VS Code launch with its own settings overrides (see record.mjs).
//
// Coordinates are window pixels (1280 × 800). Elements are found in the DOM, not at hard-coded
// points, so small layout changes don't break a take; crops are fixed so the output framing is
// stable.
import { sleep } from './session.mjs';

const SIDEBAR_WIDTH = 280;
const ACTIVITY_BAR_WIDTH = 48;

// --- Shared steps ------------------------------------------------------------------------------

/** Chevron view open, Primary Side Bar 280 px wide, focus nowhere in particular. */
async function openChevron(s) {
  await s.waitFor(`document.querySelector('.activitybar .action-item a[aria-label="Chevron"]')`, 30000);
  const active = await s.js(`!!document.querySelector('.activitybar .action-item.checked a[aria-label="Chevron"]')`);
  if (!active) {
    const icon = await s.box('.activitybar .action-item a', `el.getAttribute('aria-label') === 'Chevron'`);
    await s.click(icon.cx, icon.cy);
  }
  await s.waitFor(`document.querySelector('.part.sidebar .title-label')?.textContent.startsWith('Chevron')`);
  await sleep(600);
  const width = await s.js(`document.querySelector('.part.sidebar').getBoundingClientRect().width`);
  if (Math.abs(width - SIDEBAR_WIDTH) > 2) {
    const sash = ACTIVITY_BAR_WIDTH + width;
    await s.drag(sash, 400, sash - (width - SIDEBAR_WIDTH), 400);
    await sleep(300);
  }
  await s.js('document.activeElement?.blur()');
}

const selectBranchButton = (s) => s.box('.part.sidebar .monaco-button', `el.textContent.includes('Select Branch')`);
const pickerRow = (s, label) => s.box('.quick-input-list .monaco-list-row', `el.getAttribute('aria-label') === ${JSON.stringify(label)}`);
const treeRow = (s, file) => s.box('.part.sidebar .monaco-list-row', `(el.getAttribute('aria-label') || '').startsWith(${JSON.stringify(file + ' ')})`);
const lens = (s, titlePrefix) => s.box('.codelens-decoration a', `(el.title || el.getAttribute('title') || '').startsWith(${JSON.stringify(titlePrefix)})`);
const rightPaneText = (s) => s.box('.monaco-diff-editor .editor.modified .view-lines');
const lineNumber = (s, n) => s.box('.editor.modified .line-numbers', `el.textContent.trim() === '${n}'`);

async function selectMain(s) {
  const button = await selectBranchButton(s);
  await s.click(button.cx, button.cy);
  await s.waitFor(`document.querySelector('.quick-input-list .monaco-list-row')`);
  await sleep(300);
  const main = await pickerRow(s, 'main');
  await s.click(main.x + 60, main.cy);
  await s.waitFor(`document.querySelector('.part.sidebar .monaco-list-row')`);
  await sleep(800);
}

async function openFile(s, file) {
  const row = await treeRow(s, file);
  await s.click(row.x + 70, row.cy);
  await s.waitFor(`document.querySelector('.monaco-diff-editor .editor.modified .view-lines')`);
  await s.waitFor(`document.querySelector('.codelens-decoration a') || ${JSON.stringify(file)} !== 'pricing.ts'`);
  await sleep(900);
}

// --- Shots -------------------------------------------------------------------------------------

export const SHOTS = [
  {
    name: 'hero',
    output: 'demo.gif',
    about: 'The README hero: pick a branch, open a diff, take a hunk, undo, Alt+F7.',
    async record(s, dir) {
      await openChevron(s);
      await s.jump(760, 470);
      await sleep(600);
      await s.startRecording(dir);
      await sleep(700);

      s.mark('select-branch');
      const button = await selectBranchButton(s);
      await s.clickAt(button.cx, button.cy, 650);
      await sleep(1000);

      s.mark('main');
      const main = await pickerRow(s, 'main');
      await s.clickAt(main.x + 60, main.cy, 550);
      await sleep(300);

      s.mark('tree');
      await s.moveTo(200, 520, 400);
      await sleep(1300);

      s.mark('pricing');
      const pricing = await treeRow(s, 'pricing.ts');
      await s.clickAt(pricing.x + 70, pricing.cy, 500);
      await s.waitFor(`document.querySelector('.codelens-decoration a')`);
      await sleep(1000);

      s.mark('hover-lens');
      const take = await lens(s, 'Replace 2 lines');
      await s.moveTo(take.cx, take.cy, 650);
      await sleep(900);

      s.mark('take');
      await s.click(take.cx, take.cy);
      await sleep(1700);

      s.mark('undo');
      await s.moveTo(take.cx + 180, take.cy + 150, 400);
      await s.press('Meta+z', '⌘ Z');
      await sleep(1400);

      s.mark('next-change');
      const text = await rightPaneText(s);
      await s.clickAt(text.x + 4, text.y + 11, 600);
      await sleep(500);
      await s.press('Alt+F7', '⌥ F7');
      await sleep(1100);
      await s.press('Alt+F7', '⌥ F7');
      await sleep(1400);
    },
  },
  {
    name: 'choose-branch',
    output: 'choose-branch.gif',
    about: 'Select Branch → picker sections → main → tree fills in.',
    crop: { x: 0, y: 0, width: 960, height: 440 },
    async record(s, dir) {
      await openChevron(s);
      await s.jump(700, 420);
      await sleep(500);
      await s.startRecording(dir);
      await sleep(600);
      const button = await selectBranchButton(s);
      await s.clickAt(button.cx, button.cy, 600);
      await sleep(900);
      const tag = await pickerRow(s, 'v1.0.0, Tags');
      await s.moveTo(tag.x + 120, tag.cy, 700);
      await sleep(500);
      const main = await pickerRow(s, 'main');
      await s.moveTo(main.x + 60, main.cy, 500);
      await sleep(350);
      await s.click(main.x + 60, main.cy);
      await sleep(300);
      await s.moveTo(220, 330, 400);
      await sleep(2000);
    },
  },
  {
    name: 'take-from-main',
    output: 'take-from-main.gif',
    about: 'Hover the lens above total() → take → ⌘Z.',
    crop: { x: 327, y: 330, width: 953, height: 420 },
    async record(s, dir) {
      await openChevron(s);
      await selectMain(s);
      await openFile(s, 'pricing.ts');
      await s.keyBadgeAt({ right: '48px', top: '612px' });
      await s.jump(1000, 640);
      await sleep(400);
      await s.startRecording(dir);
      await sleep(500);
      const take = await lens(s, 'Replace 2 lines');
      await s.moveTo(take.cx, take.cy, 600);
      await sleep(700);
      await s.click(take.cx, take.cy);
      await sleep(1700);
      await s.moveTo(take.cx + 200, take.cy + 110, 350);
      await s.press('Meta+z', '⌘ Z');
      await sleep(1600);
    },
  },
  {
    name: 'next-change',
    output: 'next-change.gif',
    about: 'Alt+F7 from cart.ts through discounts.test.ts, discounts.ts, into pricing.ts.',
    // Without a line highlight a jump only brightens a line number.
    settings: { 'editor.renderLineHighlight': 'all' },
    async record(s, dir) {
      await openChevron(s);
      await selectMain(s);
      // Not pricing.ts: it's the last file in the tree and navigation doesn't wrap.
      await openFile(s, 'cart.ts');
      const first = await lineNumber(s, 1);
      const text = await rightPaneText(s);
      await s.click(text.x + 4, first.cy);
      await s.jump(1240, 790);
      await s.showPointer(false);
      await sleep(600);
      await s.startRecording(dir);
      await sleep(900);
      for (let i = 0; i < 5; i++) {
        s.mark(`next${i + 1}`);
        await s.press('Alt+F7', '⌥ F7');
        await sleep(1500);
      }
    },
  },
  {
    name: 'screenshots',
    output: ['picker.png', 'tree.png', 'blame.png'],
    about: 'picker.png, tree.png, blame.png.',
    settings: { 'chevron.autoSelectComparisonBranch': true, 'editor.hover.enabled': true },
    async screenshots(s, shoot) {
      await openChevron(s);
      await s.waitFor(`document.querySelector('.part.sidebar .monaco-list-row')`, 15000);
      await s.showPointer(false);
      await s.jump(150, 700); // empty sidebar: no hover, no highlighted row or sash

      // picker.png — Command Palette → Chevron: Select Branch to Compare, nothing hovered.
      await s.press('Meta+Shift+p');
      await sleep(600);
      await s.type('Chevron: Select Branch to Compare');
      await sleep(700);
      await s.press('Enter');
      await s.waitFor(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => r.textContent.includes('currently comparing'))`);
      await sleep(900);
      await shoot('picker.png', { x: 324, y: 32, width: 634, height: 308 });
      await s.press('Escape');
      await sleep(400);

      // tree.png — pricing.ts selected with its diff beside the tree.
      await openFile(s, 'pricing.ts');
      await s.jump(150, 700);
      await sleep(800);
      await shoot('tree.png', { x: 0, y: 0, width: 660, height: 460 });

      // blame.png — annotations on, hover on total(), line 22 mid-pane so the hover opens over
      // code rather than the tab bar.
      const text = await rightPaneText(s);
      const first = await lineNumber(s, 1);
      await s.click(text.x + 4, first.cy);
      await sleep(300);
      await s.press('Meta+k Shift+b'); // ⌘K ⇧B on macOS; Ctrl+K there is "delete to end of line"
      await sleep(1500);
      await s.jump(text.x + 300, 700);
      for (let i = 0; i < 6; i++) {
        await s.wheel(text.x + 300, 700, -300);
        await sleep(200);
      }
      await sleep(600);
      const line22 = await lineNumber(s, 22);
      await s.jump(text.x + 264, line22.cy - 1);
      await sleep(100);
      await s.jump(text.x + 266, line22.cy);
      await s.waitFor(`document.querySelector('.monaco-hover:not(.hidden)')?.textContent.includes('discount')`, 8000);
      await sleep(600);
      await shoot('blame.png', { x: 327, y: 330, width: 953, height: 445 });
    },
  },
];
