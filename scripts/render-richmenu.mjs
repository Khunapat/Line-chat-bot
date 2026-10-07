/**
 * Render assets/richmenu-src/richmenu.html into the Thai and English rich
 * menus (2500x1686) plus their action maps, filling each data-icon slot with
 * the drawn icon from assets/icons-src/icons.mjs:
 *   assets/richmenu.th.png  assets/richmenu-areas.th.json
 *   assets/richmenu.en.png  assets/richmenu-areas.en.json
 * Run after editing the HTML or the icons:
 *   npm run richmenu-image
 * Upload is a separate, explicit step (`npm run rich-menu`).
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { writeFile, stat } from 'node:fs/promises';
import { ICONS, svgOf } from '../assets/icons-src/icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'assets/richmenu-src/richmenu.html');

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  const req = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'));
  ({ chromium } = req('playwright'));
}
const browser = await chromium.launch();

for (const lang of ['th', 'en']) {
  const page = await browser.newPage({ viewport: { width: 2500, height: 1686 }, deviceScaleFactor: 1 });
  await page.goto(`${pathToFileURL(src).href}?lang=${lang}`);
  await page.evaluate((svgs) => {
    for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = svgs[el.dataset.icon] || '';
  }, Object.fromEntries(Object.keys(ICONS).map((n) => [n, svgOf(n, 230)])));
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(root, `assets/richmenu.${lang}.png`);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 2500, height: 1686 } });

  // Tap areas come from the same DOM: { data, text, bounds } per area, plus
  // optional inputOption / fillInText and the web-app path for LIFF.
  const map = await page.evaluate(() => {
    const areas = [...document.querySelectorAll('[data-action]')].map((el) => {
      const r = el.getBoundingClientRect();
      const a = { data: 'action=' + el.dataset.action, text: el.dataset.text, bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
      if (el.dataset.input) a.inputOption = el.dataset.input;
      if (el.dataset.fill) a.fillInText = el.dataset.fill;
      if (el.dataset.liff) a.liffPath = el.dataset.liff;
      return a;
    });
    return { width: 2500, height: 1686, chatBarText: window.MENU_TEXT[document.documentElement.lang].chatBar, areas };
  });
  // LINE takes the first matching area, so overlapping boxes would be ambiguous.
  for (const [i, a] of map.areas.entries()) {
    for (const b of map.areas.slice(i + 1)) {
      const overlap = a.bounds.x < b.bounds.x + b.bounds.width && b.bounds.x < a.bounds.x + a.bounds.width && a.bounds.y < b.bounds.y + b.bounds.height && b.bounds.y < a.bounds.y + a.bounds.height;
      if (overlap) throw new Error(`tap areas overlap: ${a.data} / ${b.data}`);
    }
  }
  await writeFile(path.join(root, `assets/richmenu-areas.${lang}.json`), JSON.stringify(map, null, 2) + '\n');
  const { size } = await stat(out);
  if (size > 1024 * 1024) throw new Error(`${out} is ${size} bytes; LINE allows 1 MB`);
  console.log(`rendered ${path.relative(root, out)} (${Math.round(size / 1024)} KB) with ${map.areas.length} tap areas`);
  await page.close();
}
await browser.close();
