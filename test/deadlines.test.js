import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ALERTS, normalizeAlerts, normalizeDays, normalizeTime, alertTimes, describeAlerts, describeAlertDays,
  parseAlertCommand, titleSimilarity, normalizeUrl, sameSpecificUrl, findDuplicate, mergeOpportunity,
  oppCandidates, candidateLines, groupForList,
} from '../src/deadlines.js';

const TZ = 'Asia/Bangkok';
const now = new Date('2026-10-07T09:21:00+07:00');

// ------------------------------------------------------------------ alerts

test('default alerts: 7, 3, 1 days before and the deadline day, 09:00 Bangkok', () => {
  assert.deepEqual(normalizeAlerts(undefined), { days: [7, 3, 1, 0], time: '09:00' });
  const times = alertTimes('2026-10-20', DEFAULT_ALERTS, TZ, now);
  assert.deepEqual(times.map((t) => t.at), [
    '2026-10-13T02:00:00.000Z', '2026-10-17T02:00:00.000Z', '2026-10-19T02:00:00.000Z', '2026-10-20T02:00:00.000Z',
  ]);
  assert.deepEqual(times.map((t) => t.offset), [7, 3, 1, 0]);
  assert.equal(times[0].label, 'อีก 1 สัปดาห์จะปิดรับ');
  assert.equal(times[3].label, 'วันนี้วันสุดท้าย');
});

test('alert times skip the past and follow a custom time', () => {
  // deadline in 3 days: the 7-day slot is gone, today 09:00 already passed
  assert.deepEqual(alertTimes('2026-10-10', DEFAULT_ALERTS, TZ, now).map((t) => t.offset), [1, 0]);
  const evening = alertTimes('2026-10-10', { days: [3, 0], time: '20:00' }, TZ, now);
  assert.deepEqual(evening.map((t) => t.at), ['2026-10-07T13:00:00.000Z', '2026-10-10T13:00:00.000Z']);
  assert.deepEqual(alertTimes('', DEFAULT_ALERTS, TZ, now), []);
  assert.deepEqual(alertTimes('2026-10-20', { days: [], time: '09:00' }, TZ, now), []); // switched off
});

test('normalizers clean up days and times', () => {
  assert.deepEqual(normalizeDays([1, 7, '3', 7, -1, 2.5, 99, 0]), [7, 3, 1, 0]);
  assert.equal(normalizeTime('9.30'), '09:30');
  assert.equal(normalizeTime('24:00'), null);
  assert.equal(normalizeTime('nope'), null);
  assert.deepEqual(normalizeAlerts({ days: [14, 7], time: 'bad' }), { days: [14, 7], time: '09:00' });
  assert.equal(describeAlerts(DEFAULT_ALERTS), 'ก่อน 7 · 3 · 1 วัน + วันสุดท้าย เวลา 09:00 น.');
  assert.equal(describeAlertDays([0]), 'วันสุดท้าย');
  assert.equal(describeAlerts({ days: [] }), 'ปิดการเตือน deadline อยู่');
});

test('parseAlertCommand understands the typed command without AI', () => {
  assert.deepEqual(parseAlertCommand('เตือน deadline ก่อน 10 5 2 1 วัน 20:00'), { time: '20:00', days: [10, 5, 2, 1] });
  assert.deepEqual(parseAlertCommand('ตั้งเตือนเดดไลน์ 14,7,3,1,0'), { days: [14, 7, 3, 1, 0] });
  assert.deepEqual(parseAlertCommand('เตือน deadline ก่อน 2 สัปดาห์ และวันสุดท้าย'), { days: [14, 0] });
  assert.deepEqual(parseAlertCommand('เตือน Deadline เวลา 8.30'), { time: '08:30' });
  assert.deepEqual(parseAlertCommand('ปิดเตือน deadline'), { off: true });
  assert.equal(parseAlertCommand('เตือนกินยา 19.00'), null);
  assert.equal(parseAlertCommand('เตือน deadline หน่อย'), null); // nothing concrete: let the AI handle it
  assert.equal(parseAlertCommand('เตือน deadline 25:00'), null);
});

// ---------------------------------------------------------------- matching

test('titleSimilarity: same activity in different words scores high, different ones low', () => {
  assert.ok(titleSimilarity('Knight-Hennessy Scholars 2027 (Stanford University)', 'Knight-Hennessy Scholars') >= 0.8);
  assert.ok(titleSimilarity('โครงการ AUA-UM Overseas Study Program', 'AUA-UM Overseas Study Program 2026') >= 0.8);
  assert.ok(titleSimilarity('Manaaki New Zealand (ASEAN Programme)', 'Manaaki New Zealand Scholarships ASEAN') >= 0.6);
  assert.ok(titleSimilarity('DAAD STEM PROGRAMME 2027', "Commonwealth Master's & PhD Scholarship") < 0.2);
  // different rounds / editions are different things
  assert.ok(titleSimilarity('Hackathon Round 1', 'Hackathon Round 2') <= 0.3);
  assert.ok(titleSimilarity('SEA Youth IGF 2026', 'SEA Youth IGF 2027') <= 0.3);
  // a Thai Buddhist year is the same year
  assert.ok(titleSimilarity('SEA Youth IGF 2026', 'SEA Youth IGF 2569') >= 0.8);
});

test('URLs compare without tracking noise, and a bare home page is never "the same call"', () => {
  assert.equal(normalizeUrl('https://www.example.org/apply/?utm_source=fb&id=3'), 'example.org/apply?id=3');
  assert.ok(sameSpecificUrl('https://forms.gle/abc', 'https://forms.gle/abc?fbclid=xyz'));
  assert.ok(!sameSpecificUrl('https://www.daad.de/', 'https://daad.de'));
  assert.ok(!sameSpecificUrl('', ''));
});

const saved = (over) => ({
  id: 'k1', title: 'Knight-Hennessy Scholars', organizer: 'Stanford', deadline: '2026-10-07',
  link: '', createdAt: '2026-10-01T03:00:00.000Z', userId: 'U1', ...over,
});

test('findDuplicate: the model saying "same as k1" wins', () => {
  const r = findDuplicate([saved()], { title: 'ทุนสแตนฟอร์ด', deadline: '' }, { sameAs: 'k1', userId: 'U1', timeZone: TZ, now });
  assert.equal(r.match.opp.id, 'k1');
  assert.equal(r.match.reason, 'ai');
});

test('findDuplicate: same specific link or a near-identical title merges', () => {
  const list = [saved({ link: 'https://knight-hennessy.stanford.edu/apply' })];
  assert.equal(findDuplicate(list, { title: 'KHS', link: 'https://knight-hennessy.stanford.edu/apply/', deadline: '2026-10-07' }, { timeZone: TZ, now }).match.reason, 'link');
  assert.equal(findDuplicate(list, { title: 'Knight-Hennessy Scholars 2027 (Stanford University)', deadline: '' }, { timeZone: TZ, now }).match.reason, 'title');
  // a different deadline on both sides means a different call
  assert.equal(findDuplicate(list, { title: 'Knight-Hennessy Scholars', deadline: '2027-10-07' }, { timeZone: TZ, now }).match, null);
});

test('findDuplicate: a poster and a message sent minutes apart merge on a looser match', () => {
  const justNow = saved({ title: 'ทุน Knight-Hennessy ป.โท-เอก Stanford', deadline: '2026-10-07', createdAt: '2026-10-07T02:15:00.000Z' });
  const fields = { title: 'Knight Hennessy Scholars Program', deadline: '2026-10-07' };
  const r = findDuplicate([justNow], fields, { userId: 'U1', timeZone: TZ, now });
  assert.equal(r.match?.reason, 'recent');
  // when the model already looked and said "not the same", only offer it
  const asked = findDuplicate([justNow], fields, { userId: 'U1', timeZone: TZ, now, aiChecked: true });
  assert.equal(asked.match, null);
  assert.equal(asked.suggestion.opp.id, 'k1');
  // another member of a group sending something similar is not merged by recency
  assert.equal(findDuplicate([justNow], fields, { userId: 'U2', timeZone: TZ, now }).match, null);
});

test('findDuplicate ignores items closed more than a week ago', () => {
  const old = saved({ deadline: '2026-09-20' });
  assert.equal(findDuplicate([old], { title: 'Knight-Hennessy Scholars', deadline: '' }, { timeZone: TZ, now }).match, null);
});

// ------------------------------------------------------------------ merging

test('mergeOpportunity fills gaps, keeps the richer text, adds the poster, keeps the earlier deadline', () => {
  const existing = {
    id: 'k1', title: 'Knight-Hennessy Scholars', kind: 'other', organizer: 'Stanford', summary: 'ทุนเรียนต่อ',
    deadline: '2026-10-08', eligibility: '', contact: 'khs@stanford.edu', link: 'https://knight-hennessy.stanford.edu/',
    source: { kind: 'link', url: 'https://knight-hennessy.stanford.edu/' }, confidence: 0.7,
  };
  const fields = {
    title: 'Knight-Hennessy Scholars 2027 (Stanford University)', kind: 'scholarship', organizer: 'Stanford University',
    summary: 'ทุนเรียนต่อ ป.โท-เอก ที่ Stanford เต็มจำนวน 3 ปี', deadline: '2026-10-07', eligibility: 'จบ ป.ตรี ไม่เกิน 7 ปี',
    contact: '+1 650 000 0000', link: 'https://knight-hennessy.stanford.edu/apply', confidence: 0.9,
  };
  const poster = { kind: 'image', fileId: 'F1', webViewLink: 'https://drive/F1' };
  const { patch, added, deadlineChanged, otherDeadline } = mergeOpportunity(existing, fields, poster, { now });
  assert.equal(patch.title, 'Knight-Hennessy Scholars 2027 (Stanford University)');
  assert.equal(patch.kind, 'scholarship');
  assert.equal(patch.organizer, 'Stanford University');
  assert.equal(patch.summary, fields.summary);
  assert.equal(patch.eligibility, 'จบ ป.ตรี ไม่เกิน 7 ปี');
  assert.equal(patch.contact, 'khs@stanford.edu · +1 650 000 0000');
  assert.equal(patch.link, undefined); // the record already had a main link
  assert.deepEqual(patch.links, ['https://knight-hennessy.stanford.edu/', 'https://knight-hennessy.stanford.edu/apply']);
  assert.equal(patch.deadline, '2026-10-07');
  assert.ok(deadlineChanged);
  assert.equal(otherDeadline, '2026-10-08');
  assert.deepEqual(patch.source, poster);
  assert.equal(patch.sources.length, 2);
  assert.equal(patch.confidence, 0.9);
  assert.equal(patch.mergeCount, 1);
  assert.ok(added.includes('โปสเตอร์') && added.includes('คุณสมบัติ'));
});

test('mergeOpportunity: sending the same thing again changes nothing that matters', () => {
  const existing = { id: 'a', title: 'SEA Youth IGF 2026', deadline: '2026-10-10', summary: 'เวทีเยาวชน', source: { kind: 'image', fileId: 'F2' } };
  const r = mergeOpportunity(existing, { title: 'SEA Youth IGF 2026', deadline: '2026-10-10', summary: 'เวทีเยาวชน' }, { kind: 'image', fileId: 'F2' }, { now });
  assert.deepEqual(r.added, []);
  assert.equal(r.deadlineChanged, false);
  assert.equal(r.patch.sources, undefined);
  assert.equal(r.patch.source, undefined);
  // a later date from the second reading is kept aside, not used
  const later = mergeOpportunity(existing, { title: 'SEA Youth IGF 2026', deadline: '2026-10-15' }, null, { now });
  assert.equal(later.patch.deadline, undefined);
  assert.equal(later.otherDeadline, '2026-10-15');
});

// --------------------------------------------------------------- candidates

test('oppCandidates lists recent active items, newest first, for the prompt', () => {
  const list = [
    { id: 'a', title: 'A', deadline: '2026-10-10', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'b', title: 'B', deadline: '2026-09-01', createdAt: '2026-08-01T00:00:00Z' }, // long closed
    { id: 'c', title: 'C', deadline: '', organizer: 'depa', createdAt: '2026-10-05T00:00:00Z' },
  ];
  const c = oppCandidates(list, TZ, now);
  assert.deepEqual(c.map((o) => o.id), ['c', 'a']);
  assert.equal(candidateLines(c), 'c | C | - | depa\na | A | 2026-10-10 | -');
});

// --------------------------------------------------------------------- list

test('groupForList: open soonest first, then undated, applied, and a few recently closed', () => {
  const list = [
    { id: 'far', deadline: '2026-10-21' },
    { id: 'today', deadline: '2026-10-07' },
    { id: 'none', deadline: '' },
    { id: 'done', deadline: '2026-10-10', status: 'applied' },
    { id: 'closed1', deadline: '2026-10-06' },
    { id: 'closed9', deadline: '2026-09-28' },
  ];
  const g = groupForList(list, TZ, now);
  assert.deepEqual(g.upcoming.map((o) => o.id), ['today', 'far']);
  assert.deepEqual(g.undated.map((o) => o.id), ['none']);
  assert.deepEqual(g.applied.map((o) => o.id), ['done']);
  assert.deepEqual(g.past.map((o) => o.id), ['closed1']);
  assert.equal(g.hiddenPast, 1);
});
