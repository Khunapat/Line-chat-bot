/**
 * Upload the Thai and English rich menus (assets/richmenu.th.png / .en.png
 * with their action maps from `npm run richmenu-image`), give them the
 * aliases the bot uses to switch a person's menu when they change language
 * in the web app, and make the Thai one the default for everyone.
 *
 *   LINE_CHANNEL_ACCESS_TOKEN=... [LIFF_ID=...] npm run rich-menu
 *
 * With LIFF_ID set, "ของฉัน / Me" opens the web app; otherwise it sends the
 * menu_settings postback. Re-running replaces menus this script created.
 * This talks to the live LINE channel: run it only when you mean to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { messagingApi } from '@line/bot-sdk';
import { loadDotEnv } from './dotenv.js';

loadDotEnv();

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) {
  console.error('Set LINE_CHANNEL_ACCESS_TOKEN first.');
  process.exit(1);
}
const liffId = process.env.LIFF_ID || '';
const ALIAS = { th: process.env.RICH_MENU_ALIAS_TH || 'jaija-th', en: process.env.RICH_MENU_ALIAS_EN || 'jaija-en' };
const NAME = (lang) => `jaija-menu-${lang}`;
const OLD_NAMES = ['line-drive-archiver-menu'];

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, '..', 'assets');
const client = new messagingApi.MessagingApiClient({ channelAccessToken: token });
const blob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: token });

function pngSize(file) {
  const head = fs.readFileSync(file).subarray(0, 24);
  if (head.toString('latin1', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** Rich menu object from an action map ({ data, text, bounds, inputOption?, fillInText?, liffPath? }). */
function menuFrom(map, { lang, liffId: liff = '' }) {
  return {
    size: { width: map.width, height: map.height },
    selected: true,
    name: NAME(lang),
    chatBarText: map.chatBarText,
    areas: map.areas.map((a) => {
      if (a.liffPath && liff) return { bounds: a.bounds, action: { type: 'uri', label: a.text.slice(0, 20), uri: `https://liff.line.me/${liff}#${a.liffPath}` } };
      const action = { type: 'postback', data: a.data, displayText: a.text };
      if (a.inputOption) action.inputOption = a.inputOption;
      if (a.fillInText) action.fillInText = a.fillInText;
      return { bounds: a.bounds, action };
    }),
  };
}

const { richmenus } = await client.getRichMenuList();
for (const m of richmenus.filter((x) => OLD_NAMES.includes(x.name) || x.name === NAME('th') || x.name === NAME('en'))) {
  await client.deleteRichMenu(m.richMenuId);
  console.log('deleted old menu', m.name, m.richMenuId);
}

const ids = {};
for (const lang of ['th', 'en']) {
  const image = path.join(assets, `richmenu.${lang}.png`);
  const map = JSON.parse(fs.readFileSync(path.join(assets, `richmenu-areas.${lang}.json`), 'utf8'));
  const size = pngSize(image);
  if (size.width !== map.width || size.height !== map.height) throw new Error(`${image} does not match its action map`);
  const { richMenuId } = await client.createRichMenu(menuFrom(map, { lang, liffId }));
  await blob.setRichMenuImage(richMenuId, new Blob([fs.readFileSync(image)], { type: 'image/png' }));
  ids[lang] = richMenuId;
  try { await client.deleteRichMenuAlias(ALIAS[lang]); } catch { /* first run */ }
  await client.createRichMenuAlias({ richMenuAliasId: ALIAS[lang], richMenuId });
  console.log(`created ${lang} menu ${richMenuId} (alias ${ALIAS[lang]})`);
}

await client.setDefaultRichMenu(ids.th);
console.log('Thai menu is the default. People who choose English in the app get the English menu.');
