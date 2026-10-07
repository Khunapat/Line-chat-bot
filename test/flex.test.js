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
  assert.equal(cardOf(info.contents).contents.length, 5); // heading, a, b, filler, footer box
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

test('headings use drawn icons once the asset base is known, emoji otherwise', async () => {
  const { setAssetBase, splitIcon, fileIconName } = await import('../src/flex.js');
  assert.deepEqual(splitIcon('📁 เก็บไว้แล้ว'), { icon: 'folder', text: 'เก็บไว้แล้ว' });
  assert.deepEqual(splitIcon('ไม่มีไอคอน'), { icon: null, text: 'ไม่มีไอคอน' });
  setAssetBase('');
  let msg = infoCard('⚙️ ตั้งค่า', ['a']);
  assert.equal(cardOf(msg.contents).contents[0].text, '⚙️ ตั้งค่า');
  setAssetBase('https://bot.example/');
  msg = infoCard('⚙️ ตั้งค่า', ['a']);
  const head = cardOf(msg.contents).contents[0];
  assert.equal(head.contents[0].url, 'https://bot.example/static/icons/settings.png');
  assert.equal(head.contents[1].text, 'ตั้งค่า');
  // Files without a thumbnail get a drawn placeholder of the same 4:3 shape.
  const card = fileCard({ ...file, mimeType: 'application/pdf' });
  assert.equal(cardOf(card.contents).contents[0].url, 'https://bot.example/static/icons/ph-pdf.png');
  assert.equal(fileIconName({ mimeType: 'video/mp4' }), 'video');
  // Carousel bubbles share one layout: no heading, clamped names.
  const many = filesCarousel([file, { ...file, id: '2', name: 'b.jpg', thumbUrl: 'https://t/1.jpg' }], { title: '📁 ไฟล์ล่าสุด' });
  for (const b of many.contents.contents) {
    assert.equal(cardOf(b).contents[0].type, 'image');
    assert.equal(cardOf(b).contents[1].maxLines, 2);
  }
  assert.equal(many.contents.contents[0].body.layout, 'horizontal');
  assert.equal(cardOf(many.contents.contents[0]).flex, 1);
  setAssetBase('');
});

test('a saved link renders as a file card with the link icon and an open-link button', async () => {
  const { linkAsFile, setAssetBase } = await import('../src/flex.js');
  setAssetBase('https://bot.example');
  const f = linkAsFile({ id: 'L1', url: 'https://forms.gle/abc', title: 'ฟอร์มสมัคร', host: 'forms.gle', day: '2026-09-08', at: '2026-09-08T10:00:00Z' });
  const msg = fileCard(f, { title: '🔗 เก็บลิงก์แล้ว' });
  const card = cardOf(msg.contents);
  assert.equal(card.contents[0].contents[0].url, 'https://bot.example/static/icons/link.png');
  assert.equal(card.contents[1].url, 'https://bot.example/static/icons/ph-link.png');
  assert.equal(card.contents[1].action.uri, 'https://forms.gle/abc');
  assert.match(card.contents[3].text, /2026-09-08 · forms.gle/);
  assert.equal(footerOf(msg)[0].contents[0].text, 'เปิดลิงก์');
  assert.equal(msg.contents.size, 'mega');
  setAssetBase('');
});

// ------------------------------------------------------------ deadline cards

const oppNow = new Date('2026-10-07T09:21:00+07:00');
const opp = (over) => ({
  id: 'o1', title: 'Knight-Hennessy Scholars 2027 (Stanford University)', kind: 'scholarship', organizer: 'Stanford',
  deadline: '2026-10-10', deadline_note: '23:59', link: 'https://knight-hennessy.stanford.edu/apply',
  source: { kind: 'image', fileId: 'F1', webViewLink: 'https://drive/F1' }, ...over,
});
const walk = (node, out = []) => {
  if (node && typeof node === 'object') {
    out.push(node);
    for (const v of Object.values(node)) walk(v, out);
  }
  return out;
};
const texts = (msg) => walk(msg).filter((n) => n.type === 'text' && typeof n.text === 'string').map((n) => n.text);
const postbacks = (msg) => walk(msg).filter((n) => n.type === 'postback').map((n) => n.data);

test('deadlineView: urgency colour, big day number and countdown', async () => {
  const { deadlineView, thaiFullDate } = await import('../src/flex.js');
  const v = (d, extra) => deadlineView(opp({ deadline: d, ...extra }), TZ, oppNow);
  assert.deepEqual([v('2026-10-07').countdown, v('2026-10-07').color], ['วันนี้วันสุดท้าย!', '#B5482F']);
  assert.equal(v('2026-10-08').countdown, 'พรุ่งนี้วันสุดท้าย');
  assert.deepEqual([v('2026-10-10').day, v('2026-10-10').month, v('2026-10-10').color], ['10', 'ต.ค.', '#B5482F']);
  assert.equal(v('2026-10-12').color, '#C98A2B');
  assert.equal(v('2026-10-21').color, '#6F7658');
  assert.equal(v('2026-10-01').countdown, 'หมดเขตแล้ว');
  assert.equal(v('2027-01-15').month, 'ม.ค. 70'); // another year shows the short Thai year
  assert.equal(v('2026-10-10', { status: 'applied' }).countdown, '✓ สมัครแล้ว');
  assert.equal(v('').day, '?');
  assert.equal(thaiFullDate('2026-10-07'), 'พุธ 7 ต.ค. 2569');
});

test('deadline list rows: date badge, countdown, delete pill, tap for details', async () => {
  const { opportunityListCard } = await import('../src/flex.js');
  const list = [
    opp({ id: 'a', title: 'SEA Youth IGF 2026', deadline: '2026-10-10' }),
    opp({ id: 'b', title: 'DAAD STEM PROGRAMME 2027', deadline: '2026-10-21' }),
    opp({ id: 'c', title: 'Applied one', deadline: '2026-10-15', status: 'applied' }),
    opp({ id: 'd', title: 'Closed one', deadline: '2026-10-05' }),
  ];
  const msg = opportunityListCard(list, { timeZone: TZ, now: oppNow, alerts: { days: [7, 3, 1, 0], time: '09:00' } });
  const card = cardOf(msg.contents);
  const rows = card.contents.filter((n) => n.type === 'box' && n.action?.data?.startsWith('action=opp_view'));
  assert.deepEqual(rows.map((r) => r.action.data), ['action=opp_view&id=a', 'action=opp_view&id=b', 'action=opp_view&id=c', 'action=opp_view&id=d']);
  const [badge, info] = rows[0].contents;
  assert.equal(badge.contents[0].text, '10');
  assert.equal(badge.contents[0].size, 'xxl');
  assert.equal(badge.backgroundColor, '#B5482F');
  assert.equal(info.contents[1].text, 'อีก 3 วัน');
  assert.equal(info.contents[1].color, '#B5482F');
  const del = info.contents[2].contents[1];
  assert.equal(del.action.data, 'action=opp_delete&id=a');
  assert.equal(del.contents[0].text, 'ลบ');
  assert.ok(texts(msg).includes('สมัครแล้ว') && texts(msg).includes('หมดเขตแล้ว')); // section labels
  assert.match(texts(msg)[1], /เปิดรับอยู่ 2 รายการ · เตือนล่วงหน้า 7 · 3 · 1 วัน \+ วันสุดท้าย เวลา 09:00 น\./);
  assert.ok(postbacks(msg).includes('action=alerts_menu'));
});

test('a long deadline list stays small and caps the rows', async () => {
  const { opportunityListCard } = await import('../src/flex.js');
  const many = Array.from({ length: 25 }, (_, i) => opp({ id: `x${i}`, title: `ทุนการศึกษาระดับปริญญาโทและเอก หลักสูตรนานาชาติ รุ่นที่ ${i} ร่วมกับมหาวิทยาลัยชั้นนำ`, deadline: `2026-11-${String(i + 1).padStart(2, '0')}` }));
  const msg = opportunityListCard(many, { timeZone: TZ, now: oppNow });
  const size = Buffer.byteLength(JSON.stringify(msg.contents));
  assert.ok(size < 22_000, `list bubble is ${size} bytes`);
  assert.equal(postbacks(msg).filter((d) => d.startsWith('action=opp_view')).length, 10);
  assert.ok(texts(msg).some((t) => t.startsWith('และอีก 15 รายการ')));
});

test('detail card: big date block, labelled facts, applied toggle, delete and per-item alerts', async () => {
  const { opportunityCard } = await import('../src/flex.js');
  const msg = opportunityCard(opp({ eligibility: 'จบ ป.ตรี', cost: 'ฟรี' }), { timeZone: TZ, now: oppNow, alerts: { days: [7, 3, 1, 0], time: '09:00' } });
  const t = texts(msg);
  assert.ok(t.includes('อีก 3 วัน'));
  assert.ok(t.includes('หมดเขต เสาร์ 10 ต.ค. 2569 · 23:59'));
  assert.ok(t.includes('เตือนล่วงหน้า 7 · 3 · 1 วัน + วันสุดท้าย เวลา 09:00 น.'));
  const spans = walk(msg).filter((n) => n.type === 'span').map((n) => n.text);
  assert.ok(spans.includes('ใครสมัครได้  ') && spans.includes('จบ ป.ตรี'));
  const pb = postbacks(msg);
  assert.ok(pb.includes('action=opp_applied&id=o1'));
  assert.ok(pb.includes('action=opp_delete&id=o1'));
  assert.ok(pb.includes('action=alerts_menu&id=o1'));
  assert.ok(!pb.some((d) => d.startsWith('action=opp_split')));
  const applied = opportunityCard(opp({ status: 'applied' }), { timeZone: TZ, now: oppNow });
  assert.ok(postbacks(applied).includes('action=opp_unapplied&id=o1'));
  assert.ok(!texts(applied).some((x) => x.startsWith('เตือนล่วงหน้า')));
});

test('detail card offers to split after a merge, or to merge a look-alike', async () => {
  const { opportunityCard } = await import('../src/flex.js');
  assert.ok(postbacks(opportunityCard(opp(), { timeZone: TZ, now: oppNow, merged: true })).includes('action=opp_split&id=o1'));
  const s = opportunityCard(opp({ id: 'new' }), { timeZone: TZ, now: oppNow, suggestion: { id: 'old', title: 'ทุน Knight-Hennessy' } });
  assert.ok(postbacks(s).includes('action=opp_merge&id=old&src=new'));
  assert.ok(texts(s).some((x) => x.includes('"ทุน Knight-Hennessy"? รวมเลย')));
});

test('alerts due together go out as one message', async () => {
  const { deadlineAlertsMessage } = await import('../src/flex.js');
  const one = deadlineAlertsMessage([opp()], { timeZone: TZ, now: oppNow });
  assert.equal(one.contents.type, 'bubble');
  assert.ok(postbacks(one).includes('action=opp_applied&id=o1'));
  const two = deadlineAlertsMessage([opp(), opp({ id: 'o2', title: 'B', deadline: '2026-10-08' })], { timeZone: TZ, now: oppNow });
  assert.equal(two.contents.type, 'carousel');
  assert.equal(two.contents.contents.length, 2);
  assert.ok(two.altText.length <= 400);
});

test('alert settings card highlights the current choice; the per-item card can reset or switch off', async () => {
  const { alertSettingsCard } = await import('../src/flex.js');
  const msg = alertSettingsCard({ days: [14, 7, 3, 1, 0], time: '20:00' });
  const footer = footerOf(msg);
  const presetBtn = (key) => footer.find((b) => b.action?.data === `action=alerts_set&p=${key}`);
  assert.equal(presetBtn('early').backgroundColor, '#8B9270'); // selected
  assert.equal(presetBtn('std').backgroundColor, '#F4EFE4');
  assert.ok(postbacks(msg).includes('action=alerts_time&t=2000'));
  assert.ok(postbacks(msg).includes('action=alerts_off'));
  const item = alertSettingsCard({ days: [7, 3, 1, 0], time: '09:00' }, { opp: opp({ alertDays: [3, 1, 0] }) });
  const pb = postbacks(item);
  assert.ok(pb.includes('action=alerts_set&p=light&id=o1'));
  assert.ok(pb.includes('action=alerts_reset&id=o1') && pb.includes('action=alerts_off&id=o1'));
  assert.ok(!pb.some((d) => d.startsWith('action=alerts_time')));
});

test('applied and deleted confirmations carry their undo', async () => {
  const { appliedCard, deletedCard } = await import('../src/flex.js');
  assert.ok(postbacks(appliedCard(opp())).includes('action=opp_unapplied&id=o1'));
  assert.ok(postbacks(deletedCard(opp())).includes('action=opp_restore&id=o1'));
});
