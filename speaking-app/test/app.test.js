import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, normalizeSummary, passwordMatches, headerPasswordMatches } from '../lib/app.js';
import { MockProvider } from '../lib/providers.js';
import { LogStore } from '../lib/store.js';
import { PLAN } from '../lib/plan.js';

const quiet = { warn() {}, error() {}, log() {} };

/** Start the app on a free port; returns a small client. Closed automatically. */
async function start(t, { provider = new MockProvider(), password = '', explainLang = 'en', logger = quiet, publicDir } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speaking-app-'));
  const store = new LogStore(dir);
  const app = createApp({ provider, store, password, explainLang, logger, publicDir });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(base + url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { base, dir, store, call };
}

const busyError = () => Object.assign(new Error('429 Too Many Requests: RESOURCE_EXHAUSTED'), { status: 429 });

test('health reports provider and password flag', async (t) => {
  const { call } = await start(t);
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, provider: 'mock', passwordRequired: false });
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('plan returns all 30 days', async (t) => {
  const { call } = await start(t);
  const r = await call('GET', '/api/plan');
  assert.equal(r.status, 200);
  assert.equal(r.json.days.length, 30);
  assert.deepEqual(r.json.days, JSON.parse(JSON.stringify(PLAN)));
});

test('chat opens a session with [] and replies to the user', async (t) => {
  const { call } = await start(t);
  const open = await call('POST', '/api/chat', { day: 3, messages: [] });
  assert.equal(open.status, 200);
  assert.match(open.json.reply, /第3天/);

  const next = await call('POST', '/api/chat', {
    day: 3,
    messages: [{ role: 'assistant', text: open.json.reply }, { role: 'user', text: '我叫小明' }],
  });
  assert.equal(next.status, 200);
  assert.match(next.json.reply, /我叫小明/);
});

test('chat passes the day prompt and messages to the provider', async (t) => {
  let seen;
  const provider = { name: 'fake', async chat(args) { seen = args; return '  好！  '; }, async summarize() { return {}; } };
  const { call } = await start(t, { provider, explainLang: 'th' });
  const r = await call('POST', '/api/chat', { day: 9, messages: [{ role: 'user', text: '你好', extra: 1 }] });
  assert.equal(r.json.reply, '好！');
  assert.match(seen.system, /I'd like some tea/);
  assert.match(seen.system, /Thai/);
  assert.deepEqual(seen.messages, [{ role: 'user', text: '你好' }]);
  assert.equal(seen.day.day, 9);
});

test('an empty model reply becomes a gentle fallback', async (t) => {
  const provider = { name: 'fake', async chat() { return ''; }, async summarize() { return {}; } };
  const { call } = await start(t, { provider });
  const r = await call('POST', '/api/chat', { day: 1, messages: [] });
  assert.equal(r.status, 200);
  assert.ok(r.json.reply.length > 0);
});

test('chat validation returns 400 bad_request', async (t) => {
  const { call } = await start(t);
  const user = (text) => ({ role: 'user', text });
  const cases = [
    { day: 0, messages: [] },
    { day: 31, messages: [] },
    { day: 1.5, messages: [] },
    { day: '3', messages: [] },
    { messages: [] },
    { day: 1 },
    { day: 1, messages: 'hi' },
    { day: 1, messages: Array.from({ length: 201 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x' })) },
    { day: 1, messages: [{ role: 'user', text: 5 }] },
    { day: 1, messages: [user('x'.repeat(2001))] },
    { day: 1, messages: [{ role: 'system', text: 'x' }] },
    { day: 1, messages: [null] },
    { day: 1, messages: [user('hi'), { role: 'assistant', text: 'yo' }] },
    { day: 1, messages: [user('   ')] },
  ];
  for (const body of cases) {
    const r = await call('POST', '/api/chat', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.json.error, 'bad_request');
    assert.equal(typeof r.json.detail, 'string');
  }
  const bad = await call('POST', '/api/chat', '{not json');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'bad_request');

  // Boundaries are accepted.
  const ok = await call('POST', '/api/chat', { day: 30, messages: [user('x'.repeat(2000))] });
  assert.equal(ok.status, 200);
});

test('summary saves an entry and the log lists newest first', async (t) => {
  const { call, dir } = await start(t);
  const messages = [
    { role: 'assistant', text: '你好' },
    { role: 'user', text: '我叫小明' },
    { role: 'assistant', text: '好的' },
    { role: 'user', text: '我是泰国人' },
  ];
  const r = await call('POST', '/api/summary', { day: 3, messages });
  assert.equal(r.status, 200);
  const e = r.json.entry;
  assert.equal(e.day, 3);
  assert.equal(e.turns, 2);
  assert.ok(e.id);
  assert.ok(!Number.isNaN(Date.parse(e.date)));
  assert.ok(e.summary.words.length >= 1);
  assert.deepEqual(Object.keys(e.summary.words[0]), ['hanzi', 'pinyin', 'meaning']);
  assert.deepEqual(e.summary.mistakes, ['(mock) no real analysis']);
  assert.match(e.summary.practice, /What's your name/);

  const second = await call('POST', '/api/summary', { day: 4, messages });
  const log = await call('GET', '/api/log');
  assert.equal(log.status, 200);
  assert.deepEqual(log.json.entries.map((x) => x.id), [second.json.entry.id, e.id]);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'log.json'), 'utf8'));
  assert.equal(saved.length, 2);
});

test('summary validation returns 400', async (t) => {
  const { call } = await start(t);
  for (const body of [
    { day: 3, messages: [] },
    { day: 3, messages: [{ role: 'assistant', text: '你好' }] },
    { day: 3, messages: [{ role: 'user', text: '  ' }] },
    { day: 99, messages: [{ role: 'user', text: 'hi' }] },
    { day: 3, messages: {} },
  ]) {
    const r = await call('POST', '/api/summary', body);
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'bad_request');
  }
  assert.deepEqual((await call('GET', '/api/log')).json.entries, []);
});

test('concurrent summaries are all saved', async (t) => {
  const { call } = await start(t);
  const body = { day: 1, messages: [{ role: 'user', text: '你好' }] };
  const results = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/summary', body)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal((await call('GET', '/api/log')).json.entries.length, 10);
});

test('summary output from a model is normalized', async (t) => {
  const provider = {
    name: 'fake',
    async chat() { return ''; },
    async summarize() {
      return { words: [{ hanzi: ' 茶 ', pinyin: 'chá', meaning: 'tea', extra: 1 }, { pinyin: 'x' }, 'bad'], mistakes: ['a', '', 'b', 'c', 'd'], practice: 7 };
    },
  };
  const { call } = await start(t, { provider });
  const r = await call('POST', '/api/summary', { day: 9, messages: [{ role: 'user', text: '我想喝茶' }] });
  assert.deepEqual(r.json.entry.summary, { words: [{ hanzi: '茶', pinyin: 'chá', meaning: 'tea' }], mistakes: ['a', 'b', 'c'], practice: '' });
  assert.deepEqual(normalizeSummary(null), { words: [], mistakes: [], practice: '' });
});

test('password protects every /api route except health', async (t) => {
  const { call } = await start(t, { password: 'hunter2' });
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.passwordRequired, true);

  const body = { day: 1, messages: [] };
  for (const [method, url, b] of [['GET', '/api/plan'], ['GET', '/api/log'], ['POST', '/api/chat', body], ['POST', '/api/summary', body], ['GET', '/api/nope']]) {
    const none = await call(method, url, b);
    assert.equal(none.status, 401, `${method} ${url}`);
    assert.deepEqual(none.json, { error: 'password' });
    const wrong = await call(method, url, b, { 'x-app-password': 'hunter3' });
    assert.equal(wrong.status, 401);
  }
  const ok = await call('GET', '/api/plan', undefined, { 'x-app-password': 'hunter2' });
  assert.equal(ok.status, 200);
  const chat = await call('POST', '/api/chat', body, { 'x-app-password': 'hunter2' });
  assert.equal(chat.status, 200);
  assert.ok(passwordMatches('a', 'a'));
  assert.ok(!passwordMatches(undefined, 'a'));
  assert.ok(!passwordMatches('ab', 'a'));
});

test('any password works: the page sends it percent-encoded', async (t) => {
  const password = 'รหัส密码 50%';
  const { call } = await start(t, { password });
  const ok = await call('GET', '/api/plan', undefined, { 'x-app-password': encodeURIComponent(password) });
  assert.equal(ok.status, 200);
  for (const header of [encodeURIComponent('รหัส密码 50'), '%E0%B8%A', 'x']) {
    const r = await call('GET', '/api/plan', undefined, { 'x-app-password': header });
    assert.equal(r.status, 401, header);
  }
  // Raw ASCII passwords (curl) still work, even with a "%" that is not an escape.
  assert.ok(headerPasswordMatches('a%b', 'a%b'));
  assert.ok(headerPasswordMatches(encodeURIComponent('a%b'), 'a%b'));
  assert.ok(headerPasswordMatches('hunter2', 'hunter2'));
  assert.ok(!headerPasswordMatches('%E0%B8%A', 'a'));
  assert.ok(!headerPasswordMatches(undefined, 'a'));
});

test('a summary may cover a long session (600 messages); chat stays at 200', async (t) => {
  const { call } = await start(t);
  const msgs = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '我喜欢爬楼梯' }));
  const ok = await call('POST', '/api/summary', { day: 2, messages: msgs(600) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.entry.turns, 300);
  const tooMany = await call('POST', '/api/summary', { day: 2, messages: msgs(601) });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json.detail, /at most 600/);
  const chat = await call('POST', '/api/chat', { day: 2, messages: msgs(201) });
  assert.equal(chat.status, 400);
  assert.match(chat.json.detail, /at most 200/);
});

test('quota errors become 503 busy', async (t) => {
  const provider = {
    name: 'fake',
    async chat() { throw busyError(); },
    async summarize() { throw busyError(); },
  };
  const { call } = await start(t, { provider });
  const chat = await call('POST', '/api/chat', { day: 1, messages: [] });
  assert.equal(chat.status, 503);
  assert.deepEqual(chat.json, { error: 'busy' });
  const sum = await call('POST', '/api/summary', { day: 1, messages: [{ role: 'user', text: 'hi' }] });
  assert.equal(sum.status, 503);
  assert.deepEqual(sum.json, { error: 'busy' });
  assert.deepEqual((await call('GET', '/api/log')).json.entries, [], 'nothing saved when the AI is busy');
});

test('other failures become 500 without leaking details', async (t) => {
  const logged = [];
  const logger = { ...quiet, error: (...args) => logged.push(args) };
  const provider = {
    name: 'fake',
    async chat() { throw new Error('invalid x-api-key sk-secret-123 at /srv/app.js:10'); },
    async summarize() { throw new Error('sk-secret-123'); },
  };
  const { call } = await start(t, { provider, logger });
  const r = await call('POST', '/api/chat', { day: 1, messages: [] });
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'failed' });
  assert.ok(!r.text.includes('sk-secret'));
  assert.equal(logged.length, 1, 'logged server-side');
  const s = await call('POST', '/api/summary', { day: 1, messages: [{ role: 'user', text: 'hi' }] });
  assert.equal(s.status, 500);
  assert.ok(!s.text.includes('sk-secret'));
});

test('unknown /api routes are 404 JSON; static files are served', async (t) => {
  const pub = await fs.mkdtemp(path.join(os.tmpdir(), 'speaking-pub-'));
  t.after(() => fs.rm(pub, { recursive: true, force: true }));
  await fs.writeFile(path.join(pub, 'index.html'), '<!doctype html><title>x</title>');
  const { call } = await start(t, { publicDir: pub });
  for (const [method, url] of [['GET', '/api/nope'], ['POST', '/api/plan'], ['GET', '/api']]) {
    const r = await call(method, url);
    assert.equal(r.status, 404, `${method} ${url}`);
    assert.deepEqual(r.json, { error: 'not_found' });
  }
  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<title>x<\/title>/);
});

test('oversized bodies are rejected', async (t) => {
  const { call } = await start(t);
  const r = await call('POST', '/api/chat', JSON.stringify({ day: 1, messages: [], pad: 'x'.repeat(1_100_000) }));
  assert.equal(r.status, 413);
});
