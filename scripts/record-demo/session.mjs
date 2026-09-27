// A scripted "take" against the running VS Code window: a drawn pointer and keystroke badge
// (CDP screencast frames contain neither the OS cursor nor anything outside the page), eased
// pointer moves, element lookup, screencast capture and screenshots.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { connect, evaluate, key, click, drag, mouseMove, wheel } from './cdp.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Injected into the workbench. Trusted Types forbid innerHTML there, hence createElementNS.
const OVERLAY_SCRIPT = `(() => {
  for (const id of ['demo-cursor', 'demo-keys', 'demo-style']) document.getElementById(id)?.remove();
  const style = document.createElement('style');
  style.id = 'demo-style';
  // Workbench hovers (toolbar tooltips) appear wherever the real OS pointer happens to rest over
  // the window, independent of the scripted one — keep them out of the shot.
  style.textContent = '.workbench-hover-container { display: none !important; }';
  document.head.appendChild(style);

  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '33');
  svg.setAttribute('height', '45');
  svg.setAttribute('viewBox', '0 0 22 30');
  const arrow = document.createElementNS(NS, 'path');
  arrow.setAttribute('d', 'M2 2 L2 24 L7.5 18.5 L11.5 27.5 L15 26 L11 17 L19 17 Z');
  arrow.setAttribute('fill', '#fff');
  arrow.setAttribute('stroke', '#000');
  arrow.setAttribute('stroke-width', '1.4');
  arrow.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(arrow);
  cursor.appendChild(svg);
  Object.assign(cursor.style, { position: 'fixed', left: '-60px', top: '-60px', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(-3px,-3px)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.5))' });
  document.body.appendChild(cursor);
  window.__demoPointer = (show) => { cursor.style.visibility = show ? 'visible' : 'hidden'; };

  if (!window.__demoListeners) {
    window.__demoListeners = true;
    window.addEventListener('mousemove', (e) => {
      const c = document.getElementById('demo-cursor');
      if (c) { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }
    }, true);
    window.addEventListener('mousedown', (e) => {
      if (document.getElementById('demo-cursor')?.style.visibility === 'hidden') return;
      const ring = document.createElement('div');
      Object.assign(ring.style, { position: 'fixed', left: e.clientX - 22 + 'px', top: e.clientY - 22 + 'px', width: '44px', height: '44px', borderRadius: '50%', border: '3px solid rgba(90,160,255,.95)', background: 'rgba(90,160,255,.25)', zIndex: 2147483646, pointerEvents: 'none', transition: 'transform .4s ease-out, opacity .4s ease-out' });
      document.body.appendChild(ring);
      requestAnimationFrame(() => { ring.style.transform = 'scale(1.5)'; ring.style.opacity = '0'; });
      setTimeout(() => ring.remove(), 450);
    }, true);
  }

  const keys = document.createElement('div');
  keys.id = 'demo-keys';
  Object.assign(keys.style, { position: 'fixed', right: '28px', bottom: '44px', zIndex: 2147483647, pointerEvents: 'none', padding: '6px 14px', borderRadius: '8px', background: 'rgba(20,20,20,.88)', border: '1px solid rgba(255,255,255,.25)', color: '#fff', font: '600 20px -apple-system, system-ui, sans-serif', letterSpacing: '1px', opacity: '0', transition: 'opacity .15s' });
  document.body.appendChild(keys);
  let hideTimer;
  window.__demoKeyPos = (pos) => { Object.assign(keys.style, { right: 'auto', bottom: 'auto', left: 'auto', top: 'auto' }, pos); };
  window.__demoKey = (label) => {
    keys.textContent = label;
    keys.style.opacity = '1';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { keys.style.opacity = '0'; }, 1100);
  };
})()`;

export async function openSession(port) {
  const page = await connect(port);
  const js = (expression) => evaluate(page, expression);
  // The page target appears before the workbench has rendered.
  const deadline = Date.now() + 30000;
  while (!(await js(`!!document.querySelector('.monaco-workbench .part.activitybar')`).catch(() => false))) {
    if (Date.now() > deadline) throw new Error('record-demo: the VS Code workbench never finished loading.');
    await sleep(250);
  }
  await js(OVERLAY_SCRIPT);
  let mx = 0;
  let my = 0;
  const frames = [];
  const marks = [];

  const s = {
    page,
    js,
    frames,
    marks,
    /** Eased move from the current pointer position. */
    async moveTo(x, y, ms = 450) {
      const steps = Math.max(6, Math.round(ms / 30));
      const [sx, sy] = [mx, my];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        await mouseMove(page, sx + (x - sx) * e, sy + (y - sy) * e);
        await sleep(ms / steps / 2); // each CDP round-trip takes about as long again
      }
      [mx, my] = [x, y];
    },
    /** Teleport the pointer (off camera, or for screenshots). */
    async jump(x, y) {
      [mx, my] = [x, y];
      await mouseMove(page, x, y);
    },
    async click(x, y) {
      [mx, my] = [x, y];
      await click(page, x, y);
    },
    async clickAt(x, y, ms) {
      await s.moveTo(x, y, ms);
      await sleep(120);
      await click(page, x, y);
    },
    drag: (x1, y1, x2, y2) => drag(page, x1, y1, x2, y2),
    wheel: (x, y, deltaY) => wheel(page, x, y, deltaY),
    /** Space-separated chord (`Meta+k Shift+b`); `label` shows the keystroke badge. */
    async press(combo, label) {
      if (label) {
        await js(`window.__demoKey(${JSON.stringify(label)})`);
        await sleep(120);
      }
      for (const part of combo.split(' ')) await key(page, part);
    },
    type: (text) => page.send('Input.insertText', { text }),
    showPointer: (show) => js(`window.__demoPointer(${show})`),
    keyBadgeAt: (pos) => js(`window.__demoKeyPos(${JSON.stringify(pos)})`),
    /**
     * Box of the first element matching `selector` whose `filter` (a JS expression over `el`)
     * holds: `{ x, y, width, height, cx, cy }` in window pixels, or throws.
     */
    async box(selector, filter = 'true') {
      const b = await js(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => ${filter});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
      })()`);
      if (!b) throw new Error(`record-demo: nothing matches ${selector} where ${filter}`);
      return b;
    },
    /** Poll until `expression` is truthy in the page. */
    async waitFor(expression, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await js(`!!(${expression})`)) return;
        await sleep(150);
      }
      throw new Error(`record-demo: timed out waiting for ${expression}`);
    },
    mark(name) {
      marks.push({ name, t: Date.now() / 1000 });
    },
    /** Start the screencast; frames are written to `<dir>/raw` as they arrive (only on change). */
    async startRecording(dir) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
      let n = 0;
      page.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        page.send('Page.screencastFrameAck', { sessionId });
        const file = `f${String(n++).padStart(5, '0')}.png`;
        fs.writeFileSync(path.join(dir, 'raw', file), Buffer.from(data, 'base64'));
        frames.push({ t: metadata.timestamp, file });
      });
      await page.send('Page.startScreencast', { format: 'png', maxWidth: 1920, maxHeight: 1200, everyNthFrame: 1 });
      // A no-op wiggle so there's a first frame before anything happens.
      await mouseMove(page, mx + 1, my);
      await mouseMove(page, mx, my);
      s.recordingDir = dir;
    },
    async stopRecording() {
      s.mark('end');
      await page.send('Page.stopScreencast');
      await sleep(300);
      fs.writeFileSync(path.join(s.recordingDir, 'frames.json'), JSON.stringify({ frames, marks }, null, 1));
    },
    /** PNG of `clip` (window pixels) — captured at the display's pixel ratio. */
    async screenshot(file, clip) {
      const r = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    close() {
      page.close();
    },
  };
  return s;
}
