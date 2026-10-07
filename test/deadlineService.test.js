import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import * as D from '../src/deadlineService.js';

const TZ = 'Asia/Bangkok';
const now = new Date('2026-10-07T09:21:00+07:00');
const later = (min) => new Date(now.getTime() + min * 60_000);

function fakeDrive() {
  const docs = new Map();
  const slow = () => new Promise((r) => setTimeout(r, 2)); // let concurrent work interleave
  return {
    docs,
    md: '',
    async readJson(name, fallback) { await slow(); return docs.has(name) ? structuredClone(docs.get(name)) : structuredClone(fallback); },
    async writeJson(name, value) { await slow(); docs.set(name, structuredClone(value)); },
    async writeRootText(_name, text) { this.md = text; },
  };
}

function fakeCalendar() {
  const events = new Map();
  let n = 0;
  return {
    events,
    async createEvent({ title, start }) { const id = `ev${++n}`; events.set(id, { title, date: start }); return { id, title, start, allDay: true }; },
    async moveAllDayEvent(id, date) { const e = events.get(id); if (e) e.date = date; return { id }; },
    async deleteEvent(id) { return events.delete(id); },
    async findAllDay(date, summary) { return [...events].filter(([, e]) => e.date === date && e.title === summary).map(([id]) => id); },
  };
}

let tenantSeq = 0;
function makeSvc() {
  const drive = fakeDrive();
  return { drive, store: new Store(drive, { cacheMs: 0 }), calendar: fakeCalendar(), tenant: { id: `T${++tenantSeq}` } };
}

const poster = { kind: 'image', fileId: 'F1', webViewLink: 'https://drive.google.com/F1' };
const posterFields = {
  title: 'ทุน Knight-Hennessy ป.โท-เอก Stanford', kind: 'scholarship', organizer: 'Stanford', summary: 'ทุนเต็มจำนวน',
  deadline: '2026-10-20', confidence: 0.9,
};
const textFields = {
  title: 'Knight Hennessy Scholars Program', kind: 'scholarship', organizer: 'Stanford University',
  summary: 'ทุนเต็มจำนวน ป.โท-เอก ทุกสาขา ที่ Stanford พร้อมค่าใช้จ่าย 3 ปี', deadline: '2026-10-20',
  eligibility: 'จบ ป.ตรี ไม่เกิน 7 ปี', link: 'https://knight-hennessy.stanford.edu/apply', confidence: 1,
};

const alertsOf = async (svc, id) => (await svc.store.reminders()).filter((r) => r.oppId === id && !r.firedAt).map((r) => r.at).sort();

test('a poster then a message about the same call become one deadline with both details', async () => {
  const svc = makeSvc();
  const a = await D.registerOpportunity(svc, posterFields, { source: poster, userId: 'U1', timeZone: TZ, now });
  assert.equal(a.merged, false);
  assert.equal((await alertsOf(svc, a.opp.id)).length, 4); // 7, 3, 1 days before + the day
  assert.equal(svc.calendar.events.size, 1);

  const b = await D.registerOpportunity(svc, textFields, { source: { kind: 'link', url: textFields.link }, userId: 'U1', timeZone: TZ, now: later(3) });
  assert.equal(b.merged, true);
  assert.equal(b.reason, 'recent');
  assert.equal(b.opp.id, a.opp.id);
  const list = await svc.store.opportunities();
  assert.equal(list.length, 1);
  assert.equal(list[0].link, textFields.link);
  assert.equal(list[0].eligibility, textFields.eligibility);
  assert.equal(list[0].summary, textFields.summary);
  assert.equal(list[0].source.fileId, 'F1'); // the poster stays the picture
  assert.equal(list[0].sources.length, 2);
  assert.ok(b.added.includes('ลิงก์') && b.added.includes('คุณสมบัติ'));
  assert.equal((await alertsOf(svc, a.opp.id)).length, 4); // still one set of alerts
  assert.equal(svc.calendar.events.size, 1); // still one calendar entry
  assert.match(svc.drive.md, /# Opportunities \(1\)/);
});

test('a poster and a message handled at the same moment still end up as one', async () => {
  const svc = makeSvc();
  const [a, b] = await Promise.all([
    D.registerOpportunity(svc, posterFields, { source: poster, userId: 'U1', timeZone: TZ, now }),
    D.registerOpportunity(svc, textFields, { source: { kind: 'text' }, userId: 'U1', timeZone: TZ, now }),
  ]);
  assert.equal((await svc.store.opportunities()).length, 1);
  assert.equal([a.merged, b.merged].filter(Boolean).length, 1);
  assert.equal((await svc.store.reminders()).length, 4);
});

test('the model saying "same as" merges across languages; an earlier date moves alerts and calendar', async () => {
  const svc = makeSvc();
  const a = await D.registerOpportunity(svc, { title: 'Manaaki New Zealand Scholarships', deadline: '2026-10-20' }, { source: poster, userId: 'U1', timeZone: TZ, now });
  const b = await D.registerOpportunity(svc, { title: 'ทุนรัฐบาลนิวซีแลนด์', deadline: '2026-10-11', same_as: a.opp.id, ai_checked: true },
    { source: { kind: 'text' }, userId: 'U1', timeZone: TZ, now: later(60 * 24) });
  assert.equal(b.merged, true);
  assert.equal(b.reason, 'ai');
  assert.equal(b.opp.deadline, '2026-10-11');
  assert.equal(b.otherDeadline, '2026-10-20');
  const [ev] = [...svc.calendar.events.values()];
  assert.equal(ev.date, '2026-10-11');
  const ats = await alertsOf(svc, a.opp.id);
  assert.equal(ats.at(-1), '2026-10-11T02:00:00.000Z'); // last alert is the new deadline day
  assert.ok(!ats.includes('2026-10-20T02:00:00.000Z'));
});

test('splitMerge undoes a wrong merge and keeps both items', async () => {
  const svc = makeSvc();
  const a = await D.registerOpportunity(svc, posterFields, { source: poster, userId: 'U1', timeZone: TZ, now });
  // the model wrongly says "same", and its date is earlier, so the saved item moves
  const b = await D.registerOpportunity(svc, { ...textFields, deadline: '2026-10-15', same_as: a.opp.id, ai_checked: true },
    { source: { kind: 'link', url: textFields.link }, userId: 'U1', timeZone: TZ, now: later(2) });
  assert.equal(b.merged, true);
  assert.equal(b.opp.deadline, '2026-10-15');

  const r = await D.splitMerge(svc, { before: b.before, incoming: b.incoming }, { userId: 'U1', timeZone: TZ, now: later(4) });
  const list = await svc.store.opportunities();
  assert.equal(list.length, 2);
  const original = list.find((o) => o.id === a.opp.id);
  assert.equal(original.title, posterFields.title);
  assert.equal(original.deadline, '2026-10-20');
  assert.equal(original.link, '');
  assert.equal(r.created.title, textFields.title);
  assert.equal(r.created.deadline, '2026-10-15');
  assert.equal((await alertsOf(svc, a.opp.id)).at(-1), '2026-10-20T02:00:00.000Z');
  assert.equal((await alertsOf(svc, r.created.id)).at(-1), '2026-10-15T02:00:00.000Z');
  assert.equal(svc.calendar.events.size, 2);
});

test('when the model already said "different", a look-alike is only offered, then merged on request', async () => {
  const svc = makeSvc();
  const a = await D.registerOpportunity(svc, posterFields, { source: poster, userId: 'U1', timeZone: TZ, now });
  const b = await D.registerOpportunity(svc, { ...textFields, ai_checked: true }, { source: { kind: 'text' }, userId: 'U1', timeZone: TZ, now: later(1) });
  assert.equal(b.merged, false);
  assert.deepEqual(b.suggestion, { id: a.opp.id, title: posterFields.title });
  assert.equal((await svc.store.opportunities()).length, 2);

  const m = await D.mergeInto(svc, a.opp.id, b.opp.id, { timeZone: TZ, now: later(2) });
  assert.equal(m.opp.link, textFields.link);
  assert.equal((await svc.store.opportunities()).length, 1);
  assert.equal((await alertsOf(svc, b.opp.id)).length, 0);
  assert.equal(svc.calendar.events.size, 1);
  assert.equal(m.opp.sources.length, 2);
});

test('delete removes alerts and the calendar entry, undo brings it all back', async () => {
  const svc = makeSvc();
  const { opp } = await D.registerOpportunity(svc, posterFields, { source: poster, userId: 'U1', timeZone: TZ, now });
  const removed = await D.deleteOpportunity(svc, opp.id, { timeZone: TZ, now });
  assert.equal(removed.id, opp.id);
  assert.equal((await svc.store.opportunities()).length, 0);
  assert.equal((await svc.store.reminders()).length, 0);
  assert.equal(svc.calendar.events.size, 0);
  assert.equal(await D.deleteOpportunity(svc, opp.id, { timeZone: TZ, now }), null);

  const back = await D.restoreOpportunity(svc, removed, { timeZone: TZ, now });
  assert.equal(back.id, opp.id);
  assert.equal((await alertsOf(svc, opp.id)).length, 4);
  assert.equal(svc.calendar.events.size, 1);
});

test('delete finds the calendar entry of an older item by date and title', async () => {
  const svc = makeSvc();
  const { opp } = await D.registerOpportunity(svc, posterFields, { source: poster, userId: 'U1', timeZone: TZ, now });
  await svc.store.updateOpportunity(opp.id, { calendarEventId: undefined }); // made before ids were kept
  await D.deleteOpportunity(svc, opp.id, { timeZone: TZ, now });
  assert.equal(svc.calendar.events.size, 0);
});

test('applied stops the alerts, un-applying plans them again', async () => {
  const svc = makeSvc();
  const { opp } = await D.registerOpportunity(svc, posterFields, { source: poster, userId: 'U1', timeZone: TZ, now });
  const done = await D.setApplied(svc, opp.id, true, { timeZone: TZ, now });
  assert.equal(done.status, 'applied');
  assert.equal((await alertsOf(svc, opp.id)).length, 0);
  const again = await D.setApplied(svc, opp.id, false, { timeZone: TZ, now });
  assert.ok(!('status' in again));
  assert.equal((await alertsOf(svc, opp.id)).length, 4);
});

test('changing the schedule re-plans every deadline; one item can have its own days', async () => {
  const svc = makeSvc();
  const a = await D.registerOpportunity(svc, posterFields, { source: poster, userId: 'U1', timeZone: TZ, now });
  const b = await D.registerOpportunity(svc, { title: 'DAAD STEM PROGRAMME 2027', deadline: '2026-11-30' }, { source: { kind: 'text' }, userId: 'U1', timeZone: TZ, now });
  const r = await D.setAlertSettings(svc, { days: [14, 7, 3, 1, 0], time: '20:00' }, { timeZone: TZ, now });
  assert.deepEqual(r.alerts, { days: [14, 7, 3, 1, 0], time: '20:00' });
  assert.equal((await alertsOf(svc, a.opp.id)).length, 4); // 14 days before is already past
  assert.deepEqual(await alertsOf(svc, b.opp.id), [
    '2026-11-16T13:00:00.000Z', '2026-11-23T13:00:00.000Z', '2026-11-27T13:00:00.000Z', '2026-11-29T13:00:00.000Z', '2026-11-30T13:00:00.000Z',
  ]);
  const one = await D.setAlertSettings(svc, { days: [1], oppId: a.opp.id }, { timeZone: TZ, now });
  assert.equal(one.scope, 'item');
  assert.deepEqual(await alertsOf(svc, a.opp.id), ['2026-10-19T13:00:00.000Z']);
  assert.equal((await alertsOf(svc, b.opp.id)).length, 5);
  await D.setAlertSettings(svc, { reset: true, oppId: a.opp.id }, { timeZone: TZ, now });
  assert.equal((await alertsOf(svc, a.opp.id)).length, 4);
  await D.setAlertSettings(svc, { off: true }, { timeZone: TZ, now });
  assert.equal((await svc.store.reminders()).filter((r) => r.oppId).length, 0);
});

test('existing deadlines move from the old 2-alert plan to the new one exactly once', async () => {
  const svc = makeSvc();
  const o = await svc.store.addOpportunity({ title: 'SEA Youth IGF 2026', deadline: '2026-10-20', userId: 'U1' });
  await svc.store.addReminder({ text: 'อีก 3 วันจะปิดรับ: SEA Youth IGF 2026', at: '2026-10-17T02:00:00.000Z', oppId: o.id });
  await svc.store.addReminder({ text: 'วันนี้วันสุดท้าย: SEA Youth IGF 2026', at: '2026-10-20T02:00:00.000Z', oppId: o.id });
  await svc.store.addReminder({ text: 'กินยา', at: '2026-10-07T12:00:00.000Z' });
  assert.equal(await D.ensureAlertsUpToDate(svc, { timeZone: TZ, now }), true);
  assert.equal((await alertsOf(svc, o.id)).length, 4);
  assert.equal((await svc.store.reminders()).length, 5);
  assert.equal(await D.ensureAlertsUpToDate(svc, { timeZone: TZ, now }), false);
});

test('recentOpportunities lists what this user saved in the last half hour', async () => {
  const svc = makeSvc();
  await D.registerOpportunity(svc, posterFields, { source: poster, userId: 'U1', timeZone: TZ, now });
  assert.equal((await D.recentOpportunities(svc, { userId: 'U1', now: later(10) })).length, 1);
  assert.equal((await D.recentOpportunities(svc, { userId: 'U1', now: later(45) })).length, 0);
  assert.equal((await D.recentOpportunities(svc, { userId: 'U2', now: later(10) })).length, 0);
});

test('missing or bad values never switch alerts off by accident', async () => {
  const svc = makeSvc();
  const { opp } = await D.registerOpportunity(svc, posterFields, { source: poster, userId: 'U1', timeZone: TZ, now });
  await D.setAlertSettings(svc, { days: [3, 1, 0], time: '20:00' }, { timeZone: TZ, now });
  // item: no days given -> unchanged, not off
  await D.setAlertSettings(svc, { oppId: opp.id }, { timeZone: TZ, now });
  assert.equal((await alertsOf(svc, opp.id)).length, 3);
  // item: unusable days -> unchanged
  await D.setAlertSettings(svc, { days: [99], oppId: opp.id }, { timeZone: TZ, now });
  assert.equal((await alertsOf(svc, opp.id)).length, 3);
  // chat-wide: bad time keeps the current one, bad days keep the current ones
  const r = await D.setAlertSettings(svc, { days: [-1], time: '25:99' }, { timeZone: TZ, now });
  assert.deepEqual(r.alerts, { days: [3, 1, 0], time: '20:00' });
  // only the time
  const t = await D.setAlertSettings(svc, { time: '7.30' }, { timeZone: TZ, now });
  assert.deepEqual(t.alerts, { days: [3, 1, 0], time: '07:30' });
});
