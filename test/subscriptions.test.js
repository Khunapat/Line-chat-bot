import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokens, merchantKey, nameMatches, findSubscriptionForCharge, amountRelation, looksLikeKnownService,
  addCycle, rollForward, chargeDatesBetween, alertOffsets, planSubAlerts, advance, detectRecurring, monthlyTotals, defaultRemind,
} from '../src/subscriptions.js';

const sub = (name, extra = {}) => ({ id: name.toLowerCase().replace(/\W/g, ''), name, aliases: [], amount: 0, currency: 'THB', cycle: 'monthly', status: 'active', ...extra });

test('tokens and merchant keys drop noise', () => {
  assert.deepEqual(tokens('OPENAI *CHATGPT SUBSCR'), ['openai', 'chatgpt', 'subscr']);
  assert.deepEqual(tokens('iCloud+'), ['icloud', 'plus']);
  assert.equal(merchantKey('SPOTIFY P1A2B3'), 'spotify');
  assert.equal(merchantKey('NETFLIX.COM'), 'netflixcom');
});

test('names match card descriptors', () => {
  assert.equal(nameMatches(sub('Netflix'), 'NETFLIX.COM'), 'strong');
  assert.equal(nameMatches(sub('YouTube Premium'), 'GOOGLE *YouTubePremium'), 'strong');
  assert.equal(nameMatches(sub('ChatGPT Plus'), 'OPENAI *CHATGPT SUBSCR'), 'strong');
  assert.equal(nameMatches(sub('Spotify'), 'SPOTIFY P1A2B3'), 'strong');
  assert.equal(nameMatches(sub('Google One'), 'GOOGLE *YouTubePremium'), 'weak'); // only the billing brand
  assert.equal(nameMatches(sub('iCloud+'), 'APPLE.COM/BILL'), null);
  assert.equal(nameMatches(sub('iCloud+', { aliases: ['applecombill'] }), 'APPLE.COM/BILL'), 'strong');
  assert.equal(nameMatches(sub('Netflix'), 'SPOTIFY'), null);
});

test('amount decides between subscriptions billed under one brand', () => {
  const subs = [
    sub('Apple Music', { aliases: ['applecombill'], amount: 69 }),
    sub('iCloud+', { aliases: ['applecombill'], amount: 35 }),
  ];
  assert.equal(findSubscriptionForCharge(subs, { merchant: 'APPLE.COM/BILL', amount: 35 }).name, 'iCloud+');
  assert.equal(findSubscriptionForCharge(subs, { merchant: 'APPLE.COM/BILL', amount: 69 }).name, 'Apple Music');
  // a brand-only hit with a different amount is not a match
  const google = [sub('Google One', { amount: 70 })];
  assert.equal(findSubscriptionForCharge(google, { merchant: 'GOOGLE *YouTubePremium', amount: 179 }), null);
  assert.equal(findSubscriptionForCharge(google, { merchant: 'GOOGLE *Google One', amount: 70 }).name, 'Google One');
  // the clean service name from the AI counts too
  assert.equal(findSubscriptionForCharge([sub('ChatGPT Plus', { amount: 20, currency: 'USD' })], { merchant: 'OPENAI LLC', service: 'ChatGPT Plus', amount: 20, currency: 'USD' }).name, 'ChatGPT Plus');
  assert.equal(findSubscriptionForCharge([], { merchant: 'X', amount: 1 }), null);
});

test('amount relation', () => {
  assert.equal(amountRelation(419, 419), 'same');
  assert.equal(amountRelation(419, 449), 'near');
  assert.equal(amountRelation(419, 99), 'far');
  assert.equal(amountRelation(20, 20, 'USD', 'THB'), 'unknown');
  assert.equal(amountRelation(0, 20), 'unknown');
});

test('known services', () => {
  assert.ok(looksLikeKnownService('NETFLIX.COM'));
  assert.ok(looksLikeKnownService('OPENAI *CHATGPT SUBSCR'));
  assert.ok(looksLikeKnownService('GOOGLE *YouTubePremium'));
  assert.equal(looksLikeKnownService('DEMO NOODLE SHOP'), false);
});

test('cycles keep the day they started on', () => {
  assert.equal(addCycle('2026-01-31', 'monthly', 31), '2026-02-28');
  assert.equal(addCycle('2026-02-28', 'monthly', 31), '2026-03-31');
  assert.equal(addCycle('2028-02-29', 'yearly', 29), '2029-02-28');
  assert.equal(addCycle('2026-10-23', 'weekly'), '2026-10-30');
  assert.equal(addCycle('2026-10-23', 'unknown'), '');
  assert.equal(addCycle('bad', 'monthly'), '');
  assert.equal(rollForward('2026-01-31', 'monthly', 31, '2026-04-15'), '2026-04-30');
  assert.equal(rollForward('2026-10-23', 'monthly', 23, '2026-10-23'), '2026-10-23');
  assert.equal(rollForward('2026-10-01', 'unknown', 1, '2026-12-01'), '2026-10-01');
});

test('charge dates for the planner', () => {
  const s = sub('Netflix', { nextChargeOn: '2026-10-31', anchorDay: 31 });
  assert.deepEqual(chargeDatesBetween(s, '2026-10-01', '2026-12-31').map((x) => x.on), ['2026-10-31', '2026-11-30', '2026-12-31']);
  const t = sub('Canva', { status: 'trial', trialEndsOn: '2026-11-05' });
  assert.deepEqual(chargeDatesBetween(t, '2026-11-01', '2026-11-30'), [{ on: '2026-11-05', kind: 'trial_end' }]);
  assert.deepEqual(chargeDatesBetween({ ...s, status: 'cancelled' }, '2026-10-01', '2026-12-31'), []);
});

test('alerts: trials 2/1/0 days before, yearly 7/1, monthly only when asked', () => {
  assert.deepEqual(alertOffsets({ status: 'trial', trialEndsOn: '2026-11-05', remind: true }), [2, 1, 0]);
  assert.deepEqual(alertOffsets({ status: 'active', cycle: 'yearly', nextChargeOn: '2027-01-01', remind: true }), [7, 1]);
  assert.deepEqual(alertOffsets({ status: 'active', cycle: 'monthly', nextChargeOn: '2026-11-01', remind: true }), [1]);
  assert.deepEqual(alertOffsets({ status: 'active', cycle: 'monthly', nextChargeOn: '2026-11-01', remind: false }), []);
  assert.deepEqual(alertOffsets({ status: 'cancelled', remind: true }), []);
  assert.equal(defaultRemind('trial', 'monthly'), true);
  assert.equal(defaultRemind('active', 'yearly'), true);
  assert.equal(defaultRemind('active', 'monthly'), false);
  const now = new Date('2026-11-03T05:00:00Z'); // 12:00 Bangkok on the 3rd
  const plan = planSubAlerts({ status: 'trial', trialEndsOn: '2026-11-05', remind: true }, { time: '09:00', now });
  // the 3rd 09:00 has passed; the 4th and the 5th remain
  assert.deepEqual(plan.map((a) => [a.offset, a.at]), [[1, '2026-11-04T02:00:00.000Z'], [0, '2026-11-05T02:00:00.000Z']]);
  assert.equal(plan[0].kind, 'trial');
});

test('advance: a trial past its end becomes active; passed charge dates roll on', () => {
  const t = advance({ status: 'trial', trialEndsOn: '2026-10-20', cycle: 'monthly' }, '2026-10-23');
  assert.equal(t.trialEnded, true);
  assert.equal(t.patch.status, 'active');
  assert.equal(t.patch.nextChargeOn, '2026-11-20');
  assert.equal(t.patch.anchorDay, 20);
  assert.equal(t.patch.remind, false);
  assert.equal(advance({ status: 'trial', trialEndsOn: '2026-10-23', cycle: 'monthly' }, '2026-10-23'), null);
  assert.deepEqual(advance({ status: 'active', cycle: 'monthly', nextChargeOn: '2026-09-30', anchorDay: 31 }, '2026-10-23').patch, { nextChargeOn: '2026-10-31' });
  assert.equal(advance({ status: 'cancelled', cycle: 'monthly', nextChargeOn: '2026-01-01' }, '2026-10-23'), null);
});

test('recurring charges are spotted from history', () => {
  const history = [{ key: 'demoappcom', amount: 99, currency: 'THB', on: '2026-09-22' }];
  assert.equal(detectRecurring(history, { merchant: 'DEMOAPP.COM', amount: 99, on: '2026-10-22' }), 'monthly');
  assert.equal(detectRecurring(history, { merchant: 'DEMOAPP.COM', amount: 250, on: '2026-10-22' }), '');
  assert.equal(detectRecurring(history, { merchant: 'OTHER', amount: 99, on: '2026-10-22' }), '');
  assert.equal(detectRecurring([{ key: 'x', amount: 1200, on: '2025-10-23' }], { merchant: 'X', amount: 1200, on: '2026-10-23' }), 'yearly');
});

test('monthly totals per currency', () => {
  const totals = monthlyTotals([
    sub('A', { amount: 419 }),
    sub('B', { amount: 1200, cycle: 'yearly' }),
    sub('C', { amount: 20, currency: 'USD' }),
    sub('D', { amount: 99, status: 'cancelled' }),
    sub('E', { amount: 50, cycle: 'unknown' }),
    sub('F', { amount: 299, status: 'trial' }),
  ]);
  assert.deepEqual(totals, { THB: 519, USD: 20 });
});
