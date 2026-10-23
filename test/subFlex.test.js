import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeQuestionCard, subscriptionCard, subscriptionAlertsMessage, chargeNoticeCard, subscriptionListCard, subCountdown, setAssetBase,
} from '../src/flex.js';
import { withLang } from '../src/lang.js';

const TZ = 'Asia/Bangkok';
const now = new Date('2026-10-23T03:00:00Z');

/** Every action and text inside a Flex message, checked against LINE's limits. */
function checkLimits(msg) {
  assert.equal(msg.type, 'flex');
  assert.ok(msg.altText.length > 0 && msg.altText.length <= 400, 'altText');
  assert.ok(JSON.stringify(msg.contents).length < 30_000, 'size');
  const actions = [];
  const texts = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.action) actions.push(node.action);
    if (node.type === 'text' && typeof node.text === 'string') texts.push(node.text);
    for (const v of Object.values(node)) if (typeof v === 'object') walk(v);
  })(msg.contents);
  for (const a of actions) {
    if (a.label) assert.ok(a.label.length <= 20, `label "${a.label}"`);
    if (a.type === 'postback') {
      assert.ok(a.data.length <= 300, 'data');
      assert.ok(!a.displayText || a.displayText.length <= 300, 'displayText');
    }
  }
  for (const t of texts) assert.ok(t.length > 0, 'empty text component');
  return { actions, texts };
}

const sub = (extra = {}) => ({ id: 's1', name: 'Netflix', amount: 419, currency: 'THB', cycle: 'monthly', status: 'active', nextChargeOn: '2026-11-23', remind: false, ...extra });
const pending = { id: 'p1', reason: 'known', cycle: 'monthly', charge: { kind: 'charge', merchant: 'SPOTIFY P1A2B3', service: '', amount: 149, currency: 'THB', on: '2026-10-23', time: '10:05', cardLast4: '1234' } };

for (const lang of ['th', 'en']) {
  test(`question card for a new charge (${lang})`, () => withLang(lang, () => {
    const { actions, texts } = checkLimits(chargeQuestionCard(pending));
    assert.deepEqual(actions.map((a) => a.data), ['action=sub_track&p=p1&c=monthly', 'action=sub_track&p=p1&c=yearly', 'action=sub_once&p=p1', 'action=sub_unknown&p=p1']);
    assert.ok(texts.includes('฿149'));
    assert.ok(texts.some((t) => t.includes('1234')));
  }));

  test(`saved subscription and trial cards (${lang})`, () => withLang(lang, () => {
    const a = checkLimits(subscriptionCard(sub(), { timeZone: TZ, now }));
    assert.deepEqual(a.actions.map((x) => x.data), ['action=sub_cancelled&id=s1', 'action=sub_remind&id=s1&on=1', 'action=sub_list']);
    const t = checkLimits(subscriptionCard(sub({ status: 'trial', trialEndsOn: '2026-10-25', nextChargeOn: '', remind: true }), { timeZone: TZ, now, alertTime: '20:00' }));
    assert.ok(t.texts.some((x) => x.includes('20:00')));
    const noDate = checkLimits(subscriptionCard(sub({ status: 'trial', trialEndsOn: '' }), { timeZone: TZ, now }));
    assert.ok(noDate.texts.some((x) => x.includes('Netflix')));
    const c = checkLimits(subscriptionCard(sub({ status: 'cancelled', cancelledAt: '2026-10-20T03:00:00Z' }), { timeZone: TZ, now }));
    assert.deepEqual(c.actions.map((x) => x.data), ['action=sub_keep&id=s1', 'action=sub_list']);
  }));

  test(`alerts before a trial ends or a plan renews (${lang})`, () => withLang(lang, () => {
    const one = subscriptionAlertsMessage([{ sub: sub({ status: 'trial', trialEndsOn: '2026-10-24' }), on: '2026-10-24', kind: 'trial', daysLeft: 1, offset: 1 }], { timeZone: TZ, now });
    const r = checkLimits(one);
    assert.equal(one.contents.type, 'bubble');
    assert.deepEqual(r.actions.map((x) => x.data), ['action=sub_cancelled&id=s1', 'action=sub_keep&id=s1', 'action=sub_list']);
    const many = subscriptionAlertsMessage([
      { sub: sub({ status: 'trial', trialEndsOn: '2026-10-24' }), on: '2026-10-24', kind: 'trial', daysLeft: 1 },
      { sub: sub({ id: 's2', name: 'Adobe', cycle: 'yearly', nextChargeOn: '2026-10-30', amount: 9000 }), on: '2026-10-30', kind: 'renewal', daysLeft: 7 },
    ], { timeZone: TZ, now });
    checkLimits(many);
    assert.equal(many.contents.type, 'carousel');
    assert.ok(many.contents.contents[1].body.contents[0].contents.at(-1).contents.some((x) => x.action?.data === 'action=sub_remind&id=s2&on=0'));
  }));

  test(`notices: trial over, charged after cancelling, renewal after cancelling, price change (${lang})`, () => withLang(lang, () => {
    const charge = { kind: 'charge', merchant: 'NETFLIX.COM', amount: 419, currency: 'THB', on: '2026-10-23' };
    for (const outcome of ['trial_converted', 'charged_after_cancel', 'renewal_after_cancel', 'price_change']) {
      const { actions } = checkLimits(chargeNoticeCard({ outcome, sub: sub(), charge, previousAmount: 399 }, { timeZone: TZ, now }));
      assert.ok(actions.length >= 1, outcome);
    }
  }));

  test(`list card (${lang})`, () => withLang(lang, () => {
    const list = [
      sub({ id: 't1', name: 'Canva Pro', status: 'trial', trialEndsOn: '2026-10-25', amount: 299 }),
      sub(),
      sub({ id: 'y1', name: 'Adobe', cycle: 'yearly', amount: 9000, nextChargeOn: '2027-01-02' }),
      sub({ id: 'c1', name: 'Old app', status: 'cancelled' }),
    ];
    const { actions, texts } = checkLimits(subscriptionListCard(list, { pendingCount: 2, timeZone: TZ, now, appUrl: 'https://liff.line.me/x#/subscriptions' }));
    assert.ok(actions.some((a) => a.data === 'action=sub_pending'));
    assert.ok(actions.some((a) => a.type === 'uri'));
    assert.ok(texts.some((t) => t.includes('1,169') || t.includes('1,169.00'))); // 419 + 9000 / 12
    checkLimits(subscriptionListCard([], { timeZone: TZ, now }));
    const big = Array.from({ length: 30 }, (_, i) => sub({ id: `s${i}`, name: `Service ${i}` }));
    checkLimits(subscriptionListCard(big, { timeZone: TZ, now }));
  }));
}

test('countdowns', () => withLang('en', () => {
  const today = '2026-10-23';
  assert.equal(subCountdown(sub({ status: 'trial', trialEndsOn: '2026-10-23' }), today, TZ), 'Ends today!');
  assert.equal(subCountdown(sub({ status: 'trial', trialEndsOn: '2026-10-24' }), today, TZ), 'Ends tomorrow');
  assert.equal(subCountdown(sub({ nextChargeOn: '2026-10-28' }), today, TZ), 'Charges in 5 days');
  assert.equal(subCountdown(sub({ status: 'cancelled', cancelledAt: '2026-10-19T18:00:00Z' }), today, TZ), 'Cancelled 20 Oct'); // Bangkok date
}));

test('the card icon is used once the public URL is known', () => {
  setAssetBase('https://bot.example');
  const msg = chargeQuestionCard(pending);
  assert.ok(JSON.stringify(msg).includes('https://bot.example/static/icons/card.png'));
  setAssetBase('');
});
