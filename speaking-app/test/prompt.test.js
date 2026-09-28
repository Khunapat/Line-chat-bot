import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildSummaryPrompt, SUMMARY_SCHEMA, explainLanguage } from '../lib/prompt.js';
import { getDay } from '../lib/plan.js';

test('system prompt contains the day topic, words and scene', () => {
  const p = buildSystemPrompt(getDay(7));
  assert.match(p, /Day 7/);
  assert.match(p, /I can speak Chinese/);
  for (const w of getDay(7).words) assert.ok(p.includes(w), `includes ${w}`);
  assert.ok(p.includes(getDay(7).scene));
  // warm-up reuses the two previous lesson days
  assert.ok(p.includes('几口人') && p.includes('哪国人') === false);
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
  const p = buildSystemPrompt(10);
  assert.match(p, /REVIEW day/);
  for (const d of [6, 7, 8, 9]) {
    assert.ok(p.includes(getDay(d).topic), `mentions day ${d}`);
    for (const w of getDay(d).words) assert.ok(p.includes(w));
  }
  assert.ok(p.includes('Birthday dinner planning'));
});

test('summary prompt asks for words with pinyin, mistakes and practice', () => {
  const p = buildSummaryPrompt(getDay(9));
  assert.match(p, /pinyin with tone marks/);
  assert.match(p, /up to 3/);
  assert.match(p, /practice/);
  assert.ok(p.includes('多少钱'));
  assert.deepEqual(SUMMARY_SCHEMA.required, ['words', 'mistakes', 'practice']);
});

test('unknown day throws', () => {
  assert.throws(() => buildSystemPrompt(31), /unknown plan day/);
});
