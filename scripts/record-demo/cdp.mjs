// Minimal Chrome DevTools Protocol client for a VS Code window started with
// --remote-debugging-port. Plain Node (global fetch/WebSocket, Node ≥ 22), no dependencies.

export async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
  if (!page) {
    throw new Error('record-demo: no VS Code workbench page on the debugging port yet.');
  }
  return open(page.webSocketDebuggerUrl);
}

async function open(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${JSON.stringify(msg.error)}`)) : resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  };
  return {
    send(method, params = {}) {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close() {
      ws.close();
    },
  };
}

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  F7: { key: 'F7', code: 'F7', keyCode: 118 },
  b: { key: 'b', code: 'KeyB', keyCode: 66 },
  k: { key: 'k', code: 'KeyK', keyCode: 75 },
  p: { key: 'p', code: 'KeyP', keyCode: 80 },
  z: { key: 'z', code: 'KeyZ', keyCode: 90 },
};
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** One key combo, e.g. `Meta+z`, `Alt+F7`, `Meta+Shift+p`. */
export async function key(page, combo) {
  const parts = combo.split('+');
  const name = parts.pop();
  const k = KEYS[name];
  if (!k) {
    throw new Error(`record-demo: no key mapping for "${name}" — add it to KEYS in cdp.mjs.`);
  }
  const modifiers = parts.reduce((bits, m) => bits | MODIFIER_BITS[m], 0);
  const base = { modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export async function mouseMove(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

export async function click(page, x, y) {
  await mouseMove(page, x, y);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

export async function drag(page, x1, y1, x2, y2) {
  await mouseMove(page, x1, y1);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 10; i++) {
    const x = x1 + ((x2 - x1) * i) / 10;
    const y = y1 + ((y2 - y1) * i) / 10;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
}

export async function wheel(page, x, y, deltaY) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
}

export async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(`record-demo: page script failed: ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result.value;
}
