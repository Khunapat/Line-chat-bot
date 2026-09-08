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
