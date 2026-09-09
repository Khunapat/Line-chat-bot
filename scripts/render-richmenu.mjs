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
  for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = svgs[el.dataset.icon] || '';
}, Object.fromEntries(Object.keys(ICONS).map((n) => [n, svgOf(n, 230)])));
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 2500, height: 1686 } });

// Tap areas come from the same DOM, so image and menu never drift apart.
// Small buttons first: LINE uses the first area whose bounds contain the tap.
const areas = await page.evaluate(() => {
  const els = [...document.querySelectorAll('[data-action]')];
  els.sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height));
  return els.map((el) => {
    const r = el.getBoundingClientRect();
    return { data: 'action=' + el.dataset.action, text: el.dataset.text, bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
  });
});
await browser.close();
const { writeFile } = await import('node:fs/promises');
await writeFile(path.join(root, 'assets/richmenu-areas.json'), JSON.stringify({ width: 2500, height: 1686, areas }, null, 2) + '\n');
console.log('rendered', out, 'with', areas.length, 'tap areas');
