import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileCard, filesCarousel, reminderCard, reminderListCard, eventCard, infoCard, linkButton } from '../src/flex.js';

const TZ = 'Asia/Bangkok';
const file = { id: '1', name: 'Bookbank.pdf', webViewLink: 'https://drive.google.com/x', day: '2026-09-08', size: 507000 };

test('fileCard has an open-file URI button and short altText', () => {
  const msg = fileCard(file, { title: '📁 เก็บไว้แล้ว' });
  assert.equal(msg.type, 'flex');
  assert.ok(msg.altText.length <= 400);
  const btn = msg.contents.footer.contents[0];
  assert.equal(btn.action.type, 'uri');
  assert.equal(btn.action.uri, file.webViewLink);
  assert.equal(btn.action.label, 'เปิดไฟล์');
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
  const [row, link] = msg.contents.footer.contents;
  assert.equal(row.contents[0].action.data, 'action=reschedule&id=r1');
  assert.equal(row.contents[1].action.data, 'action=cancel&id=r1');
  assert.equal(link.action.data, 'action=list_reminders');
  assert.match(msg.altText, /ทุกวัน วันนี้ 18:00 น\./);
});

test('reminderListCard handles empty and populated lists', () => {
  assert.ok(reminderListCard([], { timeZone: TZ }).contents.body.contents.length === 2);
  const msg = reminderListCard([{ id: 'x', text: 'a', at: '2026-09-09T02:00:00Z', repeat: 'none' }], { timeZone: TZ });
  assert.equal(msg.contents.body.contents[1].contents[1].action.data, 'action=cancel&id=x');
});

test('eventCard and infoCard build valid bubbles', () => {
  const ev = eventCard({ title: 'team dinner', start: '2026-09-09T18:09:00+07:00', end: '2026-09-09T19:09:00+07:00', link: 'https://cal' }, { timeZone: TZ });
  assert.match(ev.altText, /18:09 น\. - 19:09 น\./);
  const info = infoCard('⚙️ ตั้งค่า', ['a', 'b'], { buttons: [linkButton('เปิด', 'https://x')] });
  assert.equal(info.contents.body.contents.length, 3);
  assert.equal(info.contents.footer.contents[0].action.uri, 'https://x');
});
