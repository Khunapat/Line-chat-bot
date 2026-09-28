import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, REVIEW_DAYS, TOTAL_DAYS, getDay } from '../lib/plan.js';
import { HSK_WORDS } from '../lib/hsk-words.js';

const lessons = PLAN.filter((d) => !d.review);
const normPinyin = (p) => p.toLowerCase().replace(/[\s'-]/g, '');

test('plan has 36 consecutive days in 6 weeks of 6 days', () => {
  assert.equal(TOTAL_DAYS, 36);
  assert.equal(PLAN.length, 36);
  PLAN.forEach((d, i) => {
    assert.equal(d.day, i + 1);
    assert.equal(d.week, Math.ceil((i + 1) / 6));
    assert.ok(d.weekTitle && d.topic && d.scene, `day ${d.day} is missing text`);
  });
  assert.equal(new Set(PLAN.map((d) => d.weekTitle)).size, 6);
});

test('lesson days follow HSK Standard Course 1 and 2, lessons 1-15, in order', () => {
  assert.equal(lessons.length, 30);
  const expected = [
    ...Array.from({ length: 15 }, (_, i) => `HSK Standard Course 1, lesson ${i + 1}`),
    ...Array.from({ length: 15 }, (_, i) => `HSK Standard Course 2, lesson ${i + 1}`),
  ];
  assert.deepEqual(lessons.map((d) => d.source), expected);
  // Spot-check titles against the books' tables of contents.
  assert.equal(getDay(1).title, '你好');
  assert.equal(getDay(17).title, '我是坐飞机来的');
  assert.equal(getDay(19).title, '九月去北京旅游最好');
  assert.equal(getDay(35).title, '新年就要到了');
  for (const d of lessons) assert.ok(d.pattern && /\p{Script=Han}/u.test(d.title), `day ${d.day} has a title and pattern`);
});

test('review days are 6, 12, 18, 24, 30, 36 with no new words', () => {
  assert.deepEqual(REVIEW_DAYS, [6, 12, 18, 24, 30, 36]);
  assert.deepEqual(PLAN.filter((d) => d.review).map((d) => d.day), REVIEW_DAYS);
  for (const day of REVIEW_DAYS) {
    const d = getDay(day);
    assert.deepEqual(d.words, []);
    assert.deepEqual(d.glossary, []);
    assert.ok(d.reviewOf.every((n) => n < day && !getDay(n).review), `day ${day} reviews lesson days before it`);
  }
  assert.deepEqual(getDay(6).reviewOf, [1, 2, 3, 4, 5]);
  assert.deepEqual(getDay(30).reviewOf, [25, 26, 27, 28, 29]);
  assert.equal(getDay(36).reviewOf.length, 30);
  assert.equal(getDay(36).topic, 'Final review');
});

test('every target word is on an official HSK level 1-2 list with a real reading', () => {
  const seen = new Map();
  for (const d of lessons) {
    assert.ok(d.glossary.length >= 4, `day ${d.day} has words`);
    assert.deepEqual(d.words, d.glossary.map((g) => g.hanzi));
    for (const g of d.glossary) {
      const entry = HSK_WORDS[g.hanzi];
      assert.ok(entry, `day ${d.day}: ${g.hanzi} is not on the HSK 2.0 or 3.0 level 1-2 lists`);
      const readings = entry[0].split('|').map(normPinyin);
      assert.ok(readings.includes(normPinyin(g.pinyin)), `day ${d.day}: ${g.hanzi} ${g.pinyin} is not one of ${entry[0]}`);
      assert.ok(g.meaning, `day ${d.day}: ${g.hanzi} has a meaning`);
      assert.ok(!seen.has(g.hanzi), `${g.hanzi} is taught on day ${seen.get(g.hanzi)} and day ${d.day}`);
      seen.set(g.hanzi, d.day);
    }
  }
  // HSK Standard Course 1 is built on the HSK 1 list, course 2 on HSK 1-2.
  for (const d of lessons.slice(0, 15)) {
    for (const w of d.words) assert.match(HSK_WORDS[w][1], /hsk\d-1/, `book 1 word ${w} is HSK level 1`);
  }
});

test('getDay only accepts integers 1..36', () => {
  assert.equal(getDay(1).day, 1);
  assert.equal(getDay(36).day, 36);
  for (const bad of [0, 37, -1, 1.5, '1', null, undefined, NaN, {}]) assert.equal(getDay(bad), null);
});
