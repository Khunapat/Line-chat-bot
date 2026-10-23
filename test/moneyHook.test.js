import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { registerMoneyHook, hookToken, tokenUser, verifyHookToken, newNonce, readMessage, looksLikeMoney, HOOK_LIMITS } from '../src/moneyHook.js';
import { Prefs } from '../src/prefs.js';
import * as subs from '../src/subscriptionService.js';
import { fakeTenants, makeSvc, memoryStore } from './helpers/appFakes.js';

const SECRET = 'hook-secret';
const ALICE = 'U' + 'a'.repeat(32);
const BOB = 'U' + 'b'.repeat(32); // has no Drive connected
const GROUP = 'C' + '1'.repeat(32);
const NOW = new Date('2026-10-23T03:00:00Z');
const BBL = readFileSync(new URL('./fixtures/bbl-payment.txt', import.meta.url), 'utf8');

let server;
let base;
let prefs;
let svc;
let pushed;
let aiCalls;
let clock;

before(async () => {
  const tenants = fakeTenants({ tenants: [{ id: ALICE, type: 'user', name: 'Alice' }, { id: GROUP, type: 'group', hostUserId: ALICE }] });
  svc = makeSvc({ id: ALICE, type: 'user' });
  tenants.attach(ALICE, svc);
  tenants.attach(GROUP, makeSvc({ id: GROUP, type: 'group' }));
  prefs = new Prefs(memoryStore());
  pushed = [];
  aiCalls = [];
  clock = NOW;
  const provider = {
    async extract({ parts }) {
      const text = parts.map((p) => p.text).join('\n');
      aiCalls.push(text);
      if (/free trial/i.test(text)) return { kind: 'trial_started', merchant: 'Canva', service: 'Canva Pro', amount: 0, currency: 'THB', date: '2026-10-23', card_last4: '', cycle: 'monthly', trial_end_date: '2026-11-22', looks_recurring: true };
      return { kind: 'none', merchant: '', service: '', amount: 0, currency: 'THB', date: '', card_last4: '', cycle: 'unknown', trial_end_date: '', looks_recurring: false };
    },
  };
  const app = express();
  registerMoneyHook(app, { tenants, prefs, secret: SECRET, provider, timeZone: 'Asia/Bangkok', now: () => clock, notify: async (userId, r) => { pushed.push({ userId, outcome: r.outcome }); } });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());
beforeEach(() => { pushed.length = 0; aiCalls.length = 0; });

async function enable(userId) {
  const nonce = newNonce();
  await prefs.setHookNonce(userId, nonce);
  return hookToken(SECRET, userId, nonce);
}

const post = (token, body, { path = false, type = 'application/json' } = {}) => fetch(`${base}/hooks/money${path ? `/${token}` : ''}`, {
  method: 'POST',
  headers: { 'content-type': type, ...(path ? {} : { authorization: `Bearer ${token}` }) },
  body: type === 'application/json' ? JSON.stringify(body) : body,
});

test('tokens: name the person, need the current nonce', async () => {
  const t = await enable(ALICE);
  assert.equal(tokenUser(t), ALICE);
  assert.equal(await verifyHookToken(SECRET, t, prefs), ALICE);
  assert.equal(await verifyHookToken('other-secret', t, prefs), null);
  assert.equal(tokenUser('nope'), null);
  assert.equal(tokenUser(`${Buffer.from('not-a-line-id-at-all-x').toString('base64url')}.${'a'.repeat(32)}`), null);
  // a new nonce retires the old link; switching off retires all
  const t2 = await enable(ALICE);
  assert.equal(await verifyHookToken(SECRET, t, prefs), null);
  assert.equal(await verifyHookToken(SECRET, t2, prefs), ALICE);
  await prefs.setHookNonce(ALICE, '');
  assert.equal(await verifyHookToken(SECRET, t2, prefs), null);
});

test('bad or switched-off links get the same 404', async () => {
  const r1 = await post('garbage', { text: 'x' });
  assert.equal(r1.status, 404);
  const t = await enable(ALICE);
  await prefs.setHookNonce(ALICE, '');
  const r2 = await post(t, { text: 'บัตร xx1234 ใช้จ่าย 419.00 บาท ที่ NETFLIX.COM' });
  assert.equal(r2.status, 404);
  assert.deepEqual(await r2.json(), { error: 'not_found' });
});

test('a bank e-mail is read by pattern, without AI, and a one-off payment stays quiet', async () => {
  const t = await enable(ALICE);
  const r = await post(t, { source: 'email', id: 'gmail-1', subject: 'Payment confirmation', text: BBL });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, outcome: 'one_off', read: 'pattern' });
  assert.equal(aiCalls.length, 0);
  assert.equal(pushed.length, 0);
  // the same e-mail again (Apps Script retry)
  const again = await post(t, { source: 'email', id: 'gmail-1', subject: 'Payment confirmation', text: BBL });
  assert.equal((await again.json()).outcome, 'duplicate');
  // nothing of the message text is stored, only the charge
  const charges = svc.drive.docs.get('charges.json');
  assert.equal(JSON.stringify(charges).includes('ธนาคารกรุงเทพ'), false);
  assert.equal(charges.history.at(-1).merchant, 'DEMO NOODLE SHOP (ทดสอบ)');
});

test('an SMS for a new subscription-like charge pushes a question; a tracked one stays quiet', async () => {
  const t = await enable(ALICE);
  const sms = 'บัตร xx1234 ใช้จ่าย 419.00 บาท ที่ NETFLIX.COM 23/10/69 10:05';
  const r = await post(t, sms, { type: 'text/plain' });
  assert.equal((await r.json()).outcome, 'new');
  assert.deepEqual(pushed, [{ userId: ALICE, outcome: 'new' }]);
  const [p] = await subs.listPending(svc, { now: NOW });
  await subs.resolvePending(svc, p.id, 'track', { cycle: 'monthly', userId: ALICE, timeZone: 'Asia/Bangkok', now: NOW });
  pushed.length = 0;
  clock = new Date('2026-11-23T03:00:00Z');
  const next = await post(t, { text: 'บัตร xx1234 ใช้จ่าย 419.00 บาท ที่ NETFLIX.COM 23/11/69 10:02' }, { path: true });
  assert.equal((await next.json()).outcome, 'matched');
  assert.equal(pushed.length, 0);
  clock = NOW;
});

test('a test call checks the link without reading or storing anything', async () => {
  const t = await enable(ALICE);
  const before = JSON.stringify(svc.drive.docs.get('charges.json') || null);
  assert.deepEqual(await (await post(t, { test: true })).json(), { ok: true, outcome: 'test' });
  assert.equal(JSON.stringify(svc.drive.docs.get('charges.json') || null), before);
});

test('a Bangkok Bank balance SMS is understood without AI and stays quiet', async () => {
  const t = await enable(ALICE);
  const r = await post(t, 'ถอน/โอน/จ่ายเงินจากบ/ชX0000 ผ่านบัตร 699.00บ ใช้ได้697.49บ', { type: 'text/plain' });
  assert.deepEqual(await r.json(), { ok: true, outcome: 'ignored', read: 'pattern' });
  assert.equal(aiCalls.length, 0);
  assert.equal(pushed.length, 0);
  const c = await post(t, "21/10 09:33 ชำระ189.00บ โดยบัตร x'1111 ณGOOGLE(GOOGLE ONE", { type: 'text/plain' });
  assert.equal((await c.json()).outcome, 'new');
  assert.deepEqual(pushed, [{ userId: ALICE, outcome: 'new' }]);
});

test('one-time passwords are dropped before anything is read', async () => {
  const t = await enable(ALICE);
  const r = await post(t, { text: 'OTP=829112 (Ref: AB12) for payment of THB 419.00 at NETFLIX.COM' });
  assert.deepEqual(await r.json(), { ok: true, outcome: 'skipped' });
  assert.equal(aiCalls.length, 0);
});

test('unknown formats go to the AI only when they look like money; nothing else is stored', async () => {
  const t = await enable(ALICE);
  const trial = await post(t, { source: 'email', id: 'g-2', subject: 'Your free trial has started', text: 'Welcome to Canva Pro. Your free trial ends on 22 Nov 2026, then THB 299/month.' });
  assert.deepEqual(await trial.json(), { ok: true, outcome: 'trial_saved', read: 'ai' });
  assert.deepEqual(pushed, [{ userId: ALICE, outcome: 'trial_saved' }]);
  const chatter = await post(t, { source: 'email', id: 'g-3', subject: 'Lunch?', text: 'see you at noon' });
  assert.deepEqual(await chatter.json(), { ok: true, outcome: 'not_a_charge' });
  assert.equal(aiCalls.length, 1); // the lunch e-mail never reached the AI
  const ad = await post(t, { source: 'email', id: 'g-4', subject: 'Statement', text: 'Your statement total is 1,234 THB' });
  assert.equal((await ad.json()).outcome, 'not_a_charge'); // the AI said "none"
  assert.equal(aiCalls.length, 2);
  const resend = await post(t, { source: 'email', id: 'g-4', subject: 'Statement', text: 'Your statement total is 1,234 THB' });
  assert.equal((await resend.json()).outcome, 'duplicate');
  assert.equal(aiCalls.length, 2);
});

test('people without a connected Drive, groups, empty and oversized bodies', async () => {
  const tb = await enable(BOB);
  assert.equal((await post(tb, { text: 'บัตร xx1 ใช้จ่าย 1.00 บาท ที่ X' })).status, 409);
  // a token can only ever name a LINE user, never a group id
  assert.equal(tokenUser(hookToken(SECRET, GROUP, 'n')), null);
  const t = await enable(ALICE);
  assert.equal((await post(t, { text: '   ' })).status, 400);
  assert.equal((await post(t, '{bad json', { type: 'application/json' })).status, 400);
  assert.equal((await post(t, { text: 'x'.repeat(70_000) })).status, 413);
});

test('rate limit per person per hour', async () => {
  const t = await enable(ALICE);
  clock = new Date('2026-10-24T03:00:00Z');
  let last;
  for (let i = 0; i <= HOOK_LIMITS.perHour; i++) last = await post(t, { text: `hello ${i}` });
  assert.equal(last.status, 429);
  clock = new Date('2026-10-24T04:30:00Z');
  assert.equal((await post(t, { text: 'hello again' })).status, 200);
  clock = NOW;
});

test('message shapes from different forwarders', () => {
  assert.deepEqual(readMessage({ body: 'raw sms' }), { text: 'raw sms', source: 'sms', id: '', subject: '' });
  assert.deepEqual(readMessage({ body: { message: 'm', from: 'KBank' } }), { text: 'm', source: 'sms', id: '', subject: '' });
  assert.deepEqual(readMessage({ body: { body: 'b', subject: 'Receipt', messageId: 'abc' } }), { text: 'b', source: 'email', id: 'abc', subject: 'Receipt' });
  assert.equal(looksLikeMoney('Your receipt: 35.00'), true);
  assert.equal(looksLikeMoney('see you at noon'), false);
});
