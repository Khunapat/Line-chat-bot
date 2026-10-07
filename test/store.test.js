import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

/** In-memory stand-in for DriveArchive's JSON document methods. */
function fakeDrive() {
  const docs = new Map();
  return {
    docs,
    async readJson(name, fallback) { return docs.has(name) ? structuredClone(docs.get(name)) : structuredClone(fallback); },
    async writeJson(name, value) { docs.set(name, structuredClone(value)); },
  };
}

test('remember / searchMemory / forget round-trip through Drive', async () => {
  const drive = fakeDrive();
  const store = new Store(drive, { cacheMs: 0 });
  await store.remember('เลขบัญชี น็อคแคร์ กสิกร 208-1-22879-8', { userId: 'U1' });
  await store.remember('ที่จอดรถ ชั้น 3 ช่อง B12', { userId: 'U1' });

  const hits = await store.searchMemory('เลขบัญชี กสิกร');
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /208-1-22879-8/);
  assert.equal((await store.searchMemory('ไม่มีอะไรตรง')).length, 0);

  assert.ok(await store.forget(hits[0].id));
  assert.equal((await store.memories()).length, 1);
  assert.equal(drive.docs.get('memory.json').length, 1); // persisted
});

test('reminders can be added, updated, removed', async () => {
  const store = new Store(fakeDrive(), { cacheMs: 0 });
  const r = await store.addReminder({ userId: 'U1', text: 'กินยา', at: '2026-09-08T11:00:00.000Z' });
  assert.equal(r.repeat, 'none');
  assert.equal(r.id.length, 8);

  const updated = await store.updateReminder(r.id, { at: '2026-09-09T11:00:00.000Z' });
  assert.equal(updated.at, '2026-09-09T11:00:00.000Z');
  assert.equal(await store.updateReminder('nope', {}), null);

  assert.equal((await store.removeReminder(r.id)).text, 'กินยา');
  assert.deepEqual(await store.reminders(), []);
});

test('per-user state merges patches', async () => {
  const store = new Store(fakeDrive(), { cacheMs: 0 });
  await store.setUserState('U1', { lastFile: { id: 'f1', name: 'a.pdf' } });
  await store.setUserState('U1', { pending: { type: 'reschedule', id: 'r1' } });
  const s = await store.getUserState('U1');
  assert.equal(s.lastFile.id, 'f1');
  assert.equal(s.pending.id, 'r1');
  assert.deepEqual(await store.getUserState('U2'), {});
});

test('cache serves repeated reads without hitting Drive', async () => {
  const drive = fakeDrive();
  let reads = 0;
  const orig = drive.readJson.bind(drive);
  drive.readJson = async (...a) => { reads++; return orig(...a); };
  const store = new Store(drive, { cacheMs: 60_000 });
  await store.memories();
  await store.memories();
  assert.equal(reads, 1);
});

test('links are stored, searched by title/host/caption and listed newest first', async () => {
  const store = new Store(fakeDrive(), { cacheMs: 0 });
  const a = await store.addLink({ url: 'https://www.kumwell.com/apply', title: 'Kumwell Internship 2027', day: '2026-09-08', at: '2026-09-08T10:00:00Z', userId: 'U1' });
  const b = await store.addLink({ url: 'https://forms.gle/abc', title: '', day: '2026-09-09', at: '2026-09-09T10:00:00Z', userId: 'U1' });
  assert.equal(a.host, 'kumwell.com');
  await store.updateLink(b.id, { caption: 'ฟอร์มสมัครค่าย', tags: ['ค่าย'] });
  assert.deepEqual((await store.recentLinks(5)).map((l) => l.id), [b.id, a.id]);
  assert.equal((await store.searchLinks('kumwell'))[0].id, a.id);
  assert.equal((await store.searchLinks('ค่าย'))[0].id, b.id);
  assert.equal((await store.searchLinks('nothing')).length, 0);
  assert.ok(await store.removeLink(a.id));
  assert.equal((await store.links()).length, 1);
});

test('replaceDeadlineAlerts swaps future alerts in one write and keeps fired or due ones', async () => {
  const drive = fakeDrive();
  let writes = 0;
  const realWrite = drive.writeJson;
  drive.writeJson = async (n, v) => { writes++; return realWrite(n, v); };
  const store = new Store(drive, { cacheMs: 0 });
  const now = new Date('2026-10-07T02:30:00Z');
  await store.addReminder({ text: 'old D-3', at: '2026-10-10T02:00:00Z', oppId: 'o1' });          // future: replaced
  await store.addReminder({ text: 'fired', at: '2026-10-01T02:00:00Z', oppId: 'o1', firedAt: '2026-10-01T02:00:05Z' });
  await store.addReminder({ text: 'due now', at: '2026-10-07T02:00:00Z', oppId: 'o1' });         // due, not sent yet: kept
  await store.addReminder({ text: 'other deadline', at: '2026-10-12T02:00:00Z', oppId: 'o2' });
  await store.addReminder({ text: 'กินยา', at: '2026-10-07T12:00:00Z' });
  writes = 0;
  const ids = await store.replaceDeadlineAlerts(new Map([['o1', [
    { text: 'D-7', at: '2026-10-08T02:00:00Z', kind: 'deadline' },
    { text: 'D-1', at: '2026-10-12T02:00:00Z', kind: 'deadline' },
  ]]]), now);
  assert.equal(writes, 1);
  assert.equal(ids.get('o1').length, 2);
  const texts = (await store.reminders()).map((r) => r.text).sort();
  assert.deepEqual(texts, ['D-1', 'D-7', 'due now', 'fired', 'other deadline', 'กินยา']);
  assert.ok((await store.reminders()).filter((r) => r.text.startsWith('D-')).every((r) => r.oppId === 'o1' && r.repeat === 'none'));
});

test('concurrent updates to one document are queued, none is lost', async () => {
  const drive = fakeDrive();
  // a slow Drive: every read and write yields, like the real API
  const slow = (fn) => async (...a) => { await new Promise((r) => setTimeout(r, 5)); return fn(...a); };
  drive.readJson = slow(drive.readJson.bind(drive));
  drive.writeJson = slow(drive.writeJson.bind(drive));
  const store = new Store(drive, { cacheMs: 0 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.addOpportunity({ title: `t${i}` })));
  assert.equal((await store.opportunities()).length, 8);
});

test('settings and opportunity patch / restore', async () => {
  const store = new Store(fakeDrive(), { cacheMs: 0 });
  assert.deepEqual(await store.settings(), {});
  await store.updateSettings({ deadlineAlerts: { days: [3, 0], time: '20:00' } });
  assert.deepEqual((await store.settings()).deadlineAlerts, { days: [3, 0], time: '20:00' });
  const o = await store.addOpportunity({ title: 'x', status: 'applied' });
  const patched = await store.updateOpportunity(o.id, { title: 'y', status: undefined });
  assert.equal(patched.title, 'y');
  assert.ok(!('status' in patched));
  const removed = await store.removeOpportunity(o.id);
  assert.equal((await store.restoreOpportunity(removed)).id, o.id);
  assert.equal(await store.restoreOpportunity(removed), null); // already back
});
