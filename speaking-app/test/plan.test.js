import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, REVIEW_DAYS, getDay } from '../lib/plan.js';

test('plan has 30 consecutive days in 6 weeks', () => {
  assert.equal(PLAN.length, 30);
  PLAN.forEach((d, i) => {
    assert.equal(d.day, i + 1);
    assert.equal(d.week, Math.ceil((i + 1) / 5));
    assert.ok(d.weekTitle && d.topic && d.scene, `day ${d.day} is missing text`);
  });
  assert.equal(new Set(PLAN.map((d) => d.weekTitle)).size, 6);
});

test('review days are 5, 10, 15, 20, 25, 30 with no new words', () => {
  assert.deepEqual(PLAN.filter((d) => d.review).map((d) => d.day), REVIEW_DAYS);
  assert.deepEqual(REVIEW_DAYS, [5, 10, 15, 20, 25, 30]);
  for (const day of REVIEW_DAYS) {
    const d = getDay(day);
    assert.deepEqual(d.words, []);
    assert.ok(d.reviewOf.length >= 4);
    assert.ok(d.reviewOf.every((n) => n < day && !getDay(n).review), `day ${day} reviews a lesson day before it`);
  }
  assert.deepEqual(getDay(5).reviewOf, [1, 2, 3, 4]);
  assert.deepEqual(getDay(25).reviewOf, [21, 22, 23, 24]);
  assert.equal(getDay(30).reviewOf.length, 24);
});

test('lesson days carry their target words from the curriculum', () => {
  for (const d of PLAN.filter((x) => !x.review)) {
    assert.ok(d.words.length >= 4, `day ${d.day} has words`);
    assert.ok(d.words.every((w) => typeof w === 'string' && /\p{Script=Han}/u.test(w)), `day ${d.day} words are Chinese`);
    assert.equal(d.reviewOf, undefined);
  }
  assert.deepEqual(getDay(1).words, ['你好', '您', '对不起', '没关系']);
  assert.equal(getDay(7).topic, 'I can speak Chinese');
  assert.ok(getDay(22).words.includes('爬楼梯'));
  assert.equal(getDay(29).scene, 'Discuss: city life vs countryside');
});

test('getDay only accepts integers 1..30', () => {
  assert.equal(getDay(1).day, 1);
  assert.equal(getDay(30).day, 30);
  for (const bad of [0, 31, -1, 1.5, '1', null, undefined, NaN, {}]) assert.equal(getDay(bad), null);
});
