#!/usr/bin/env node
// Builds a small, realistic-looking git repo for recording Chevron's demo GIF/screenshots and for
// the manual pre-release QA pass.
//
//   node scripts/make-demo-repo.mjs [targetDir] [--force]
//
// targetDir defaults to ../chevron-demo (relative to the current directory). A linked worktree is
// also created beside it at <targetDir>-hotfix, and a bare "origin" lives inside the repo's own
// .git directory (so nothing else is scattered around). Refuses to touch a non-empty target (or
// worktree dir) unless --force is given, in which case both are deleted first.
//
// Plain Node, no dependencies — only `git` on PATH. Commit dates are computed relative to *now*,
// so blame reads "3 weeks ago", "5 days ago", … whenever it is run. Shape (pinned by
// test/unit/makeDemoRepo.spec.ts — keep the two in step):
//
//   main:               A (6 weeks ago) ── B (3 weeks ago, tag v1.0.0) ── M (yesterday, README only)
//   feature/discounts:                     B ── F1 (5 days) ── F2 (2 days, rename) ── F3 (3 hours)   <- checked out
//   spike/free-shipping:                   B ── S (10 days)          (throwaway: for the deleted-branch QA case)
//   hotfix/rounding:    at M, checked out in the linked worktree, with an uncommitted edit
//   origin (bare, in .git/demo-origin.git): main, release/1.0 (= B), feature/discounts (= F2); no origin/HEAD
//
//   Against main (merge-base B): M src/pricing.ts (3 hunks), A src/discounts.ts,
//   R src/api/orders.ts -> src/api/orderRoutes.ts, M public/logo.png (binary),
//   plus an uncommitted edit to src/cart.ts and an untracked src/discounts.test.ts.
//   Ahead/behind: main ↓1 ↑3.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// Arguments and safety checks

const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter((arg) => !arg.startsWith('--'));
const unknownFlags = args.filter((arg) => arg.startsWith('--') && arg !== '--force');
if (unknownFlags.length > 0 || positional.length > 1 || args.includes('-h')) {
  console.error('Usage: node scripts/make-demo-repo.mjs [targetDir] [--force]');
  process.exit(2);
}

const repoDir = path.resolve(positional[0] ?? path.join('..', 'chevron-demo'));
const worktreeDir = `${repoDir}-hotfix`;

function isNonEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function isSameOrAncestor(candidate, of) {
  const relative = path.relative(candidate, of);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

for (const dir of [repoDir, worktreeDir]) {
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
    console.error(`make-demo-repo: ${dir} exists and is not a directory.`);
    process.exit(1);
  }
  if (!isNonEmptyDir(dir)) {
    continue;
  }
  if (!force) {
    console.error(`make-demo-repo: ${dir} is not empty. Pass --force to delete and rebuild it.`);
    process.exit(1);
  }
  // Belt and braces for --force: never delete the directory we're standing in, an ancestor of
  // it, or the home directory.
  if (isSameOrAncestor(dir, process.cwd()) || isSameOrAncestor(dir, os.homedir())) {
    console.error(`make-demo-repo: refusing to delete ${dir} (it contains the current or home directory).`);
    process.exit(1);
  }
}

// A stale worktree registration would make `git worktree add` fail; the repo it belongs to is
// about to be deleted anyway, so both directories just go.
fs.rmSync(repoDir, { recursive: true, force: true });
fs.rmSync(worktreeDir, { recursive: true, force: true });
fs.mkdirSync(repoDir, { recursive: true });

// ---------------------------------------------------------------------------------------------
// Helpers

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();

const PEOPLE = {
  jordan: { name: 'Jordan Lee', email: 'jordan@example.com' },
  demo: { name: 'Demo Author', email: 'demo@example.com' },
};

/** A git date string `ago` milliseconds before now (UTC, so it's the same on every machine). */
function gitDate(ago) {
  return `${Math.floor((now - ago) / 1000)} +0000`;
}

function git(gitArgs, { cwd = repoDir, env = {} } = {}) {
  return execFileSync('git', gitArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }).trim();
}

function write(relativePath, content, dir = repoDir) {
  const file = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(message, { ago, who = PEOPLE.demo }) {
  git(['add', '-A']);
  const date = gitDate(ago);
  git(['commit', '-q', '--no-verify', '-m', message], {
    env: {
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      GIT_COMMITTER_DATE: date,
    },
  });
  return git(['rev-parse', 'HEAD']);
}

// Minimal PNG encoder (solid-colour square) so the repo has a real binary file to diff.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function solidPng(size, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// File contents

const packageJson = `{
  "name": "acme-shop",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p .",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^5.0.0"
  }
}
`;

const readme = `# acme-shop

A tiny storefront: a cart, pricing rules and an orders API.

- \`src/cart.ts\` — cart model and item operations
- \`src/pricing.ts\` — subtotal, tax, shipping and totals
- \`src/api/\` — HTTP handlers
`;

const readmeOnMain = `${readme}
## Local setup

\`\`\`bash
pnpm install
pnpm run build && pnpm start
\`\`\`

The API listens on http://localhost:3000.
`;

const cartTs = (maxQuantity) => `export interface CartItem {
  sku: string;
  name: string;
  price: number;
  quantity: number;
}

export interface Cart {
  id: string;
  items: CartItem[];
}

export const MAX_QUANTITY = ${maxQuantity};

export function createCart(id: string): Cart {
  return { id, items: [] };
}

export function addItem(cart: Cart, item: CartItem): Cart {
  const existing = cart.items.find((candidate) => candidate.sku === item.sku);
  if (existing) {
    existing.quantity = Math.min(existing.quantity + item.quantity, MAX_QUANTITY);
    return cart;
  }
  cart.items.push({ ...item, quantity: Math.min(item.quantity, MAX_QUANTITY) });
  return cart;
}

export function removeItem(cart: Cart, sku: string): Cart {
  cart.items = cart.items.filter((item) => item.sku !== sku);
  return cart;
}

export function itemCount(cart: Cart): number {
  return cart.items.reduce((count, item) => count + item.quantity, 0);
}
`;

const pricingV0 = `import type { Cart } from './cart';

export const TAX_RATE = 0.2;

export function subtotal(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function total(cart: Cart): number {
  return roundCurrency(subtotal(cart) * (1 + TAX_RATE));
}

export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
`;

// The file the "← Take from main" money shot happens on. Against the merge-base the feature
// version below differs in exactly three well-separated places.
const pricingBase = `import type { Cart } from './cart';

export const TAX_RATE = 0.2;
export const FREE_SHIPPING_THRESHOLD = 50;
const SHIPPING_FLAT_RATE = 4.99;

export function subtotal(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function shipping(cart: Cart): number {
  if (subtotal(cart) >= FREE_SHIPPING_THRESHOLD) {
    return 0;
  }
  console.log('shipping: flat rate applied');
  return SHIPPING_FLAT_RATE;
}

export function tax(amount: number): number {
  return roundCurrency(amount * TAX_RATE);
}

export function total(cart: Cart): number {
  const net = subtotal(cart);
  return roundCurrency(net + tax(net) + shipping(cart));
}

export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
`;

// F1: hunk 2 (modified function) and hunk 3 (added block).
const pricingF1 = pricingBase
  .replace(
    `export function total(cart: Cart): number {
  const net = subtotal(cart);`,
    `export function total(cart: Cart, discountRate = 0): number {
  const net = subtotal(cart) * (1 - discountRate);`,
  )
  .replace(
    `export function roundCurrency`,
    `/** How much a discount saved, for the receipt. */
export function savings(cart: Cart, discountRate: number): number {
  return roundCurrency(subtotal(cart) * discountRate);
}

export function roundCurrency`,
  );

// F3: hunk 1 (deleted line).
const pricingF3 = pricingF1.replace(`  console.log('shipping: flat rate applied');\n`, '');

// hotfix/rounding (uncommitted, in the linked worktree).
const pricingHotfix = pricingBase.replace(
  'Math.round(value * 100) / 100',
  'Math.round((value + Number.EPSILON) * 100) / 100',
);

// spike/free-shipping.
const pricingSpike = pricingBase.replace('FREE_SHIPPING_THRESHOLD = 50', 'FREE_SHIPPING_THRESHOLD = 35');

const ordersTs = (totalCall) => `import { createCart, addItem, type Cart } from '../cart';
import { total } from '../pricing';

export interface OrderRequest {
  items: { sku: string; name: string; price: number; quantity: number }[];
  discountCode?: string;
}

export interface OrderResponse {
  orderId: string;
  total: number;
}

let nextOrderId = 1000;

export function buildCart(request: OrderRequest): Cart {
  const cart = createCart(\`cart-\${nextOrderId}\`);
  for (const item of request.items) {
    addItem(cart, item);
  }
  return cart;
}

export function createOrder(request: OrderRequest): OrderResponse {
  if (request.items.length === 0) {
    throw new Error('An order needs at least one item.');
  }
  const cart = buildCart(request);
  const orderId = \`ord_\${nextOrderId++}\`;
  return { orderId, total: ${totalCall} };
}

export function getOrder(orderId: string): { orderId: string; status: 'pending' | 'shipped' } {
  return { orderId, status: 'pending' };
}
`;

const orderRoutesTs = ordersTs('total(cart, discountRateFor(request.discountCode))').replace(
  `import { total } from '../pricing';\n`,
  `import { total } from '../pricing';\nimport { discountRateFor } from '../discounts';\n`,
);

const discountsTs = `/** Active discount codes and the fraction they take off the subtotal. */
const CODES: Record<string, number> = {
  WELCOME10: 0.1,
  SUMMER25: 0.25,
  STAFF: 0.3,
};

export function isValidCode(code: string): boolean {
  return code.toUpperCase() in CODES;
}

export function discountRateFor(code: string | undefined): number {
  if (!code) {
    return 0;
  }
  return CODES[code.toUpperCase()] ?? 0;
}
`;

const discountsTestTs = `import { describe, expect, it } from 'vitest';
import { discountRateFor, isValidCode } from './discounts';

describe('discounts', () => {
  it('is case-insensitive', () => {
    expect(isValidCode('welcome10')).toBe(true);
  });

  it('ignores unknown codes', () => {
    expect(discountRateFor('NOPE')).toBe(0);
  });
});
`;

// ---------------------------------------------------------------------------------------------
// History

git(['init', '-q']);
git(['symbolic-ref', 'HEAD', 'refs/heads/main']); // `init -b` needs git 2.28+; this works everywhere
git(['config', 'core.autocrlf', 'false']); // same bytes on every OS
git(['config', 'commit.gpgsign', 'false']);
git(['config', 'tag.gpgsign', 'false']);
git(['config', 'user.name', PEOPLE.demo.name]);
git(['config', 'user.email', PEOPLE.demo.email]);

write('.gitignore', 'node_modules/\ndist/\n');
write('package.json', packageJson);
write('README.md', readme);
write('src/cart.ts', cartTs(10));
write('src/pricing.ts', pricingV0);
write('src/api/orders.ts', ordersTs('total(cart)'));
write('public/logo.png', solidPng(32, [67, 56, 202]));
commit('Initial storefront: cart, pricing and orders API', { ago: 42 * DAY, who: PEOPLE.jordan });

write('src/pricing.ts', pricingBase);
const forkPoint = commit('Add tax and flat-rate shipping to pricing', { ago: 21 * DAY, who: PEOPLE.jordan });
git(['tag', '-a', 'v1.0.0', '-m', 'acme-shop 1.0.0'], {
  env: { GIT_COMMITTER_DATE: gitDate(21 * DAY), GIT_COMMITTER_NAME: PEOPLE.jordan.name, GIT_COMMITTER_EMAIL: PEOPLE.jordan.email },
});

// Throwaway branch for the "comparison branch deleted" QA case.
git(['checkout', '-q', '-b', 'spike/free-shipping']);
write('src/pricing.ts', pricingSpike);
commit('Spike: lower the free-shipping threshold', { ago: 10 * DAY, who: PEOPLE.jordan });

git(['checkout', '-q', '-b', 'feature/discounts', forkPoint]);
write('src/discounts.ts', discountsTs);
write('src/pricing.ts', pricingF1);
commit('Add discount codes and apply them to the order total', { ago: 5 * DAY });

git(['mv', 'src/api/orders.ts', 'src/api/orderRoutes.ts']);
write('src/api/orderRoutes.ts', orderRoutesTs);
const pushedFeature = commit('Rename orders handler to orderRoutes and pass discount codes', { ago: 2 * DAY });

write('src/pricing.ts', pricingF3);
write('public/logo.png', solidPng(32, [16, 185, 129]));
commit('Drop shipping debug log; new logo for the sale', { ago: 3 * HOUR });

// main moves on after the fork, in a file the feature branch never touches — so it shows up in
// the ahead/behind count (↓1) but not in the merge-base diff.
git(['checkout', '-q', 'main']);
write('README.md', readmeOnMain);
commit('Document local setup in README', { ago: 1 * DAY, who: PEOPLE.jordan });
git(['checkout', '-q', 'feature/discounts']);

// A real (local, bare) remote, so the picker has a Remote section. No origin/HEAD, so Chevron's
// auto-selection falls through to local `main` (src/defaultBranch.ts: origin/HEAD, main, master).
const originDir = path.join(repoDir, '.git', 'demo-origin.git');
execFileSync('git', ['init', '-q', '--bare', originDir], { stdio: 'ignore' });
git(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: originDir });
git(['remote', 'add', 'origin', originDir]);
git(['config', 'remote.origin.followRemoteHEAD', 'never']); // git 2.48+ would otherwise create origin/HEAD on fetch
git(['push', '-q', 'origin', 'main', `${forkPoint}:refs/heads/release/1.0`, `${pushedFeature}:refs/heads/feature/discounts`]);
git(['fetch', '-q', 'origin']);
try {
  git(['remote', 'set-head', 'origin', '--delete']);
} catch {
  // Not there — which is what we want.
}
git(['branch', '-q', '--set-upstream-to=origin/feature/discounts', 'feature/discounts']);

// A linked worktree with an uncommitted edit, for the picker's Worktrees section and live compare.
git(['worktree', 'add', '-q', '-b', 'hotfix/rounding', worktreeDir, 'main']);
write('src/pricing.ts', pricingHotfix, worktreeDir);

// Uncommitted and untracked changes in the main working tree.
write('src/cart.ts', cartTs(20));
write('src/discounts.test.ts', discountsTestTs);

// ---------------------------------------------------------------------------------------------
// Summary

const [behind, ahead] = git(['rev-list', '--left-right', '--count', 'main...HEAD']).split(/\s+/);
const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);
console.log(`Chevron demo repo ready.

  Repository   ${repoDir}
  Worktree     ${worktreeDir}  (hotfix/rounding, one uncommitted edit)
  Checked out  feature/discounts — main ↓${behind} ↑${ahead}
  Changed      src/pricing.ts (3 hunks), src/discounts.ts (added), src/api/orders.ts → orderRoutes.ts,
               public/logo.png (binary), src/cart.ts (uncommitted), src/discounts.test.ts (untracked)
  Refs         tag v1.0.0 = ${forkPoint.slice(0, 7)} (the merge-base), spike/free-shipping, origin/{main,release/1.0,feature/discounts}

Next steps:
  1. Install the extension, e.g. into a throwaway profile:
       code --profile chevron-demo --install-extension chevron-1.0.0.vsix
  2. Open the repo in that profile:
       code --profile chevron-demo ${quote(repoDir)}
  3. Click the Chevron icon in the Activity Bar — it auto-selects \`main\`.

Re-run with --force to reset everything to this exact state.`);
