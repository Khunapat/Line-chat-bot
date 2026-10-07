import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zoned, zonedToUtc, formatDay, formatTime, formatDateTime, weekTitle, weekStart, addDays, diffDays, isDayKey,
} from '../web/shared/dates.js';
import { nextOccurrence, upcoming, occursOn } from '../web/shared/recurrence.js';
import { STRINGS, t, normalizeLang } from '../web/shared/i18n.js';
import { fireDueReminders } from '../src/reminders.js';
import { Store } from '../src/store.js';

const BKK = 'Asia/Bangkok';

test('wall clock <-> UTC, including a DST zone', () => {
  assert.equal(zonedToUtc('2026-10-08', '10:15', BKK), '2026-10-08T03:15:00.000Z');
  assert.deepEqual(zoned('2026-10-07T17:30:00Z', BKK), { key: '2026-10-08', hm: '00:30' });
  // Los Angeles: PDT (UTC-7) before 1 Nov 2026, PST (UTC-8) after.
  assert.equal(zonedToUtc('2026-10-31', '09:00', 'America/Los_Angeles'), '2026-10-31T16:00:00.000Z');
  assert.equal(zonedToUtc('2026-11-02', '09:00', 'America/Los_Angeles'), '2026-11-02T17:00:00.000Z');
  assert.equal(isDayKey('2026-02-30'), false);
  assert.equal(isDayKey('2028-02-29'), true);
  assert.equal(isDayKey('2026-13-01'), false);
  assert.equal(isDayKey('7/10/2026'), false);
});

test('Thai dates use Buddhist years, English Gregorian', () => {
  assert.equal(formatDay('2026-10-07', 'th'), 'พ. 7 ต.ค. 2569');
  assert.equal(formatDay('2026-10-07', 'en'), 'Wed 7 Oct 2026');
  assert.equal(formatDay('2026-10-07', 'th', 'full'), 'วันพุธที่ 7 ตุลาคม 2569');
  assert.equal(formatDay('2026-10-07', 'en', 'full'), 'Wednesday 7 October 2026');
  assert.equal(formatDay('2026-10-07', 'th', 'dmy'), '7 ต.ค. 69');
  assert.equal(formatTime('09:00', 'th'), '09:00 น.');
  assert.equal(formatTime('09:00', 'en'), '09:00');
  assert.equal(formatDateTime('2026-10-08T03:15:00Z', 'en', BKK), 'Thu 8 Oct 2026 · 10:15');
});

test('week and month/year rollover', () => {
  assert.equal(weekStart('2026-10-07'), '2026-10-05');
  assert.equal(weekStart('2026-10-05'), '2026-10-05');
  assert.equal(weekStart('2026-10-11'), '2026-10-05');
  assert.equal(weekTitle('2026-12-28', 'th'), 'ธ.ค. 2569 – ม.ค. 2570');
  assert.equal(weekTitle('2026-12-28', 'en'), 'Dec 2026 – Jan 2027');
  assert.equal(weekTitle('2026-10-05', 'en'), 'October 2026');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(diffDays('2026-10-07', '2026-10-10'), 3);
});

test('monthly repeats stay on the local day (the old UTC maths drifted)', () => {
  // 1 Oct 05:00 Bangkok is 30 Sep 22:00 UTC; +1 month must be 1 Nov in Bangkok.
  const at = zonedToUtc('2026-10-01', '05:00', BKK);
  const next = nextOccurrence(at, 'monthly', { timeZone: BKK });
  assert.deepEqual(zoned(next, BKK), { key: '2026-11-01', hm: '05:00' });
});

test('month-end anchors use the last day, then go back', () => {
  const at = zonedToUtc('2026-10-31', '20:00', BKK);
  const seq = upcoming({ at, repeat: 'monthly', anchorDay: 31 }, 4, { timeZone: BKK, now: new Date('2026-10-01T00:00:00Z') }).map((x) => zoned(x, BKK).key);
  assert.deepEqual(seq, ['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31']);
  const feb = upcoming({ at: zonedToUtc('2027-01-31', '20:00', BKK), repeat: 'monthly', anchorDay: 31 }, 2, { timeZone: BKK, now: new Date('2027-01-01T00:00:00Z') }).map((x) => zoned(x, BKK).key);
  assert.deepEqual(feb, ['2027-01-31', '2027-02-28']);
  const leap = upcoming({ at: zonedToUtc('2028-02-29', '09:00', BKK), repeat: 'yearly', anchorDay: 29 }, 3, { timeZone: BKK, now: new Date('2028-01-01T00:00:00Z') }).map((x) => zoned(x, BKK).key);
  assert.deepEqual(leap, ['2028-02-29', '2029-02-28', '2030-02-28']);
  assert.equal(occursOn({ at, repeat: 'monthly', anchorDay: 31 }, '2026-11-30', { timeZone: BKK }), true);
  assert.equal(occursOn({ at, repeat: 'monthly', anchorDay: 31 }, '2026-11-29', { timeZone: BKK }), false);
  assert.equal(occursOn({ at, repeat: 'weekly' }, '2026-11-07', { timeZone: BKK }), true);
  assert.equal(occursOn({ at, repeat: 'none' }, '2026-10-30', { timeZone: BKK }), false);
});

test('firing a monthly reminder keeps its anchor day', async () => {
  const docs = new Map();
  const drive = { async readJson(n, f) { return docs.has(n) ? structuredClone(docs.get(n)) : structuredClone(f); }, async writeJson(n, v) { docs.set(n, structuredClone(v)); } };
  const store = new Store(drive, { cacheMs: 0 });
  const at = zonedToUtc('2026-10-31', '20:00', BKK);
  const r = await store.addReminder({ userId: 'U', text: 'rent', at, repeat: 'monthly' });
  await fireDueReminders(store, async () => {}, new Date(new Date(at).getTime() + 1000), { timeZone: BKK });
  const after = (await store.reminders()).find((x) => x.id === r.id);
  assert.equal(after.anchorDay, 31);
  assert.deepEqual(zoned(after.at, BKK), { key: '2026-11-30', hm: '20:00' });
});

test('every string exists in both languages with the same placeholders', () => {
  const th = STRINGS.th;
  const en = STRINGS.en;
  assert.deepEqual(Object.keys(th).filter((k) => !(k in en)), [], 'missing in English');
  assert.deepEqual(Object.keys(en).filter((k) => !(k in th)), [], 'missing in Thai');
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const k of Object.keys(th)) assert.equal(vars(en[k]), vars(th[k]), `placeholders differ for ${k}`);
});

test('lookups fall back to Thai and keep user content untouched', () => {
  assert.equal(t('en', 'save'), 'Save');
  assert.equal(t('xx', 'save'), 'บันทึก');
  assert.equal(normalizeLang('EN'), 'th', 'only exact codes');
  assert.equal(t('en', 'results', { n: 2, q: 'ใบเสร็จ {n}' }), '2 results for “ใบเสร็จ {n}”');
  assert.equal(t('th', 'no_such_key'), 'no_such_key');
});
