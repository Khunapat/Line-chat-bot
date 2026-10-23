import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSvc } from './helpers/appFakes.js';
import * as subs from '../src/subscriptionService.js';
import * as deadlines from '../src/deadlineService.js';

const TZ = 'Asia/Bangkok';
const now = new Date('2026-10-23T03:00:00Z'); // 10:00 in Bangkok
const opts = { userId: 'U1', timeZone: TZ, now };
const personal = () => makeSvc({ id: 'U1', type: 'user', name: 'Jai' });

const alertsOf = async (svc, subId) => (await svc.store.reminders()).filter((r) => r.subId === subId).sort((a, b) => a.at.localeCompare(b.at));

beforeEach(() => subs.resetUpkeep());

test('a trial gets alerts 2 days, 1 day and the morning of its last day', async () => {
  const svc = personal();
  const { sub, created } = await subs.saveSubscription(svc, { name: 'Canva Pro', status: 'trial', trialEndsOn: '2026-10-30', amount: 299, cycle: 'monthly' }, opts);
  assert.equal(created, true);
  assert.equal(sub.remind, true);
  assert.equal(sub.anchorDay, 30);
  const alerts = await alertsOf(svc, sub.id);
  assert.deepEqual(alerts.map((a) => a.at), ['2026-10-28T02:00:00.000Z', '2026-10-29T02:00:00.000Z', '2026-10-30T02:00:00.000Z']);
  assert.ok(alerts.every((a) => a.kind === 'subscription' && a.on === '2026-10-30' && a.alertKind === 'trial'));
  // they are not ordinary reminders the person set
  assert.ok(alerts.every((a) => !a.oppId));
});

test('saving the same name again updates it; similar but different services stay apart', async () => {
  const svc = personal();
  const a = await subs.saveSubscription(svc, { name: 'ChatGPT', amount: 20, currency: 'USD' }, opts);
  const b = await subs.saveSubscription(svc, { name: 'ChatGPT Plus', nextChargeOn: '2026-11-05' }, opts);
  assert.equal(b.created, false);
  assert.equal(b.sub.id, a.sub.id);
  assert.equal(b.sub.name, 'ChatGPT Plus');
  assert.equal(b.sub.amount, 20);
  await subs.saveSubscription(svc, { name: 'YouTube Premium', amount: 179 }, opts);
  await subs.saveSubscription(svc, { name: 'YouTube Music', amount: 129 }, opts);
  assert.equal((await subs.listSubscriptions(svc)).length, 3);
});

test('a charge for a saved plan is quiet and moves the next date', async () => {
  const svc = personal();
  const { sub } = await subs.saveSubscription(svc, { name: 'Netflix', amount: 419, nextChargeOn: '2026-10-23' }, opts);
  const r = await subs.recordCharge(svc, { kind: 'charge', merchant: 'NETFLIX.COM', amount: 419, on: '2026-10-23', cardLast4: '1234' }, { ...opts, source: 'sms', fp: 'sms:1' });
  assert.equal(r.outcome, 'matched');
  assert.equal(r.notify, false);
  assert.equal(r.sub.id, sub.id);
  assert.equal(r.sub.nextChargeOn, '2026-11-23');
  assert.equal(r.sub.lastChargedOn, '2026-10-23');
  assert.deepEqual(r.sub.aliases, ['netflixcom']);
  assert.equal(r.sub.cardLast4, '1234');
  // the same message again, and the same charge told by e-mail
  assert.equal((await subs.recordCharge(svc, { kind: 'charge', merchant: 'NETFLIX.COM', amount: 419, on: '2026-10-23' }, { ...opts, fp: 'sms:1' })).outcome, 'duplicate');
  assert.equal((await subs.recordCharge(svc, { kind: 'charge', merchant: 'Netflix', amount: 419, on: '2026-10-23' }, { ...opts, source: 'email', fp: 'email:x' })).outcome, 'duplicate');
  assert.equal((await subs.getSubscription(svc, sub.id)).nextChargeOn, '2026-11-23');
});

test('a new charge from a subscription-like service asks; the answer saves it', async () => {
  const svc = personal();
  const r = await subs.recordCharge(svc, { kind: 'charge', merchant: 'SPOTIFY P1A2B3', amount: 149, on: '2026-10-23' }, { ...opts, source: 'sms' });
  assert.equal(r.outcome, 'new');
  assert.equal(r.notify, true);
  assert.equal(r.pending.reason, 'known');
  assert.equal((await subs.listPending(svc, { now })).length, 1);
  const t = await subs.resolvePending(svc, r.pending.id, 'track', { ...opts, cycle: 'monthly' });
  assert.equal(t.outcome, 'tracked');
  assert.equal(t.sub.name, 'Spotify');
  assert.equal(t.sub.amount, 149);
  assert.equal(t.sub.lastChargedOn, '2026-10-23');
  assert.equal(t.sub.nextChargeOn, '2026-11-23');
  assert.equal(t.sub.remind, false); // monthly: no alert unless asked
  assert.equal((await subs.listPending(svc, { now })).length, 0);
  assert.equal(await subs.resolvePending(svc, r.pending.id, 'track', opts), null); // answered already
  // next month, another random suffix on the descriptor
  const next = await subs.recordCharge(svc, { kind: 'charge', merchant: 'SPOTIFY X9Y8Z7', amount: 149, on: '2026-11-23' }, { ...opts, now: new Date('2026-11-23T03:00:00Z') });
  assert.equal(next.outcome, 'matched');
  assert.equal(next.sub.nextChargeOn, '2026-12-23');
});

test('one-time purchases stay quiet; the same merchant and amount a month later asks', async () => {
  const svc = personal();
  const first = await subs.recordCharge(svc, { kind: 'charge', merchant: 'DEMOAPP.COM', amount: 99, on: '2026-09-22' }, { ...opts, now: new Date('2026-09-22T03:00:00Z') });
  assert.equal(first.outcome, 'one_off');
  assert.equal(first.notify, false);
  assert.equal(first.pending, null);
  const again = await subs.recordCharge(svc, { kind: 'charge', merchant: 'DEMOAPP.COM', amount: 99, on: '2026-10-22' }, opts);
  assert.equal(again.outcome, 'new');
  assert.equal(again.pending.reason, 'recurring');
  assert.equal(again.pending.cycle, 'monthly');
});

test('payments made from the account are never asked about; chat can still offer to track', async () => {
  const svc = personal();
  const bbl = { kind: 'payment', merchant: 'DEMO NOODLE SHOP (ทดสอบ)', amount: 45, on: '2026-10-05', cardLast4: '567' };
  const r = await subs.recordCharge(svc, bbl, { ...opts, source: 'email', fp: 'email:1' });
  assert.equal(r.outcome, 'one_off');
  assert.equal(r.notify, false);
  assert.equal(r.pending, null);
  const chat = await subs.recordCharge(svc, { ...bbl, amount: 60, on: '2026-10-06' }, { ...opts, source: 'chat', keepPending: true });
  assert.equal(chat.outcome, 'one_off');
  assert.ok(chat.pending);
  const once = await subs.resolvePending(svc, chat.pending.id, 'once', opts);
  assert.equal(once.outcome, 'dismissed');
  assert.equal((await subs.recordCharge(svc, { kind: 'transfer', merchant: 'Somchai', amount: 500 }, opts)).outcome, 'ignored');
});

test('a known service answered "one-time" is not asked about again', async () => {
  const svc = personal();
  const r = await subs.recordCharge(svc, { kind: 'charge', merchant: 'STEAM PURCHASE', amount: 350, on: '2026-10-01' }, opts);
  assert.equal(r.outcome, 'new');
  await subs.resolvePending(svc, r.pending.id, 'once', opts);
  const later = await subs.recordCharge(svc, { kind: 'charge', merchant: 'STEAM PURCHASE', amount: 899, on: '2026-10-20' }, opts);
  assert.equal(later.outcome, 'one_off');
});

test('a trial that turns into a charge is reported, and becomes a paid plan', async () => {
  const svc = personal();
  const { sub } = await subs.saveSubscription(svc, { name: 'ChatGPT Plus', status: 'trial', trialEndsOn: '2026-10-25', amount: 20, currency: 'USD' }, opts);
  // 2 days before (the 23rd, 09:00) has passed already at 10:00
  assert.equal((await alertsOf(svc, sub.id)).length, 2);
  const at = new Date('2026-10-25T01:00:00Z');
  const r = await subs.recordCharge(svc, { kind: 'charge', merchant: 'OPENAI *CHATGPT SUBSCR', amount: 20, currency: 'USD', on: '2026-10-25' }, { ...opts, now: at });
  assert.equal(r.outcome, 'trial_converted');
  assert.equal(r.notify, true);
  assert.equal(r.sub.status, 'active');
  assert.equal(r.sub.nextChargeOn, '2026-11-25');
  assert.equal(r.sub.remind, false);
  // the last trial alert (09:00 that day) is not sent any more
  assert.deepEqual((await alertsOf(svc, sub.id)).filter((a) => new Date(a.at) > at), []);
});

test('a small card check during a trial is not the first charge', async () => {
  const svc = personal();
  await subs.saveSubscription(svc, { name: 'Netflix', status: 'trial', trialEndsOn: '2026-10-30', amount: 419 }, opts);
  const r = await subs.recordCharge(svc, { kind: 'charge', merchant: 'NETFLIX.COM', amount: 1 }, opts);
  assert.equal(r.outcome, 'matched');
  assert.equal(r.sub.status, 'trial');
});

test('a charge after cancelling, a price rise, and exchange-rate noise', async () => {
  const svc = personal();
  const { sub: nf } = await subs.saveSubscription(svc, { name: 'Netflix', amount: 419, nextChargeOn: '2026-10-23' }, opts);
  await subs.updateSubscription(svc, nf.id, { status: 'cancelled' }, opts);
  const c = await subs.recordCharge(svc, { kind: 'charge', merchant: 'NETFLIX.COM', amount: 419 }, opts);
  assert.equal(c.outcome, 'charged_after_cancel');
  assert.equal(c.notify, true);
  assert.equal(c.sub.id, nf.id);

  await subs.saveSubscription(svc, { name: 'Spotify', amount: 149, nextChargeOn: '2026-10-23' }, opts);
  const p = await subs.recordCharge(svc, { kind: 'charge', merchant: 'SPOTIFY P1', amount: 169 }, opts);
  assert.equal(p.outcome, 'price_change');
  assert.equal(p.previousAmount, 149);
  assert.equal(p.sub.amount, 169);

  await subs.saveSubscription(svc, { name: 'Claude Pro', amount: 720, nextChargeOn: '2026-10-23' }, opts);
  const fx = await subs.recordCharge(svc, { kind: 'charge', merchant: 'CLAUDE.AI SUBSCRIPTION', amount: 735 }, opts);
  assert.equal(fx.outcome, 'matched');
  assert.equal(fx.notify, false);
});

test('a "free trial started" e-mail saves the trial with its alerts', async () => {
  const svc = personal();
  const r = await subs.recordCharge(svc, { kind: 'trial_started', merchant: '', service: 'Duolingo Max', amount: 0, trialEndsOn: '2026-10-30', cycle: 'monthly' }, { ...opts, source: 'email' });
  assert.equal(r.outcome, 'trial_saved');
  assert.equal(r.notify, true);
  assert.equal(r.sub.status, 'trial');
  assert.equal(r.sub.name, 'Duolingo Max');
  assert.equal((await alertsOf(svc, r.sub.id)).length, 3);
  // a renewal notice for something not saved asks
  const n = await subs.recordCharge(svc, { kind: 'renewal_notice', merchant: 'Adobe', amount: 9000, cycle: 'yearly', on: '2026-11-15' }, opts);
  assert.equal(n.outcome, 'new');
  assert.equal(n.pending.reason, 'renewal');
  const t = await subs.resolvePending(svc, n.pending.id, 'track', { ...opts, cycle: 'yearly' });
  assert.equal(t.sub.nextChargeOn, '2026-11-15');
  assert.equal(t.sub.remind, true); // yearly
  assert.deepEqual((await alertsOf(svc, t.sub.id)).map((a) => a.offset), [7, 1]);
});

test('daily upkeep: a trial past its end becomes active; runs once a day', async () => {
  const svc = personal();
  const { sub } = await subs.saveSubscription(svc, { name: 'Canva Pro', status: 'trial', trialEndsOn: '2026-10-22', amount: 299 }, { ...opts, now: new Date('2026-10-01T03:00:00Z') });
  assert.equal(await subs.ensureSubsUpToDate(svc, { timeZone: TZ, now }), 1);
  const s = await subs.getSubscription(svc, sub.id);
  assert.equal(s.status, 'active');
  assert.equal(s.nextChargeOn, '2026-11-22');
  assert.equal(s.trialEndedOn, '2026-10-22');
  assert.equal(await subs.ensureSubsUpToDate(svc, { timeZone: TZ, now }), 0);
});

test('due alerts: one per subscription, dropped when the date moved or it was cancelled', async () => {
  const svc = personal();
  const { sub } = await subs.saveSubscription(svc, { name: 'Canva Pro', status: 'trial', trialEndsOn: '2026-10-25' }, opts);
  const all = await alertsOf(svc, sub.id); // the 24th (1 day before) and the 25th
  const one = await subs.dueAlerts(svc, all.slice(0, 1), { timeZone: TZ, now });
  assert.equal(one.length, 1);
  assert.equal(one[0].offset, 1);
  assert.equal(one[0].daysLeft, 2);
  assert.equal(one[0].kind, 'trial');
  const both = await subs.dueAlerts(svc, all, { timeZone: TZ, now });
  assert.deepEqual(both.map((d) => d.offset), [0]);
  await subs.updateSubscription(svc, sub.id, { trialEndsOn: '2026-11-01' }, opts);
  assert.deepEqual(await subs.dueAlerts(svc, all, { timeZone: TZ, now }), []);
  assert.deepEqual(await subs.dueAlerts(svc, [{ id: 'r', text: 'x' }], { timeZone: TZ, now }), []);
});

test('changing the alert time of day moves subscription alerts too', async () => {
  const svc = personal();
  const { sub } = await subs.saveSubscription(svc, { name: 'Canva Pro', status: 'trial', trialEndsOn: '2026-10-30' }, opts);
  await deadlines.setAlertSettings(svc, { time: '20:00' }, { timeZone: TZ, now });
  const alerts = await alertsOf(svc, sub.id);
  assert.deepEqual(alerts.map((a) => a.at), ['2026-10-28T13:00:00.000Z', '2026-10-29T13:00:00.000Z', '2026-10-30T13:00:00.000Z']);
});

test('remind on / off, delete removes alerts', async () => {
  const svc = personal();
  const { sub } = await subs.saveSubscription(svc, { name: 'Netflix', amount: 419, nextChargeOn: '2026-11-01' }, opts);
  assert.equal((await alertsOf(svc, sub.id)).length, 0);
  await subs.updateSubscription(svc, sub.id, { remind: true }, opts);
  assert.deepEqual((await alertsOf(svc, sub.id)).map((a) => a.at), ['2026-10-31T02:00:00.000Z']);
  assert.equal((await subs.deleteSubscription(svc, sub.id)).name, 'Netflix');
  assert.equal((await alertsOf(svc, sub.id)).length, 0);
  assert.equal(await subs.deleteSubscription(svc, sub.id), null);
  assert.equal(await subs.updateSubscription(svc, 'nope', { remind: true }, opts), null);
});

test('only one open question per merchant, at most ten', async () => {
  const svc = personal();
  await subs.recordCharge(svc, { kind: 'charge', merchant: 'NETFLIX.COM', amount: 419, on: '2026-10-01' }, opts);
  await subs.recordCharge(svc, { kind: 'charge', merchant: 'NETFLIX.COM', amount: 419, on: '2026-10-20' }, opts);
  assert.equal((await subs.listPending(svc, { now })).length, 1);
  for (let i = 0; i < 12; i++) await subs.recordCharge(svc, { kind: 'charge', merchant: `SPOTIFY ${'abcdefghijkl'[i]}x`, amount: 10 + i, on: '2026-10-21' }, { ...opts, keepPending: true });
  assert.equal((await subs.listPending(svc, { now })).length, 10);
});

test('groups never hold subscriptions', async () => {
  const svc = makeSvc({ id: 'C' + 'a'.repeat(32), type: 'group', hostUserId: 'U1' });
  await assert.rejects(subs.listSubscriptions(svc), (e) => e.code === 'personal_only');
  await assert.rejects(subs.recordCharge(svc, { kind: 'charge', merchant: 'X', amount: 1 }, opts), (e) => e.code === 'personal_only');
  assert.equal(await subs.ensureSubsUpToDate(svc, { timeZone: TZ, now }), 0);
});

test('display names from card descriptors', () => {
  assert.equal(subs.displayName('SPOTIFY P1A2B3'), 'Spotify');
  assert.equal(subs.displayName('OPENAI *CHATGPT SUBSCR'), 'Openai Chatgpt');
  assert.equal(subs.displayName('Netflix.com'), 'Netflix.com');
  assert.equal(subs.displayName('NETFLIX.COM'), 'Netflix.Com');
  assert.equal(subs.displayName('ร้านทดสอบ'), 'ร้านทดสอบ');
});
