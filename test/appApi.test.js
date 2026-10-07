import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerAppRoutes } from '../src/appApi.js';
import { AuthError, signSession } from '../src/appAuth.js';
import { Prefs } from '../src/prefs.js';
import { fakeTenants, fakeLine, makeSvc, memoryStore } from './helpers/appFakes.js';

const SECRET = 'test-secret';
const NOW = new Date('2026-10-07T05:51:00Z'); // 12:51 in Bangkok
const ALICE = 'U' + 'a'.repeat(32);
const BOB = 'U' + 'b'.repeat(32);
const MALLORY = 'U' + 'c'.repeat(32);
const GROUP = 'C' + '1'.repeat(32);
const OTHER_GROUP = 'C' + '2'.repeat(32);

let server;
let base;
let tenants;
let line;
let prefsDocs;
let langCalls;

before(async () => {
  tenants = fakeTenants({
    tenants: [
      { id: ALICE, type: 'user', name: 'Alice' },
      { id: BOB, type: 'user', name: 'Bob' },
      { id: GROUP, type: 'group', name: 'Study group', hostUserId: ALICE, subFolders: ['Groups', 'Study group'] },
      { id: OTHER_GROUP, type: 'group', name: 'Other', hostUserId: BOB, subFolders: ['Groups', 'Other'] },
    ],
  });
  tenants.attach(ALICE, makeSvc({ id: ALICE }, {
    files: [
      { id: 'fA1', name: '10-21-05_receipt.jpg', day: '2026-10-07', mimeType: 'image/jpeg', hasThumb: true, webViewLink: 'https://drive/fA1' },
      { id: 'fA2', name: 'bookbank.pdf', day: '2026-10-03', mimeType: 'application/pdf', webViewLink: 'https://drive/fA2' },
      { id: 'notes', name: 'notes.md', day: '2026-10-07', mimeType: 'text/markdown' },
    ],
    events: [{ id: 'e1', title: 'Team meeting', start: '2026-10-08T07:00:00Z', end: '2026-10-08T08:00:00Z', allDay: false }],
  }));
  tenants.attach(BOB, makeSvc({ id: BOB }));
  tenants.attach(GROUP, makeSvc({ id: GROUP }, { files: [{ id: 'fG1', name: 'slides.pdf', day: '2026-10-06', mimeType: 'application/pdf' }] }));
  tenants.attach(OTHER_GROUP, makeSvc({ id: OTHER_GROUP }));
  line = fakeLine({ members: { [GROUP]: [ALICE, BOB] }, profiles: { [ALICE]: 'Alice', [BOB]: 'Bob' } });
  const ownerStore = memoryStore();
  prefsDocs = ownerStore.docs;
  langCalls = [];

  const app = express();
  registerAppRoutes(app, {
    tenants,
    lineClient: line,
    sessionSecret: SECRET,
    prefs: new Prefs(ownerStore),
    timeZone: 'Asia/Bangkok',
    verifyIdToken: async (idToken) => {
      if (idToken === 'good-alice-token-0123456789') return { userId: ALICE, name: 'Alice' };
      throw new AuthError('invalid_token');
    },
    aiUsage: async () => ({ total: 3, resetAt: '2026-10-07T07:00:00.000Z', models: [{ model: 'm1', used: 3, limit: null, exhausted: false }] }),
    thumbUrlFor: (_req, tid, fid) => `https://x/thumb/${tid}/${fid}`,
    onLangChanged: async (uid, lang) => { langCalls.push([uid, lang]); return { menuSwitched: true }; },
    settings: { liffId: '1234-abcd', rootFolderName: 'LineArchive', multiUser: true },
    now: () => NOW,
  });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/app`;
});

after(() => server?.close());

const tokenFor = (uid, opts) => signSession(SECRET, uid, { now: NOW.getTime(), ...opts }).token;

async function call(method, path, { uid = ALICE, token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  const t = token ?? (uid ? tokenFor(uid) : '');
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

// ------------------------------------------------------------------ auth

test('config is public and leaks no data', async () => {
  const r = await call('GET', '/config', { uid: null });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['botName', 'liffId', 'preview', 'timeZone']);
});

test('session needs an ID token LINE accepts', async () => {
  const bad = await call('POST', '/session', { uid: null, body: { idToken: 'forged', userId: ALICE } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'unauthenticated');
  const ok = await call('POST', '/session', { uid: null, body: { idToken: 'good-alice-token-0123456789' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
  assert.equal(ok.json.user.name, 'Alice');
  assert.deepEqual(ok.json.contexts.map((c) => c.id), ['me', GROUP], 'host sees the group they host, not other groups');
});

test('data routes refuse missing, forged and expired sessions', async () => {
  assert.equal((await call('GET', '/me', { uid: null })).status, 401);
  const forged = tokenFor(ALICE).replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
  assert.equal((await call('GET', '/me', { token: forged })).json.error, 'unauthenticated');
  const expired = signSession(SECRET, ALICE, { now: NOW.getTime() - 13 * 3600_000 }).token;
  const r = await call('GET', '/me', { token: expired });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'session_expired');
  const otherSecret = signSession('another-secret', ALICE, { now: NOW.getTime() }).token;
  assert.equal((await call('GET', '/me', { token: otherSecret })).status, 401);
});

test('a client-supplied user id is ignored; the session decides', async () => {
  // Mallory has a valid session for herself but asks for Alice's data.
  const r = await call('GET', `/reminders?userId=${ALICE}`, { uid: MALLORY });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'not_connected');
  const post = await call('POST', '/reminders', { uid: BOB, body: { userId: ALICE, text: 'x', date: '2026-10-08', time: '09:00', key: 'bob-key-0001' } });
  assert.equal(post.status, 201);
  const aliceList = await call('GET', '/reminders', { uid: ALICE });
  assert.equal(aliceList.json.items.some((x) => x.text === 'x'), false, "Bob's reminder never lands in Alice's tenant");
});

// ------------------------------------------------------- group boundaries

test('group library: members and host get in, others do not', async () => {
  const asBob = await call('GET', `/library?ctx=${GROUP}&tab=files`, { uid: BOB });
  assert.equal(asBob.status, 200);
  assert.deepEqual(asBob.json.items.map((f) => f.id), ['fG1']);
  assert.equal(asBob.json.owner.kind, 'group');
  const asMallory = await call('GET', `/library?ctx=${GROUP}&tab=files`, { uid: MALLORY });
  assert.equal(asMallory.status, 403);
  const unknown = await call('GET', `/library?ctx=${'C' + '9'.repeat(32)}`, { uid: ALICE });
  assert.equal(unknown.status, 403, 'unknown and forbidden groups look the same');
  const notMember = await call('GET', `/library?ctx=${OTHER_GROUP}`, { uid: ALICE });
  assert.equal(notMember.status, 403);
  assert.equal((await call('GET', '/library?ctx=../../etc', { uid: ALICE })).status, 400);
});

test('group context never exposes the host calendar or personal files', async () => {
  const planner = await call('GET', `/planner?ctx=${GROUP}&from=2026-10-05&to=2026-10-11`, { uid: BOB });
  assert.equal(planner.status, 200);
  assert.equal(planner.json.events.status, 'not_applicable');
  assert.deepEqual(planner.json.events.items, []);
  const personalFile = await call('GET', `/files/fA1?ctx=${GROUP}`, { uid: BOB });
  assert.equal(personalFile.status, 404, "a group member can't open the host's personal file by id");
  const own = await call('GET', '/files/fA1', { uid: ALICE });
  assert.equal(own.status, 200);
  assert.equal(own.json.file.name, '10-21-05_receipt.jpg');
});

test('disconnect is personal only and needs confirmation', async () => {
  assert.equal((await call('POST', '/disconnect', { uid: BOB, body: {} })).status, 400);
  const r = await call('POST', '/disconnect', { uid: BOB, body: { confirm: true, ctx: GROUP } });
  assert.equal(r.status, 200);
  assert.equal(r.json.groupsReleased, 1);
  assert.equal(await tenants.get(BOB), null);
  // Put Bob back for the other tests.
  tenants.reg.set(BOB, { id: BOB, type: 'user', name: 'Bob', subFolders: [] });
  tenants.reg.set(OTHER_GROUP, { id: OTHER_GROUP, type: 'group', name: 'Other', hostUserId: BOB, subFolders: [] });
  tenants.attach(BOB, makeSvc({ id: BOB }));
  tenants.attach(OTHER_GROUP, makeSvc({ id: OTHER_GROUP }));
});

// -------------------------------------------------------------- reminders

test('reminder create validates and is idempotent by key', async () => {
  const past = await call('POST', '/reminders', { body: { text: 'late', date: '2026-10-07', time: '12:00', key: 'k-past-0001' } });
  assert.equal(past.status, 400);
  assert.equal(past.json.fields.when, 'past');
  const badTime = await call('POST', '/reminders', { body: { text: 'x', date: '2026-10-08', time: '2 โมง', key: 'k-bad-00001' } });
  assert.equal(badTime.json.fields.time, 'invalid');
  const noText = await call('POST', '/reminders', { body: { text: '  ', date: '2026-10-08', time: '09:00', key: 'k-none-0001' } });
  assert.equal(noText.json.fields.text, 'required');

  const body = { text: 'ส่งเอกสาร', date: '2026-10-08', time: '10:15', repeat: 'none', key: 'k-same-0001' };
  const [a, b] = await Promise.all([call('POST', '/reminders', { body }), call('POST', '/reminders', { body })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.json.reminder.id, b.json.reminder.id);
  assert.equal(a.json.reminder.at, '2026-10-08T03:15:00.000Z', '10:15 Bangkok');
  const list = await call('GET', '/reminders');
  assert.equal(list.json.items.filter((x) => x.text === 'ส่งเอกสาร').length, 1);
});

test('monthly reminders keep their anchor day', async () => {
  const r = await call('POST', '/reminders', { body: { text: 'rent', date: '2026-10-31', time: '20:00', repeat: 'monthly', key: 'k-month-001' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.reminder.anchorDay, 31);
});

test('edit, snooze, done and cancel follow the chat semantics', async () => {
  const made = await call('POST', '/reminders', { body: { text: 'call clinic', date: '2026-10-07', time: '18:00', key: 'k-edit-0001' } });
  const id = made.json.reminder.id;
  const stale = await call('PATCH', `/reminders/${id}`, { body: { date: '2026-10-07', time: '19:00', expectAt: '2026-01-01T00:00:00.000Z' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'changed');
  const moved = await call('PATCH', `/reminders/${id}`, { body: { date: '2026-10-07', time: '19:00', expectAt: made.json.reminder.at } });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.reminder.at, '2026-10-07T12:00:00.000Z');
  assert.equal((await call('POST', `/reminders/${id}/done`)).status, 409, 'not due yet');
  const snoozed = await call('POST', `/reminders/${id}/snooze`, { body: { minutes: 10 } });
  assert.equal(snoozed.json.reminder.at, '2026-10-07T06:01:00.000Z');
  assert.equal((await call('POST', `/reminders/${id}/snooze`, { body: { minutes: 0 } })).status, 400);
  assert.equal((await call('DELETE', `/reminders/${id}`)).status, 200);
  assert.equal((await call('DELETE', `/reminders/${id}`)).status, 404);

  const rep = await call('POST', '/reminders', { body: { text: 'pill', date: '2026-10-07', time: '21:00', repeat: 'daily', key: 'k-rep-00001' } });
  const sn = await call('POST', `/reminders/${rep.json.reminder.id}/snooze`, { body: { minutes: 60 } });
  assert.notEqual(sn.json.reminder.id, rep.json.reminder.id, 'snoozing a repeat adds a one-off copy');
  assert.equal(sn.json.reminder.repeat, 'none');
});

test('deadline alerts cannot be edited as plain reminders', async () => {
  const svc = tenants.svcs.get(ALICE);
  const r = await svc.store.addReminder({ userId: ALICE, text: 'alert', at: '2026-10-09T02:00:00.000Z', oppId: 'o1' });
  assert.equal((await call('DELETE', `/reminders/${r.id}`)).json.error, 'deadline_alert');
});

// -------------------------------------------------------------- deadlines

test('deadline delete, restore, applied and per-item alerts', async () => {
  const svc = tenants.svcs.get(ALICE);
  const opp = await svc.store.addOpportunity({ title: 'Youth Forum', deadline: '2026-10-10', deadline_note: '23:59', kind: 'application', userId: ALICE });
  const d = await call('GET', `/deadlines/${opp.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.json.item.deadlineNote, '23:59');
  assert.equal(d.json.item.daysLeft, 3);
  assert.equal(d.json.alerts.mode, 'default');
  assert.ok(d.json.alerts.schedule.some((a) => a.past), 'past alerts are listed as past, not hidden');

  const own = await call('PUT', `/deadlines/${opp.id}/alerts`, { body: { preset: 'light' } });
  assert.equal(own.json.alerts.mode, 'own');
  assert.deepEqual(own.json.alerts.days, [3, 1, 0]);
  assert.equal((await call('PUT', `/deadlines/${opp.id}/alerts`, { body: { preset: 'weird' } })).status, 400);

  const applied = await call('POST', `/deadlines/${opp.id}/applied`, { body: { applied: true } });
  assert.equal(applied.json.item.status, 'applied');
  assert.equal(applied.json.alerts.mode, 'stopped');
  assert.deepEqual(applied.json.alerts.schedule, []);

  const del = await call('DELETE', `/deadlines/${opp.id}`);
  assert.equal(del.status, 200);
  assert.equal((await call('GET', `/deadlines/${opp.id}`)).status, 404);
  const back = await call('POST', `/deadlines/${opp.id}/restore`);
  assert.equal(back.status, 200);
  assert.equal(back.json.item.title, 'Youth Forum');
  assert.equal((await call('POST', `/deadlines/${opp.id}/restore`)).status, 200, 'second tap reports the item, no error');
  assert.equal((await call('POST', '/deadlines/nope/restore')).status, 410);
  assert.equal((await call('POST', `/deadlines/${opp.id}/split`)).status, 409, 'only the latest merge can be split');
});

test('chat-wide alert schedule validates days and time', async () => {
  assert.equal((await call('PUT', '/deadline-alerts', { body: { days: [7, 'x'], time: '09:00' } })).status, 400);
  assert.equal((await call('PUT', '/deadline-alerts', { body: { days: [14, 7, 3, 1, 0], time: '25:00' } })).status, 400);
  const ok = await call('PUT', '/deadline-alerts', { body: { days: [14, 7, 3, 1, 0], time: '20:00' } });
  assert.deepEqual(ok.json.alerts, { days: [14, 7, 3, 1, 0], time: '20:00' });
  const off = await call('PUT', '/deadline-alerts', { body: { off: true, time: '20:00' } });
  assert.deepEqual(off.json.alerts.days, []);
});

// ---------------------------------------------------------------- library

test('library search, counts and forgetting', async () => {
  const svc = tenants.svcs.get(ALICE);
  const m = await svc.store.remember('ที่จอดรถ ชั้น 3 ช่อง B12', { userId: ALICE });
  const files = await call('GET', '/library?tab=files');
  assert.deepEqual(files.json.items.map((f) => f.id), ['fA1', 'fA2'], 'notes.md is not a library file; newest first');
  assert.equal(files.json.items[0].thumb, `https://x/thumb/${ALICE}/fA1`);
  assert.equal(files.json.items[1].thumb, '', 'no thumbnail link without a Drive thumbnail');
  assert.equal(files.json.counts.memory, 1);
  assert.equal(files.json.owner.email, 'j***@gmail.com');
  const q = await call('GET', '/library?tab=files&q=bookbank');
  assert.deepEqual(q.json.items.map((f) => f.id), ['fA2']);
  const mem = await call('GET', '/library?tab=memory&q=B12');
  assert.equal(mem.json.items[0].id, m.id);
  assert.equal((await call('DELETE', `/memories/${m.id}`)).status, 200);
  assert.equal((await call('DELETE', `/memories/${m.id}`)).status, 404);
});

test('a failed read is an error, never an empty list', async () => {
  const svc = tenants.svcs.get(ALICE);
  svc.drive.failAllFiles = true;
  const files = await call('GET', '/library?tab=files');
  assert.equal(files.status, 502);
  assert.equal(files.json.error, 'upstream_failed');
  const links = await call('GET', '/library?tab=links');
  assert.equal(links.status, 200);
  assert.equal(links.json.counts.files, null, 'unknown count is null, not 0');
  const planner = await call('GET', '/planner?from=2026-10-05&to=2026-10-11');
  assert.equal(planner.json.saved.status, 'error');
  svc.drive.failAllFiles = false;

  svc.drive.failReads = true;
  const rem = await call('GET', '/reminders');
  assert.equal(rem.status, 502);
  svc.drive.failReads = false;
});

test('planner reports calendar trouble as partial, not as no events', async () => {
  const svc = tenants.svcs.get(ALICE);
  const ok = await call('GET', '/planner?from=2026-10-05&to=2026-10-11');
  assert.equal(ok.json.events.status, 'ok');
  assert.equal(ok.json.events.items[0].title, 'Team meeting');
  assert.equal(ok.json.today, '2026-10-07');
  svc.calendar.fail = 'scope';
  assert.equal((await call('GET', '/planner?from=2026-10-05&to=2026-10-11')).json.events.status, 'no_scope');
  svc.calendar.fail = 'error';
  assert.equal((await call('GET', '/planner?from=2026-10-05&to=2026-10-11')).json.events.status, 'error');
  svc.calendar.fail = null;
  assert.equal((await call('GET', '/planner?from=2026-10-05&to=2027-10-11')).status, 400, 'range is capped');
});

// ------------------------------------------------------------- me / prefs

test('me shows estimated shared AI usage and real counts', async () => {
  const r = await call('GET', '/me');
  assert.equal(r.status, 200);
  assert.equal(r.json.ai.estimated, true);
  assert.equal(r.json.ai.models[0].limit, null, 'unknown limit stays unknown');
  assert.equal(r.json.drive.email, 'j***@gmail.com');
  assert.equal(r.json.calendar, 'ok');
  assert.equal(r.json.counts.files, 2);
  assert.equal(typeof r.json.counts.deadlines.open, 'number');
  const none = await call('GET', '/me', { uid: MALLORY });
  assert.equal(none.json.connected, false);
  assert.equal(none.json.drive.status, 'not_connected');
});

test('language is stored per verified user and switches the menu', async () => {
  assert.equal((await call('PUT', '/prefs', { body: { lang: 'fr' } })).status, 400);
  const r = await call('PUT', '/prefs', { body: { lang: 'en' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.prefs, { lang: 'en', tone: 'polite', chosen: true });
  assert.equal(r.json.menu.menuSwitched, true);
  assert.deepEqual(langCalls.at(-1), [ALICE, 'en']);
  assert.equal(JSON.parse(JSON.stringify([...prefsDocs.get('prefs.json')[ALICE] ? ['ok'] : []]))[0], 'ok');
  const again = await call('POST', '/session', { uid: null, body: { idToken: 'good-alice-token-0123456789' } });
  assert.equal(again.json.prefs.lang, 'en', 'survives a reload: it is on the server, not in the browser');
  const tone = await call('PUT', '/prefs', { body: { tone: 'friend' } });
  assert.equal(tone.json.prefs.tone, 'friend');
  assert.equal(langCalls.length, 1, 'changing only the tone does not touch the menu');
});
