import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileCard, filesCarousel, reminderCard, reminderListCard, dueReminderCard, eventCard, infoCard, linkButton, cardOf } from '../src/flex.js';

const footerOf = (msg) => cardOf(msg.contents).contents.at(-1).contents;

const TZ = 'Asia/Bangkok';
const file = { id: '1', name: 'Bookbank.pdf', webViewLink: 'https://drive.google.com/x', day: '2026-09-08', size: 507000 };

test('fileCard has an open-file URI button and short altText', () => {
  const msg = fileCard(file, { title: '📁 เก็บไว้แล้ว' });
  assert.equal(msg.type, 'flex');
  assert.ok(msg.altText.length <= 400);
  const btn = footerOf(msg)[0];
  assert.equal(btn.type, 'box'); // outlined box acting as a button
  assert.equal(btn.borderColor, '#3B3B3B');
  assert.equal(btn.action.type, 'uri');
  assert.equal(btn.action.uri, file.webViewLink);
  assert.equal(btn.contents[0].text, 'เปิดไฟล์');
  assert.equal(msg.contents.styles.body.backgroundColor, '#3B3B3B'); // stroke frame
});

test('filesCarousel returns a bubble for one file and a carousel for many', () => {
  assert.equal(filesCarousel([file]).contents.type, 'bubble');
  const many = filesCarousel([file, { ...file, id: '2', name: 'b.jpg' }]);
  assert.equal(many.contents.type, 'carousel');
  assert.equal(many.contents.contents.length, 2);
});

test('reminderCard carries reschedule/cancel postbacks with the id', () => {
  const now = new Date('2026-09-08T10:00:00+07:00');
  const msg = reminderCard({ id: 'r1', text: 'กินยา', at: '2026-09-08T18:00:00+07:00', repeat: 'daily' }, { timeZone: TZ, now });
  const [row, link] = footerOf(msg);
  assert.equal(row.contents[0].action.data, 'action=reschedule&id=r1');
  assert.equal(row.contents[1].action.data, 'action=cancel&id=r1');
  assert.equal(link.action.data, 'action=list_reminders');
  assert.match(msg.altText, /ทุกวัน วันนี้ 18:00 น\./);
});

test('reminderListCard handles empty and populated lists', () => {
  assert.equal(cardOf(reminderListCard([], { timeZone: TZ }).contents).contents.length, 2);
  const msg = reminderListCard([{ id: 'x', text: 'a', at: '2026-09-09T02:00:00Z', repeat: 'none' }], { timeZone: TZ });
  assert.equal(cardOf(msg.contents).contents[1].contents[2].action.data, 'action=cancel&id=x');
});

test('eventCard and infoCard build valid bubbles', () => {
  const ev = eventCard({ title: 'team dinner', start: '2026-09-09T18:09:00+07:00', end: '2026-09-09T19:09:00+07:00', link: 'https://cal' }, { timeZone: TZ });
  assert.match(ev.altText, /18:09 น\. - 19:09 น\./);
  const info = infoCard('⚙️ ตั้งค่า', ['a', 'b'], { buttons: [linkButton('เปิด', 'https://x')] });
  assert.equal(cardOf(info.contents).contents.length, 4); // heading, a, b, footer box
  assert.equal(footerOf(info)[0].action.uri, 'https://x');
});

test('dueReminderCard snooze/done reference the reminder id', () => {
  const msg = dueReminderCard({ id: 'r9', text: 'กินยา', at: '2026-09-09T11:00:00Z', repeat: 'daily' }, { userName: 'Jai', timeZone: TZ });
  const [row, done] = footerOf(msg);
  assert.equal(row.contents[0].action.data, 'action=snooze&min=10&id=r9');
  assert.equal(row.contents[1].action.data, 'action=snooze&min=60&id=r9');
  assert.equal(done.action.data, 'action=done&id=r9');
  assert.match(msg.altText, /Jai ถึงเวลากินยาแล้วนะ/);
});
