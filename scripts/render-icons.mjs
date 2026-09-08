/**
 * Render assets/icons-src/icons.mjs to PNGs in assets/public/icons using
 * headless Chromium (Playwright). Run once after editing the icons:
 *   node scripts/render-icons.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS, svgOf, placeholderSvg } from '../assets/icons-src/icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'assets/public/icons');
await mkdir(out, { recursive: true });

// Playwright may be installed globally rather than in this project.
const { createRequire } = await import('node:module');
const { execSync } = await import('node:child_process');
const globalRoot = execSync('npm root -g').toString().trim();
const req = createRequire(path.join(globalRoot, 'x.js'));
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = req('playwright')); }
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });

async function shoot(svg, file, w, h) {
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style><div id="i" style="width:${w}px;height:${h}px">${svg}</div>`);
  const el = await page.$('#i');
  await el.screenshot({ path: path.join(out, file), omitBackground: true });
}

for (const name of Object.keys(ICONS)) await shoot(svgOf(name, 128), `${name}.png`, 128, 128);
for (const name of ['doc', 'pdf', 'clip', 'video', 'audio', 'note', 'link']) await shoot(placeholderSvg(name), `ph-${name}.png`, 480, 360);
await browser.close();
// Contact sheet for a quick look.
const sheet = Object.keys(ICONS).map((n) => `<figure><img src="${n}.png" width="64"><figcaption>${n}</figcaption></figure>`).join('');
await writeFile(path.join(out, 'index.html'), `<meta charset="utf-8"><style>body{background:#F4EFE4;font:12px sans-serif;display:flex;flex-wrap:wrap;gap:12px;padding:12px}figure{margin:0;text-align:center}</style>${sheet}<p><img src="ph-pdf.png" width="240"></p>`);
console.log('rendered', Object.keys(ICONS).length, 'icons to', out);
