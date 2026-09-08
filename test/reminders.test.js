import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, describeWhen, localIsoWithOffset, fireDueReminders, pendingReminders, zonedParts } from '../src/reminders.js';

const TZ = 'Asia/Bangkok';

test('nextOccurrence advances by the repeat period', () => {
  const at = '2026-09-08T12:00:00.000Z';
  assert.equal(nextOccurrence(at, 'daily'), '2026-09-09T12:00:00.000Z');
  assert.equal(nextOccurrence(at, 'weekly'), '2026-09-15T12:00:00.000Z');
  assert.equal(nextOccurrence(at, 'monthly'), '2026-10-08T12:00:00.000Z');
  assert.equal(nextOccurrence(at, 'yearly'), '2027-09-08T12:00:00.000Z');
  assert.equal(nextOccurrence(at, 'none'), null);
});

test('describeWhen uses วันนี้ / พรุ่งนี้ relative to the zone', () => {
  const now = new Date('2026-09-08T10:00:00+07:00');
  assert.equal(describeWhen('2026-09-08T19:00:00+07:00', TZ, now), 'วันนี้ 19:00 น.');
  assert.equal(describeWhen('2026-09-09T10:15:00+07:00', TZ, now), 'พรุ่งนี้ 10:15 น.');
  assert.equal(describeWhen('2026-09-11T09:00:00+07:00', TZ, now), 'ศุกร์ 11 ก.ย. 09:00 น.');
  // 23:30 UTC on the 8th is already the 9th in Bangkok
  assert.equal(describeWhen('2026-09-08T23:30:00Z', TZ, now), 'พรุ่งนี้ 06:30 น.');
});

test('localIsoWithOffset renders Bangkok offset', () => {
  const d = new Date('2026-09-08T14:32:00Z');
  assert.equal(localIsoWithOffset(d, TZ), '2026-09-08T21:32:00+07:00');
  assert.equal(zonedParts(d, TZ).weekday, 2); // Tuesday
});

test('fireDueReminders notifies, hides one-offs, advances repeats, purges old', async () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const list = [
    { id: 'a', text: 'one-off', at: '2026-09-08T11:59:00Z', repeat: 'none' },
    { id: 'b', text: 'daily', at: '2026-09-06T08:00:00Z', repeat: 'daily' }, // two days stale
    { id: 'c', text: 'future', at: '2026-09-08T12:01:00Z', repeat: 'none' },
    { id: 'd', text: 'old fired', at: '2026-09-06T12:00:00Z', repeat: 'none', firedAt: '2026-09-06T12:00:30Z' },
  ];
  const store = {
    reminders: async () => list,
    removeReminder: async (id) => list.splice(list.findIndex((r) => r.id === id), 1)[0],
    updateReminder: async (id, patch) => Object.assign(list.find((r) => r.id === id), patch),
  };
  const notified = [];
  const result = await fireDueReminders(store, async (r) => notified.push(r.id), now);

  assert.deepEqual(notified, ['a', 'b']);
  assert.equal(result.fired, 2);
  assert.equal(list.find((r) => r.id === 'a').firedAt, '2026-09-08T12:00:00.000Z'); // kept, hidden
  assert.equal(list.find((r) => r.id === 'd'), undefined); // purged after a day
  assert.deepEqual(pendingReminders(list).map((r) => r.id), ['c', 'b']); // soonest first
  assert.equal(list.find((r) => r.id === 'b').at, '2026-09-09T08:00:00.000Z'); // skipped past days
  assert.ok(list.find((r) => r.id === 'c'));
});
