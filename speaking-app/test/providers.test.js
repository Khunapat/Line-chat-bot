import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, MockProvider, toTurns, DEFAULT_GEMINI_MODEL } from '../lib/providers.js';
import { getDay } from '../lib/plan.js';
import { isQuotaError } from '../lib/errors.js';

test('createProvider auto-detects from keys', () => {
  assert.equal(createProvider({}).name, 'mock');
  assert.equal(createProvider({ GEMINI_API_KEY: 'g' }).name, 'gemini');
  assert.equal(createProvider({ ANTHROPIC_API_KEY: 'a' }).name, 'anthropic');
  assert.equal(createProvider({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }).name, 'gemini');
});

test('LLM_PROVIDER overrides auto-detect and is validated', () => {
  assert.equal(createProvider({ LLM_PROVIDER: 'mock', GEMINI_API_KEY: 'g' }).name, 'mock');
  assert.equal(createProvider({ LLM_PROVIDER: 'Anthropic', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }).name, 'anthropic');
  assert.throws(() => createProvider({ LLM_PROVIDER: 'gemini' }), /GEMINI_API_KEY/);
  assert.throws(() => createProvider({ LLM_PROVIDER: 'anthropic' }), /ANTHROPIC_API_KEY/);
  assert.throws(() => createProvider({ LLM_PROVIDER: 'gpt' }), /Unknown LLM_PROVIDER/);
});

test('model settings come from env', () => {
  assert.deepEqual(createProvider({ GEMINI_API_KEY: 'g' }).models, DEFAULT_GEMINI_MODEL.split(','));
  assert.deepEqual(createProvider({ GEMINI_API_KEY: 'g', GEMINI_MODEL: 'a, b' }).models, ['a', 'b']);
  const claude = createProvider({ ANTHROPIC_API_KEY: 'a', CLAUDE_MODEL: 'claude-x', CLAUDE_EFFORT: 'high' });
  assert.equal(claude.model, 'claude-x');
  assert.equal(claude.effort, 'high');
  assert.equal(createProvider({ ANTHROPIC_API_KEY: 'a' }).model, 'claude-opus-5');
  assert.equal(createProvider({ ANTHROPIC_API_KEY: 'a' }).effort, 'low');
});

test('mock opens the session with the day topic', async () => {
  const mock = new MockProvider();
  const reply = await mock.chat({ system: '', messages: [], day: getDay(3) });
  assert.equal(reply, "你好！今天是第3天：What's your name。我们开始吧！你今天怎么样？");
});

test('mock replies are deterministic and echo the user', async () => {
  const mock = new MockProvider();
  const messages = [{ role: 'assistant', text: 'hi' }, { role: 'user', text: '我叫小明' }];
  const a = await mock.chat({ system: '', messages, day: getDay(3) });
  const b = await mock.chat({ system: '', messages, day: getDay(3) });
  assert.equal(a, b);
  assert.match(a, /^好的！你说：「我叫小明」。/);

  const two = [...messages, { role: 'assistant', text: a }, { role: 'user', text: '我是泰国人' }];
  const c = await mock.chat({ system: '', messages: two, day: getDay(3) });
  assert.match(c, /「我是泰国人」/);
  assert.notEqual(c.split('。').at(-1), a.split('。').at(-1), 'next question cycles');

  const long = '我'.repeat(60);
  const d = await mock.chat({ system: '', messages: [{ role: 'user', text: long }], day: getDay(3) });
  assert.ok(d.includes(`「${'我'.repeat(40)}」`));
});

test('mock summary uses the day words (review: words of the reviewed days)', async () => {
  const mock = new MockProvider();
  const s = await mock.summarize({ system: '', messages: [], schema: {}, day: getDay(1) });
  assert.deepEqual(s.words.map((w) => w.hanzi), getDay(1).words);
  assert.deepEqual(s.words[0], { hanzi: '你好', pinyin: '-', meaning: '-' });
  assert.deepEqual(s.mistakes, ['(mock) no real analysis']);
  assert.equal(s.practice, '我今天练习了Hello。');

  const r = await mock.summarize({ system: '', messages: [], schema: {}, day: getDay(5) });
  assert.deepEqual(r.words.map((w) => w.hanzi).slice(0, 3), getDay(1).words.slice(0, 3));
  assert.equal(r.words.length, 12);
});

test('toTurns starts with a user turn and merges repeated roles', () => {
  const t = toTurns([]);
  assert.equal(t.length, 1);
  assert.equal(t[0].role, 'user');

  const turns = toTurns([
    { role: 'assistant', text: 'A' },
    { role: 'user', text: 'u1' },
    { role: 'user', text: 'u2' },
  ]);
  assert.deepEqual(turns.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(turns[2].text, 'u1\nu2');
});

test('isQuotaError spots rate limits and overloads', () => {
  assert.ok(isQuotaError({ status: 429 }));
  assert.ok(isQuotaError({ status: 529 }));
  assert.ok(isQuotaError(new Error('RESOURCE_EXHAUSTED: quota')));
  assert.ok(isQuotaError({ error: { error: { type: 'overloaded_error' } } }));
  assert.ok(!isQuotaError(new Error('boom')));
  assert.ok(!isQuotaError(null));
});
