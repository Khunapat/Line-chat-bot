import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeDeadline, daysUntil, localDateTimeToUtc, sortOpportunities,
  renderMarkdown, htmlToText, SCHEMA, todayIso, extractFromText, extractFromMedia,
} from '../src/opportunities.js';

const TZ = 'Asia/Bangkok';
const now = new Date('2026-09-08T13:16:00+07:00');

test('daysUntil and describeDeadline count whole local days', () => {
  assert.equal(daysUntil('2026-09-08', TZ, now), 0);
  assert.equal(daysUntil('2026-09-20', TZ, now), 12);
  assert.equal(daysUntil('2026-09-01', TZ, now), -7);
  assert.equal(describeDeadline('2026-09-20', TZ, now), 'อีก 12 วัน (20 ก.ย.)');
  assert.equal(describeDeadline('2026-09-09', TZ, now), 'พรุ่งนี้ (9 ก.ย.)');
  assert.equal(describeDeadline('2026-09-08', TZ, now), 'วันนี้ (8 ก.ย.)');
  assert.equal(describeDeadline('2026-09-01', TZ, now), 'หมดเขตแล้ว (1 ก.ย.)');
  assert.equal(describeDeadline('', TZ, now), 'ไม่ระบุวันหมดเขต');
  // late evening UTC is already the next day in Bangkok
  assert.equal(todayIso(new Date('2026-09-08T18:30:00Z'), TZ), '2026-09-09');
});

test('local 09:00 Bangkok converts to 02:00 UTC', () => {
  assert.equal(localDateTimeToUtc('2026-09-20', 9, 0, TZ), '2026-09-20T02:00:00.000Z');
});

test('extraction shows the saved list and only trusts same_as ids it offered', async () => {
  const seen = [];
  const provider = { async extract({ parts }) { seen.push(parts); return { is_opportunity: true, title: 'KHS', deadline: '2026-10-07', same_as: 'k1', confidence: 0.9 }; } };
  const candidates = [{ id: 'k1', title: 'Knight-Hennessy Scholars', deadline: '2026-10-07', organizer: 'Stanford' }];
  const a = await extractFromText(provider, 'Knight-Hennessy Scholars Program 2027 apply now', { now, timeZone: TZ, candidates });
  assert.equal(a.same_as, 'k1');
  assert.equal(a.ai_checked, true);
  assert.match(seen[0][0].text, /k1 \| Knight-Hennessy Scholars \| 2026-10-07 \| Stanford/);
  // an id the model made up is dropped
  const b = await extractFromMedia({ async extract() { return { is_opportunity: true, title: 'x', same_as: 'zzz' }; } }, { mimeType: 'image/png', base64: '' }, { now, timeZone: TZ, candidates });
  assert.equal(b.same_as, '');
  // nothing saved yet: the model is told so and same_as stays empty
  const c = await extractFromText(provider, 'hello world announcement text', { now, timeZone: TZ });
  assert.equal(c.same_as, '');
  assert.equal(c.ai_checked, false);
  assert.match(seen[1][0].text, /nothing yet/);
});

test('sortOpportunities: upcoming by deadline, then undated, then past', () => {
  const list = [
    { id: 'p', title: 'past', deadline: '2026-09-01' },
    { id: 'u', title: 'undated', deadline: '' },
    { id: 'b', title: 'later', deadline: '2026-10-01' },
    { id: 'a', title: 'soon', deadline: '2026-09-10' },
  ];
  assert.deepEqual(sortOpportunities(list, TZ, now).map((o) => o.id), ['a', 'b', 'u', 'p']);
  const md = renderMarkdown(list, TZ, now);
  assert.match(md, /\| soon \| อื่น ๆ \| 2026-09-10 \(อีก 2 วัน \(10 ก\.ย\.\)\)/);
  assert.match(md, /^# Opportunities \(4\)/);
});

test('htmlToText strips scripts and keeps the title', () => {
  const html = '<html><head><title>PCB &amp; EMC</title><meta name="description" content="Free course"><script>x()</script></head><body><h1>Hello</h1><p>Deadline 20 ก.ย. 2569</p><style>.a{}</style></body></html>';
  const text = htmlToText(html);
  assert.match(text, /^Title: PCB & EMC/);
  assert.match(text, /Description: Free course/);
  assert.match(text, /Hello\s*\n\s*Deadline 20 ก\.ย\. 2569/);
  assert.doesNotMatch(text, /x\(\)|\.a\{\}/);
});

test('schema lists every field as required with no extras', () => {
  assert.deepEqual(SCHEMA.required.sort(), Object.keys(SCHEMA.properties).sort());
  assert.equal(SCHEMA.additionalProperties, false);
});

test('pageTitle prefers og:title and decodes entities', async () => {
  const { pageTitle } = await import('../src/opportunities.js');
  assert.equal(pageTitle('<title>  Kumwell &amp; Friends \n 2027 </title>'), 'Kumwell & Friends 2027');
  assert.equal(pageTitle('<meta property="og:title" content="OG name"><title>x</title>'), 'OG name');
  assert.equal(pageTitle('<p>none</p>'), '');
});
