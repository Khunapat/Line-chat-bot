import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildSummaryPrompt, SUMMARY_SCHEMA, explainLanguage } from '../lib/prompt.js';
import { getDay } from '../lib/plan.js';

test('system prompt contains the lesson, words with pinyin, pattern and scene', () => {
  const day = getDay(7);
  const p = buildSystemPrompt(day);
  assert.match(p, /Day 7 of a 36-day plan/);
  assert.match(p, /I can speak Chinese/);
  assert.ok(p.includes('HSK Standard Course 1, lesson 6') && p.includes('我会说汉语'));
  for (const g of day.glossary) assert.ok(p.includes(`${g.hanzi} ${g.pinyin}`), `includes ${g.hanzi}`);
  assert.ok(p.includes(`Grammar pattern: ${day.pattern}`));
  assert.ok(p.includes(day.scene));
  // warm-up reuses the two previous lesson days (4 and 5; day 6 is a review), not day 3
  assert.ok(p.includes('今年') && p.includes('同学'));
  assert.ok(!p.includes('名字'));
});

test('system prompt carries the voice rules', () => {
  const p = buildSystemPrompt(3);
  assert.match(p, /1-2 short/);
  assert.match(p, /no markdown/i);
  assert.match(p, /no emoji/i);
  assert.match(p, /no pinyin/i);
  assert.match(p, /question/);
  assert.ok(p.includes('慢一点') && p.includes('再说一遍') && p.includes('累了'));
  assert.match(p, /Warm-up/);
  assert.match(p, /Role-play/);
  assert.match(p, /Free talk/);
});

test('explain language follows EXPLAIN_LANG', () => {
  assert.match(buildSystemPrompt(1, { explainLang: 'en' }), /Explain in English/);
  assert.match(buildSystemPrompt(1, { explainLang: 'th' }), /Explain in Thai/);
  assert.equal(explainLanguage('xx'), 'English');
  assert.match(buildSummaryPrompt(1, { explainLang: 'th' }), /meaning in Thai/);
});

test('review day prompt lists the reviewed days and their words', () => {
  const p = buildSystemPrompt(12);
  assert.match(p, /REVIEW day/);
  for (const d of [7, 8, 9, 10, 11]) {
    assert.ok(p.includes(getDay(d).topic), `mentions day ${d}`);
    for (const w of getDay(d).words) assert.ok(p.includes(w));
  }
  assert.ok(p.includes(getDay(12).scene));
});

test('summary prompt asks for words with pinyin, mistakes and practice', () => {
  const p = buildSummaryPrompt(getDay(9));
  assert.match(p, /pinyin with tone marks/);
  assert.match(p, /up to 3/);
  assert.match(p, /practice/);
  for (const w of getDay(9).words) assert.ok(p.includes(w));
  assert.deepEqual(SUMMARY_SCHEMA.required, ['words', 'mistakes', 'practice']);
});

test('unknown day throws', () => {
  assert.throws(() => buildSystemPrompt(37), /unknown plan day/);
});
