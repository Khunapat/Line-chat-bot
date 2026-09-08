/**
 * One-time helper: create the bottom rich menu (แจ้งเตือน / โน้ต / ไฟล์ / ตั้งค่า),
 * upload assets/richmenu.png, and make it the default menu for everyone.
 *
 *   LINE_CHANNEL_ACCESS_TOKEN=... npm run rich-menu
 *
 * Re-running replaces any menu previously created by this script.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { messagingApi } from '@line/bot-sdk';
import { loadDotEnv } from './dotenv.js';

loadDotEnv(); // so `npm run rich-menu` works straight from the project folder

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) {
  console.error('Set LINE_CHANNEL_ACCESS_TOKEN first.');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const imagePath = process.argv[2] || path.join(here, '..', 'assets', 'richmenu.png');
const MENU_NAME = 'line-drive-archiver-menu';

const client = new messagingApi.MessagingApiClient({ channelAccessToken: token });
const blob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: token });

// Layout is derived from the image: 2500 x 843 = one row of four buttons;
// 2500 x 1686 = a mascot / help banner (top half) plus the four buttons.
const { width: W, height: H } = pngSize(imagePath);
if (W !== 2500 || ![843, 1686].includes(H)) {
  console.error(`richmenu.png must be 2500x843 or 2500x1686, got ${W}x${H}`);
  process.exit(1);
}
const TOP = H - 843; // banner height (0 when there is no banner)
const col = W / 4;
const buttons = [
  { data: 'action=menu_reminders', text: 'แจ้งเตือน' },
  { data: 'action=menu_notes', text: 'โน้ต/บันทึก' },
  { data: 'action=menu_files', text: 'ไฟล์/รูป' },
  { data: 'action=menu_settings', text: 'ตั้งค่า' },
];

const areas = buttons.map((b, i) => ({
  bounds: { x: Math.round(i * col), y: TOP, width: Math.round(col), height: H - TOP },
  action: { type: 'postback', data: b.data, displayText: b.text },
}));
if (TOP > 0) {
  areas.unshift({
    bounds: { x: 0, y: 0, width: W, height: TOP },
    action: { type: 'postback', data: 'action=menu_help', displayText: 'ทำอะไรได้บ้าง' },
  });
}

const menu = { size: { width: W, height: H }, selected: true, name: MENU_NAME, chatBarText: 'เมนู', areas };

function pngSize(file) {
  const head = fs.readFileSync(file).subarray(0, 24);
  if (head.toString('latin1', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

// Remove menus this script created earlier so we never pile them up.
const { richmenus } = await client.getRichMenuList();
for (const m of richmenus.filter((x) => x.name === MENU_NAME)) {
  await client.deleteRichMenu(m.richMenuId);
  console.log('deleted old menu', m.richMenuId);
}

const { richMenuId } = await client.createRichMenu(menu);
console.log('created', richMenuId);

const image = new Blob([fs.readFileSync(imagePath)], { type: 'image/png' });
await blob.setRichMenuImage(richMenuId, image);
console.log('uploaded image', imagePath);

await client.setDefaultRichMenu(richMenuId);
console.log('set as default. Open the chat and tap "เมนู" at the bottom.');
