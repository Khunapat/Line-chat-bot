/**
 * Subscriptions and free trials for one person: saving them, matching the
 * charges their bank reports, the questions JaiJa asks about new ones, and
 * the alerts before a trial ends or a plan renews.
 *
 * Personal only. Callers pass the services of a 1:1 tenant; a group's
 * services are refused, so nothing about money is stored in a shared folder.
 *
 * Drive documents (_data/):
 *   subscriptions.json  [subscription]  (shape in subscriptions.js)
 *   charges.json        { seen, history, pending, dismissed }
 *     seen       { fingerprint: ISO }  messages already handled; their text is not kept
 *     history    [{ key, merchant, amount, currency, on, kind, source, subId }]
 *     pending    [{ id, charge, reason, cycle, at }]  questions waiting for an answer
 *     dismissed  { merchantKey: ISO }  answered "one-time", so not asked again
 *
 * Alerts are ordinary reminders tagged with `subId`, sent at the deadline
 * alert time of day. Changes for one person run one at a time, so an e-mail
 * and an SMS about the same charge, arriving together, are handled once.
 */
import { withLock } from './lock.js';
import { shortId } from './store.js';
import { todayKey, isDayKey, parseKey, diffDays } from '../web/shared/dates.js';
import {
  STATUSES, CYCLES, findSubscriptionForCharge, amountRelation, looksLikeKnownService, merchantKey, compact, tokens,
  addCycle, rollForward, defaultRemind, planSubAlerts, advance, detectRecurring,
} from './subscriptions.js';
import { alertSettings, onAlertTimeChange } from './deadlineService.js';

const SUBS = 'subscriptions.json';
const CHARGES = 'charges.json';

export const LIMITS = Object.freeze({
  subs: 200, history: 600, historyDays: 400, seen: 1000, seenDays: 60, pending: 10, pendingDays: 45, dismissed: 300,
});

// Outcomes worth a LINE message when the charge arrived on its own (e-mail / SMS forwarding).
export const NOTIFY = new Set(['new', 'trial_saved', 'trial_converted', 'charged_after_cancel', 'price_change', 'renewal_after_cancel']);

const locks = new Map();
const exclusive = (svc, fn) => withLock(locks, `sub:${svc.tenant?.id ?? ''}`, fn);

export class PersonalOnlyError extends Error {
  constructor() { super('subscriptions are personal'); this.code = 'personal_only'; }
}

function personal(svc) {
  if (!svc?.store || svc.tenant?.type === 'group') throw new PersonalOnlyError();
}

const emptyCharges = () => ({ seen: {}, history: [], pending: [], dismissed: {} });
function chargesDoc(doc) {
  doc.seen ||= {};
  doc.history ||= [];
  doc.pending ||= [];
  doc.dismissed ||= {};
  return doc;
}

const copy = (x) => (x ? structuredClone(x) : x);
const today = (now, timeZone) => todayKey(timeZone, now);

// ------------------------------------------------------------ cleaning input

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanCurrency = (c) => (/^[A-Z]{3}$/.test(String(c || '').toUpperCase()) ? String(c).toUpperCase() : 'THB');
const cleanAmount = (a) => {
  const n = Math.round(Number(a) * 100) / 100;
  return Number.isFinite(n) && n > 0 && n < 10_000_000 ? n : 0;
};
const cleanDay = (d) => (isDayKey(String(d || '')) ? String(d) : '');
const cleanDigits = (d) => String(d || '').replace(/\D/g, '').slice(-4);

/** "OPENAI *CHATGPT SUBSCR" -> "Openai Chatgpt Subscr"; keeps names that already have lower case. */
export function displayName(merchant) {
  let raw = String(merchant || '');
  // "GOOGLE(GOOGLE ONE" -> "GOOGLE ONE", "GOOGLE(CLOUD FR2SV9" -> "GOOGLE CLOUD"
  const paren = /^([^(]+)\((.+)$/.exec(raw);
  if (paren) raw = paren[2].trim().toLowerCase().startsWith(paren[1].trim().toLowerCase()) ? paren[2] : `${paren[1]} ${paren[2]}`;
  raw = raw.replace(/[()]/g, ' ').replace(/\s+(?:SUBS|SUBSCR|SUBSCRIPTION|BILL|PAYMENT)\s*$/i, '');
  const s = cleanName(raw.replace(/[*_]+/g, ' ').replace(/\s+\S*\d\S*$/, ''));
  if (!s) return '';
  if (/[a-z]/.test(s) || !/[A-Z]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s./-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

/** Same subscription by name: equal, or one name extends the other ("ChatGPT" / "ChatGPT Plus"). */
export function sameName(a, b) {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)));
}

/** A real price change: same currency and more than 5% apart (smaller moves are rounding or exchange rates). */
function priceChanged(sub, charge) {
  if (!(sub.amount > 0) || !(charge.amount > 0) || (sub.currency || 'THB') !== charge.currency) return false;
  return Math.abs(sub.amount - charge.amount) / Math.max(sub.amount, charge.amount) > 0.05;
}

function sortSubs(list) {
  const rank = { trial: 0, active: 1, cancelled: 2 };
  const when = (s) => (s.status === 'trial' ? s.trialEndsOn : s.nextChargeOn) || '9999-99-99';
  return [...list].sort((a, b) => (rank[a.status] - rank[b.status]) || when(a).localeCompare(when(b)) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ alerts

/** Alert reminders for subscriptions; the caller holds the lock. */
async function planAlerts(svc, subs, { timeZone, now }) {
  if (!subs.length) return;
  const { time } = await alertSettings(svc);
  const plan = new Map(subs.map((s) => [s.id, planSubAlerts(s, { time, timeZone, now }).map((a) => ({
    userId: s.userId, text: `💳 ${s.name}`, at: a.at, repeat: 'none', kind: 'subscription', offset: a.offset, on: a.on, alertKind: a.kind,
  }))]));
  await svc.store.replaceSubscriptionAlerts(plan, now);
}

/** Re-plan every subscription's alerts (the alert time of day changed). */
export async function rescheduleAll(svc, { timeZone, now = new Date() } = {}) {
  if (svc?.tenant?.type === 'group') return;
  await exclusive(svc, async () => planAlerts(svc, await svc.store.read(SUBS, []), { timeZone, now }));
}

// Deadline and subscription alerts share the time of day.
onAlertTimeChange((svc, opts) => rescheduleAll(svc, opts));

// --------------------------------------------------------------- reading

export async function listSubscriptions(svc) {
  personal(svc);
  return sortSubs(copy(await svc.store.read(SUBS, [])));
}

export async function getSubscription(svc, id) {
  personal(svc);
  return copy((await svc.store.read(SUBS, [])).find((s) => s.id === id) || null);
}

export async function listPending(svc, { now = new Date() } = {}) {
  personal(svc);
  const doc = chargesDoc(copy(await svc.store.read(CHARGES, emptyCharges())));
  const cutoff = now.getTime() - LIMITS.pendingDays * 86_400_000;
  return doc.pending.filter((p) => Date.parse(p.at) >= cutoff);
}

// ---------------------------------------------------------------- saving

function datesFor(sub, { todayKey: t }) {
  if (sub.status === 'trial') {
    sub.nextChargeOn = '';
    if (sub.trialEndsOn) sub.anchorDay = parseKey(sub.trialEndsOn).d;
    return;
  }
  if (sub.status !== 'active') return;
  if (!sub.nextChargeOn && sub.lastChargedOn && sub.cycle !== 'unknown') {
    sub.anchorDay ||= parseKey(sub.lastChargedOn).d;
    sub.nextChargeOn = rollForward(addCycle(sub.lastChargedOn, sub.cycle, sub.anchorDay), sub.cycle, sub.anchorDay, t);
  }
  if (sub.nextChargeOn) {
    sub.anchorDay ||= parseKey(sub.nextChargeOn).d;
    if (sub.nextChargeOn < t && sub.cycle !== 'unknown') sub.nextChargeOn = rollForward(sub.nextChargeOn, sub.cycle, sub.anchorDay, t);
  }
}

/** Learn the way the card names this subscription ("NETFLIX.COM"), so later charges match. */
function learnAlias(sub, merchant) {
  const key = merchantKey(merchant);
  if (!key || key.length < 3 || compact(sub.name) === key) return;
  sub.aliases = [...new Set([...(sub.aliases || []), key])].slice(-6);
}

/**
 * Save a subscription or trial from the chat, a card button or the web app.
 * The same name again updates the saved one instead of adding a second.
 * Returns { sub, created }.
 */
export async function saveSubscription(svc, fields, { userId, source = 'chat', timeZone, now = new Date() } = {}) {
  personal(svc);
  const name = cleanName(fields.name);
  if (!name) throw Object.assign(new Error('name required'), { code: 'invalid', fields: ['name'] });
  return exclusive(svc, async () => {
    const t = today(now, timeZone);
    let created = false;
    const sub = await svc.store.update(SUBS, [], (list) => {
      let s = list.find((x) => x.status !== 'cancelled' && sameName(x.name, name))
        || list.find((x) => compact(x.name) === compact(name));
      if (!s) {
        if (list.length >= LIMITS.subs) throw Object.assign(new Error('too many subscriptions'), { code: 'limit' });
        s = { id: shortId(), name, aliases: [], amount: 0, currency: 'THB', cycle: 'monthly', status: 'active', trialEndsOn: '', nextChargeOn: '', anchorDay: null, cardLast4: '', note: '', lastChargedOn: '', charges: [], createdAt: now.toISOString(), userId, source };
        list.push(s);
        created = true;
      }
      applyFields(s, fields, { created, now });
      if (fields.merchant) learnAlias(s, fields.merchant);
      datesFor(s, { todayKey: t });
      s.updatedAt = now.toISOString();
      return copy(s);
    });
    await planAlerts(svc, [sub], { timeZone, now });
    return { sub, created };
  });
}

function applyFields(s, f, { created, now = new Date() }) {
  if (f.name && cleanName(f.name)) s.name = cleanName(f.name);
  if (f.amount !== undefined && cleanAmount(f.amount)) s.amount = cleanAmount(f.amount);
  if (f.currency) s.currency = cleanCurrency(f.currency);
  if (CYCLES.includes(f.cycle)) s.cycle = f.cycle;
  let statusChanged = false;
  if (STATUSES.includes(f.status) && f.status !== s.status) {
    s.status = f.status;
    statusChanged = true;
    if (f.status === 'cancelled') s.cancelledAt = now.toISOString();
    else delete s.cancelledAt;
  }
  if (f.trialEndsOn !== undefined && (cleanDay(f.trialEndsOn) || f.trialEndsOn === '')) s.trialEndsOn = cleanDay(f.trialEndsOn);
  if (f.nextChargeOn !== undefined && (cleanDay(f.nextChargeOn) || f.nextChargeOn === '')) {
    s.nextChargeOn = cleanDay(f.nextChargeOn);
    if (s.nextChargeOn) s.anchorDay = parseKey(s.nextChargeOn).d;
  }
  if (f.lastChargedOn && cleanDay(f.lastChargedOn)) s.lastChargedOn = cleanDay(f.lastChargedOn);
  if (f.cardLast4 !== undefined && (cleanDigits(f.cardLast4) || f.cardLast4 === '')) s.cardLast4 = cleanDigits(f.cardLast4);
  if (f.note !== undefined) s.note = String(f.note || '').trim().slice(0, 200);
  if (typeof f.remind === 'boolean') s.remind = f.remind;
  else if (created || statusChanged || typeof s.remind !== 'boolean') s.remind = defaultRemind(s.status, s.cycle);
}

/**
 * Change a saved subscription. `patch` takes the fields of saveSubscription;
 * an unknown id returns null.
 */
export async function updateSubscription(svc, id, patch, { timeZone, now = new Date() } = {}) {
  personal(svc);
  return exclusive(svc, async () => {
    const t = today(now, timeZone);
    const sub = await svc.store.update(SUBS, [], (list) => {
      const s = list.find((x) => x.id === id);
      if (!s) return null;
      const wasTrial = s.status === 'trial';
      applyFields(s, patch, { created: false, now });
      // A trial kept past its end becomes a paid plan from that day.
      if (wasTrial && s.status === 'active') {
        if (!s.nextChargeOn && s.trialEndsOn) {
          s.anchorDay = parseKey(s.trialEndsOn).d;
          s.nextChargeOn = s.cycle === 'unknown' ? '' : rollForward(s.trialEndsOn, s.cycle, s.anchorDay, t);
        }
        if (typeof patch.remind !== 'boolean') s.remind = defaultRemind('active', s.cycle);
      }
      datesFor(s, { todayKey: t });
      s.updatedAt = now.toISOString();
      return copy(s);
    });
    if (sub) await planAlerts(svc, [sub], { timeZone, now });
    return sub;
  });
}

export async function deleteSubscription(svc, id) {
  personal(svc);
  return exclusive(svc, async () => {
    const removed = await svc.store.update(SUBS, [], (list) => {
      const i = list.findIndex((x) => x.id === id);
      return i === -1 ? null : list.splice(i, 1)[0];
    });
    if (removed) await svc.store.removeSubscriptionAlerts(id);
    return removed;
  });
}

// ---------------------------------------------------------------- charges

const MONEY_KINDS = new Set(['charge', 'payment', 'transfer', 'refund', 'trial_started', 'subscription_started', 'renewal_notice']);

function trimDoc(doc, now) {
  const seenCut = now.getTime() - LIMITS.seenDays * 86_400_000;
  const seen = Object.entries(doc.seen).filter(([, at]) => Date.parse(at) >= seenCut).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, LIMITS.seen);
  doc.seen = Object.fromEntries(seen);
  const t = now.toISOString().slice(0, 10);
  doc.history = doc.history.filter((h) => isDayKey(h.on) && Math.abs(diffDays(h.on, t)) <= LIMITS.historyDays).slice(-LIMITS.history);
  const pendCut = now.getTime() - LIMITS.pendingDays * 86_400_000;
  doc.pending = doc.pending.filter((p) => Date.parse(p.at) >= pendCut).slice(-LIMITS.pending);
  doc.dismissed = Object.fromEntries(Object.entries(doc.dismissed).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, LIMITS.dismissed));
}

/** The same charge told twice (e-mail and SMS): same amount within a day, overlapping names. */
function sameCharge(h, c) {
  if (amountRelation(h.amount, c.amount, h.currency, c.currency) !== 'same') return false;
  if (!isDayKey(h.on) || !isDayKey(c.on) || Math.abs(diffDays(h.on, c.on)) > 1) return false;
  if ((h.kind === 'refund') !== (c.kind === 'refund')) return false;
  const a = new Set(tokens(h.merchant).filter((x) => x.length >= 3 && !/^\d+$/.test(x)));
  return tokens(c.merchant).some((x) => a.has(x)) || merchantKey(h.merchant) === merchantKey(c.merchant);
}

/** Apply a paid charge to its subscription (dates move on, alias learned). */
function applyCharge(s, c, t) {
  s.lastChargedOn = c.on;
  const prev = s.charges || [];
  s.charges = [...prev, { on: c.on, amount: c.amount, currency: c.currency, merchant: c.merchant.slice(0, 60) }].slice(-12);
  if (c.cardLast4 && !s.cardLast4) s.cardLast4 = c.cardLast4;
  learnAlias(s, c.merchant);
  if (s.cycle !== 'unknown') {
    s.anchorDay ||= parseKey(c.on).d;
    s.nextChargeOn = rollForward(addCycle(c.on, s.cycle, s.anchorDay), s.cycle, s.anchorDay, t);
  }
}

/**
 * The meaning of one charge, given the subscription it matched (or null) and
 * the history: { outcome, reason?, cycle?, previousAmount?, apply?(sub), create? }.
 */
function decide(charge, match, doc, t) {
  const k = charge.kind;
  if (k === 'refund') return { outcome: 'refund' };
  if (k === 'payment' || k === 'transfer') {
    // Paid from the account by the person themselves: match quietly, never ask.
    if (k === 'payment' && match && match.status !== 'cancelled' && charge.amount) return { outcome: 'matched', apply: (s) => applyCharge(s, charge, t) };
    return { outcome: k === 'payment' ? 'one_off' : 'ignored', reason: 'asked' };
  }
  if (k === 'trial_started') {
    if (match && match.status !== 'cancelled') {
      return { outcome: 'matched', apply: (s) => { if (s.status === 'trial' && charge.trialEndsOn) s.trialEndsOn = charge.trialEndsOn; learnAlias(s, charge.merchant); } };
    }
    return {
      outcome: 'trial_saved',
      create: {
        name: charge.service || displayName(charge.merchant), merchant: charge.merchant, status: 'trial', trialEndsOn: charge.trialEndsOn,
        amount: charge.amount, currency: charge.currency, cycle: charge.cycle === 'unknown' ? 'monthly' : charge.cycle, cardLast4: charge.cardLast4, remind: true,
      },
    };
  }
  if (k === 'renewal_notice' || k === 'subscription_started') {
    if (!match) return { outcome: 'new', reason: k === 'renewal_notice' ? 'renewal' : 'started' };
    if (match.status === 'cancelled') return { outcome: 'renewal_after_cancel' };
    const changedPrice = priceChanged(match, charge);
    return {
      outcome: changedPrice ? 'price_change' : 'matched',
      previousAmount: changedPrice ? match.amount : undefined,
      apply: (s) => {
        if (charge.amount && (changedPrice || !s.amount)) { s.amount = charge.amount; s.currency = charge.currency; }
        if (charge.cycle !== 'unknown') s.cycle = charge.cycle;
        if (k === 'renewal_notice' && charge.on >= t) { s.nextChargeOn = charge.on; s.anchorDay = parseKey(charge.on).d; }
        learnAlias(s, charge.merchant);
      },
    };
  }
  // A card charge.
  if (match) {
    if (match.status === 'cancelled') return { outcome: 'charged_after_cancel' };
    if (match.status === 'trial') {
      // A small card check while the trial runs is not the first real charge.
      if (match.amount && match.currency === charge.currency && charge.amount < match.amount * 0.5) return { outcome: 'matched' };
      return {
        outcome: 'trial_converted',
        apply: (s) => {
          s.status = 'active';
          s.trialEndedOn = charge.on;
          s.anchorDay = parseKey(charge.on).d;
          s.remind = defaultRemind('active', s.cycle);
          if (!s.amount || (s.currency === charge.currency && priceChanged(s, charge))) { s.amount = charge.amount; s.currency = charge.currency; }
          applyCharge(s, charge, t);
        },
      };
    }
    const changedPrice = priceChanged(match, charge);
    return {
      outcome: changedPrice ? 'price_change' : 'matched',
      previousAmount: changedPrice ? match.amount : undefined,
      apply: (s) => {
        if (changedPrice || !s.amount) { s.amount = charge.amount; s.currency = charge.currency; }
        applyCharge(s, charge, t);
      },
    };
  }
  const recurring = detectRecurring(doc.history, charge);
  if (recurring) return { outcome: 'new', reason: 'recurring', cycle: recurring };
  if (charge.looksRecurring) return { outcome: 'new', reason: 'looks_recurring' };
  const known = looksLikeKnownService(charge.merchant) || looksLikeKnownService(charge.service);
  if (known && !doc.dismissed[merchantKey(charge.merchant)]) return { outcome: 'new', reason: 'known' };
  return { outcome: 'one_off', reason: 'asked' };
}

/**
 * What a reported charge means, and remember it. `charge` is the shape from
 * chargeParse.js. Options:
 *   source       'email' | 'sms' | 'chat' | 'image' | 'app'
 *   fp           fingerprint of the message, for de-duplication
 *   keepPending  also keep a question for one-off charges (chat: the reply
 *                offers "track it anyway")
 * Returns { outcome, notify, sub?, pending?, previousAmount?, charge }.
 * Outcomes: duplicate, ignored, matched, refund, one_off, new, trial_saved,
 * trial_converted, charged_after_cancel, price_change, renewal_after_cancel.
 */
export async function recordCharge(svc, input, { source = 'chat', fp = '', userId, keepPending = false, timeZone, now = new Date() } = {}) {
  personal(svc);
  return exclusive(svc, async () => {
    const t = today(now, timeZone);
    const charge = {
      kind: MONEY_KINDS.has(input?.kind) ? input.kind : 'charge',
      merchant: cleanName(input?.merchant || input?.service).slice(0, 80),
      service: cleanName(input?.service),
      amount: cleanAmount(input?.amount),
      currency: cleanCurrency(input?.currency),
      on: cleanDay(input?.on) || t,
      time: /^\d{2}:\d{2}$/.test(input?.time || '') ? input.time : '',
      cardLast4: cleanDigits(input?.cardLast4),
      cycle: CYCLES.includes(input?.cycle) ? input.cycle : 'unknown',
      trialEndsOn: cleanDay(input?.trialEndsOn),
      looksRecurring: Boolean(input?.looksRecurring),
    };
    const result = (outcome, extra = {}) => ({ outcome, notify: NOTIFY.has(outcome), charge, ...extra });
    if (!charge.merchant || input?.kind === 'none') return result('ignored');

    const doc = chargesDoc(await svc.store.read(CHARGES, emptyCharges()));
    if (fp && doc.seen[fp]) return result('duplicate');
    if ((charge.kind === 'charge' || charge.kind === 'refund' || charge.kind === 'payment') && doc.history.some((h) => sameCharge(h, charge))) {
      await svc.store.update(CHARGES, emptyCharges(), (d) => { chargesDoc(d); if (fp) d.seen[fp] = now.toISOString(); });
      return result('duplicate');
    }

    const subs = await svc.store.read(SUBS, []);
    const match = findSubscriptionForCharge(subs, charge);
    const d = decide(charge, match, doc, t);
    const { outcome } = d;
    const pending = outcome === 'new' || (keepPending && outcome === 'one_off')
      ? { id: shortId(), at: now.toISOString(), reason: d.reason || 'asked', cycle: d.cycle || (charge.cycle !== 'unknown' ? charge.cycle : 'monthly'), charge: { ...charge } }
      : null;
    const changed = d.apply && match ? { id: match.id, apply: d.apply } : null;
    const created = d.create || null;
    const { previousAmount } = d;

    let sub = null;
    if (changed) {
      sub = await svc.store.update(SUBS, [], (list) => {
        const s = list.find((x) => x.id === changed.id);
        if (!s) return null;
        changed.apply(s);
        s.updatedAt = now.toISOString();
        return copy(s);
      });
    } else if (match) {
      sub = copy(match);
    }

    await svc.store.update(CHARGES, emptyCharges(), (d) => {
      chargesDoc(d);
      if (fp) d.seen[fp] = now.toISOString();
      if (['charge', 'payment', 'transfer', 'refund'].includes(charge.kind) && charge.amount) {
        d.history.push({ key: merchantKey(charge.merchant), merchant: charge.merchant, amount: charge.amount, currency: charge.currency, on: charge.on, kind: charge.kind, source, ...(sub ? { subId: sub.id } : {}) });
      }
      if (pending) {
        // One open question per merchant: a newer charge replaces the older question.
        d.pending = d.pending.filter((p) => merchantKey(p.charge.merchant) !== merchantKey(charge.merchant));
        d.pending.push(pending);
      }
      trimDoc(d, now);
    });

    if (created) {
      const r = await saveNow(svc, created, { userId, source, timeZone, now, t });
      sub = r;
    } else if (sub && changed) {
      await planAlerts(svc, [sub], { timeZone, now });
    }
    return result(outcome, { sub, pending, previousAmount });
  });
}

/** saveSubscription without taking the lock again (the caller holds it). */
async function saveNow(svc, fields, { userId, source, timeZone, now, t }) {
  const sub = await svc.store.update(SUBS, [], (list) => {
    if (list.length >= LIMITS.subs) return null;
    const s = { id: shortId(), name: cleanName(fields.name) || 'Subscription', aliases: [], amount: 0, currency: 'THB', cycle: 'monthly', status: 'active', trialEndsOn: '', nextChargeOn: '', anchorDay: null, cardLast4: '', note: '', lastChargedOn: '', charges: [], createdAt: now.toISOString(), userId, source };
    applyFields(s, fields, { created: true, now });
    if (fields.merchant) learnAlias(s, fields.merchant);
    datesFor(s, { todayKey: t });
    s.updatedAt = now.toISOString();
    list.push(s);
    return copy(s);
  });
  if (sub) await planAlerts(svc, [sub], { timeZone, now });
  return sub;
}

/**
 * Answer a question about a new charge:
 *   track    save it as a subscription (`cycle` monthly / yearly / weekly)
 *   once     a one-time purchase: forget it, do not ask about this merchant again
 *   unknown  "I don't know this charge": forget the question, the caller shows advice
 * Returns { outcome, sub?, charge } or null when the question is gone (answered already).
 */
export async function resolvePending(svc, pid, action, { cycle, userId, timeZone, now = new Date() } = {}) {
  personal(svc);
  return exclusive(svc, async () => {
    const t = today(now, timeZone);
    const p = await svc.store.update(CHARGES, emptyCharges(), (d) => {
      chargesDoc(d);
      const i = d.pending.findIndex((x) => x.id === pid);
      if (i === -1) return null;
      const [item] = d.pending.splice(i, 1);
      if (action === 'once') d.dismissed[merchantKey(item.charge.merchant)] = now.toISOString();
      trimDoc(d, now);
      return item;
    });
    if (!p) return null;
    if (action !== 'track') return { outcome: action === 'once' ? 'dismissed' : 'unknown', charge: p.charge };
    const c = p.charge;
    const useCycle = CYCLES.includes(cycle) && cycle !== 'unknown' ? cycle : p.cycle || 'monthly';
    const existing = findSubscriptionForCharge(await svc.store.read(SUBS, []), c);
    let sub;
    if (existing && existing.status !== 'cancelled') {
      sub = await svc.store.update(SUBS, [], (list) => {
        const s = list.find((x) => x.id === existing.id);
        if (!s) return null;
        if (c.kind !== 'renewal_notice' && c.amount) applyCharge(s, c, t);
        s.updatedAt = now.toISOString();
        return copy(s);
      });
      if (sub) await planAlerts(svc, [sub], { timeZone, now });
    } else {
      const fields = {
        name: c.service || displayName(c.merchant), merchant: c.merchant, status: 'active', amount: c.amount, currency: c.currency, cycle: useCycle, cardLast4: c.cardLast4,
        ...(c.kind === 'renewal_notice' ? { nextChargeOn: c.on >= t ? c.on : '' } : { lastChargedOn: c.on }),
      };
      sub = await saveNow(svc, fields, { userId, source: 'charge', timeZone, now, t });
      if (sub && c.kind !== 'renewal_notice') {
        sub = await svc.store.update(SUBS, [], (list) => {
          const s = list.find((x) => x.id === sub.id);
          if (!s) return null;
          s.charges = [{ on: c.on, amount: c.amount, currency: c.currency, merchant: c.merchant.slice(0, 60) }];
          return copy(s);
        });
      }
    }
    return { outcome: 'tracked', sub, charge: c };
  });
}

/** Whether a forwarded message was handled before (checked before any AI call). */
export async function isSeen(svc, fp) {
  personal(svc);
  if (!fp) return false;
  const doc = chargesDoc(await svc.store.read(CHARGES, emptyCharges()));
  return Boolean(doc.seen[fp]);
}

/** Remember a forwarded message that held no charge, so a resend costs nothing. */
export async function markSeen(svc, fp, { now = new Date() } = {}) {
  personal(svc);
  if (!fp) return;
  await exclusive(svc, () => svc.store.update(CHARGES, emptyCharges(), (d) => { chargesDoc(d); d.seen[fp] = now.toISOString(); trimDoc(d, now); }));
}

// ---------------------------------------------------------- daily upkeep

const upkeep = new Map(); // tenant id -> local day already done by this process

/**
 * Once a day per person: trials past their end become paid plans (their
 * first charge was the end date) and passed charge dates move to the next
 * one, with alerts re-planned. Returns the number of subscriptions changed.
 */
export async function ensureSubsUpToDate(svc, { timeZone, now = new Date() } = {}) {
  if (!svc?.store || svc.tenant?.type === 'group') return 0;
  const id = svc.tenant?.id ?? '';
  const t = today(now, timeZone);
  if (upkeep.get(id) === t) return 0;
  const n = await exclusive(svc, async () => {
    const changed = await svc.store.update(SUBS, [], (list) => {
      const out = [];
      for (const s of list) {
        const a = advance(s, t);
        if (!a) continue;
        Object.assign(s, a.patch, { updatedAt: now.toISOString() });
        out.push(copy(s));
      }
      return out;
    });
    await planAlerts(svc, changed, { timeZone, now });
    return changed.length;
  });
  upkeep.set(id, t);
  return n;
}

/** Tests: forget which days the upkeep ran. */
export function resetUpkeep() {
  upkeep.clear();
}

/**
 * The subscriptions behind due alerts, still worth sending: the date the
 * alert was planned for is still the subscription's date and it was not
 * cancelled. One entry per subscription (several due at once: the latest).
 */
export async function dueAlerts(svc, due, { timeZone, now = new Date() } = {}) {
  const forSubs = due.filter((r) => r.subId);
  if (!forSubs.length) return [];
  const subs = await svc.store.read(SUBS, []);
  const t = today(now, timeZone);
  const best = new Map();
  for (const r of forSubs) {
    const s = subs.find((x) => x.id === r.subId);
    if (!s || s.status === 'cancelled') continue;
    const on = s.status === 'trial' ? s.trialEndsOn : s.nextChargeOn;
    if (on !== r.on || on < t) continue;
    const prev = best.get(s.id);
    if (!prev || r.offset < prev.offset) best.set(s.id, { sub: copy(s), on, offset: r.offset, kind: r.alertKind || (s.status === 'trial' ? 'trial' : 'renewal'), daysLeft: diffDays(t, on) });
  }
  return [...best.values()].sort((a, b) => a.on.localeCompare(b.on));
}

/** Days until the next date that matters (trial end or next charge), or null. */
export function nextDate(sub) {
  if (sub.status === 'cancelled') return '';
  return (sub.status === 'trial' ? sub.trialEndsOn : sub.nextChargeOn) || '';
}
