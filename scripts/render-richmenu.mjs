/**
 * Render assets/richmenu-src/richmenu.html to assets/richmenu.png (2500x1686),
 * filling each <div class="icon" data-icon="name"> with the drawn icon from
 * assets/icons-src/icons.mjs. Run after editing either file:
 *   node scripts/render-richmenu.mjs
 * Then upload with `npm run rich-menu` (setup.sh does this too).
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { ICONS, svgOf } from '../assets/icons-src/icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'assets/richmenu-src/richmenu.html');
const out = path.join(root, 'assets/richmenu.png');

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  const req = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'));
  ({ chromium } = req('playwright'));
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2500, height: 1686 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(src).href);
await page.evaluate((svgs) => {
  for (const el of document.querySelectorAll('.icon[data-icon]')) el.innerHTML = svgs[el.dataset.icon] || '';
}, Object.fromEntries(Object.keys(ICONS).map((n) => [n, svgOf(n, 230)])));
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 2500, height: 1686 } });
await browser.close();
console.log('rendered', out);
