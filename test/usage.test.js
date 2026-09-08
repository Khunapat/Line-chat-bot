import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Usage, parseQuota, quotaDay, nextReset, describeReset } from '../src/providers/usage.js';

const GEMINI_429 = Object.assign(new Error('{"error":{"code":429,"message":"You exceeded your current quota. limit: 20, model: gemini-3.6-flash","status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20"}]}]}}'), { status: 429 });

function fakeStore(initial = null) {
  const s = { writes: [], async read() { return initial; }, async write(name, v) { s.writes.push([name, JSON.parse(JSON.stringify(v))]); } };
  return s;
}

test('parseQuota reads limit and daily flag from a Gemini 429', () => {
  assert.deepEqual(parseQuota(GEMINI_429), { limit: 20, daily: true });
  assert.deepEqual(parseQuota(Object.assign(new Error('Quota exceeded for GenerateRequestsPerMinute'), { status: 429 })), { limit: null, daily: false });
  assert.equal(parseQuota(new Error('boom')), null);
});

test('Usage counts per model, learns the limit on 429, and persists', async () => {
  const store = fakeStore();
  const u = new Usage({ store, flushMs: 1 });
  await u.record('a');
  await u.record('a');
  await u.record('b');
  await u.record('a', GEMINI_429);
  const snap = await u.snapshot(['a', 'b', 'c']);
  assert.equal(snap.total, 21);
  assert.deepEqual(snap.models.map((m) => [m.model, m.used, m.limit, m.exhausted]), [['a', 20, 20, true], ['b', 1, null, false], ['c', 0, null, false]]);
  await u.flush();
  assert.equal(store.writes.at(-1)[0], 'ai-usage.json');
  assert.equal(store.writes.at(-1)[1].models.a.used, 20);
});

test('Usage starts from the saved doc and rolls over on a new quota day', async () => {
  const u = new Usage({ store: fakeStore({ day: '2000-01-01', models: { a: { used: 9, limit: 20, exhausted: true } } }) });
  const snap = await u.snapshot(['a']);
  assert.equal(snap.day, quotaDay());
  assert.equal(snap.models[0].used, 0);
});

test('nextReset is the next Pacific midnight, described in the bot zone', () => {
  const now = new Date('2026-09-08T16:38:59Z'); // 09:38 Pacific, 23:38 Bangkok
  const reset = nextReset(now);
  assert.equal(reset.toISOString(), '2026-09-09T07:00:00.000Z'); // PDT midnight
  assert.equal(quotaDay(now), '2026-09-08');
  assert.equal(describeReset(reset, 'Asia/Bangkok', now), 'พรุ่งนี้ 14:00 น.');
  assert.equal(describeReset(reset, 'Asia/Bangkok', new Date('2026-09-09T01:00:00Z')), '14:00 น.');
});
