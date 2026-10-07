import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, parseNatural } from '../web/app/js/timeparse.js';

test('Thai and English times; "2 โมง" is a question, not a guess', () => {
  assert.equal(parseTime('14:30').hm, '14:30');
  assert.equal(parseTime('บ่าย 2').hm, '14:00');
  assert.equal(parseTime('3 ทุ่ม').hm, '21:00');
  assert.equal(parseTime('ตี 2').hm, '02:00');
  assert.equal(parseTime('2 โมงเช้า').hm, '08:00');
  assert.equal(parseTime('9 โมง').hm, '09:00');
  assert.equal(parseTime('2pm').hm, '14:00');
  assert.equal(parseTime('12am').hm, '00:00');
  assert.equal(parseTime('25:00'), null);
  const amb = parseTime('2 โมง');
  assert.equal(amb.ambiguous, true);
  assert.deepEqual(amb.options.map((o) => o.hm), ['08:00', '14:00']);
  assert.deepEqual(parseTime('at 2').options.map((o) => o.hm), ['02:00', '14:00']);
});

test('chat-style reminders fill the fields without saving anything', () => {
  const today = '2026-10-07';
  assert.deepEqual(parseNatural('พรุ่งนี้ 9 โมง เตือนส่งเอกสาร', { today }), { text: 'ส่งเอกสาร', day: '2026-10-08', dayImplicit: false, time: { hm: '09:00', word: '9 โมง' }, repeat: 'none' });
  const r = parseNatural('ประชุม ทุกวันจันทร์ 10:00', { today });
  assert.equal(r.repeat, 'weekly');
  assert.equal(r.day, '2026-10-12');
  assert.equal(parseNatural('จ่ายค่าเน็ต 25/10/2569 บ่าย 2', { today }).day, '2026-10-25', 'Buddhist year');
  assert.equal(parseNatural('hello', { today }), null);
});
