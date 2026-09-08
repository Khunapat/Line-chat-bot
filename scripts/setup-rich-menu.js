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

// 2500 x 843 image, four equal columns.
const W = 2500;
const H = 843;
const col = W / 4;
const buttons = [
  { data: 'action=menu_reminders', text: 'แจ้งเตือน' },
  { data: 'action=menu_notes', text: 'โน้ต/บันทึก' },
  { data: 'action=menu_files', text: 'ไฟล์/รูป' },
  { data: 'action=menu_settings', text: 'ตั้งค่า' },
];

const menu = {
  size: { width: W, height: H },
  selected: true,
  name: MENU_NAME,
  chatBarText: 'เมนู',
  areas: buttons.map((b, i) => ({
    bounds: { x: Math.round(i * col), y: 0, width: Math.round(col), height: H },
    action: { type: 'postback', data: b.data, displayText: b.text },
  })),
};

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
