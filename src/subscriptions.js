/**
 * Subscriptions and free trials: pure logic, no I/O.
 *
 * A charge seen on the card ("NETFLIX.COM 419.00", "OPENAI *CHATGPT SUBSCR",
 * "SPOTIFY P1A2B3") is matched to a saved subscription by name tokens and
 * learned descriptors, with the amount as a tie-breaker. Dates are day keys
 * (YYYY-MM-DD) in the tenant's zone; monthly / yearly charges keep the day
 * they started on (`anchorDay`), using the month's last day when it is short.
 *
 * Subscription:
 *   { id, name, aliases: [], amount, currency, cycle: monthly|yearly|weekly|unknown,
 *     status: trial|active|cancelled, trialEndsOn, nextChargeOn, anchorDay,
 *     cardLast4, remind, note, lastChargedOn, charges: [{ on, amount, currency, merchant, source }],
 *     createdAt, updatedAt, cancelledAt, userId, source }
 */
import { addDays, parseKey, makeKey, daysInMonth, diffDays, zonedToUtc, isDayKey } from '../web/shared/dates.js';

export const STATUSES = ['trial', 'active', 'cancelled'];
export const CYCLES = ['monthly', 'yearly', 'weekly', 'unknown'];

// Words that say nothing about which service it is.
const GENERIC = new Set([
  'plus', 'premium', 'pro', 'basic', 'standard', 'family', 'individual', 'student', 'duo', 'monthly', 'annual', 'yearly',
  'plan', 'subscription', 'subscr', 'subs', 'app', 'apps', 'the', 'service', 'services', 'online', 'membership', 'member',
  'account', 'com', 'www', 'net', 'org', 'bill', 'billing', 'payment', 'payments', 'inc', 'llc', 'ltd', 'co', 'corp',
  'company', 'limited', 'store', 'digital', 'intl', 'international', 'thailand', 'bangkok', 'th', 'thb', 'usd', 'and', 'one',
]);

// Brands that bill many different products under one name ("GOOGLE *...",
// "APPLE.COM/BILL"). A hit on these alone needs the amount to agree too.
const FAMILIES = new Set(['google', 'apple', 'microsoft', 'amazon', 'paypal', 'line', 'true', 'ais', 'dtac', 'samsung']);

// Services people usually pay for every month or year. A charge from one of
// these that is not in the list yet is worth asking about.
export const KNOWN_SERVICES = [
  'netflix', 'spotify', 'youtube', 'googleone', 'googleplay', 'gsuite', 'workspace', 'apple', 'icloud', 'itunes', 'appstore',
  'openai', 'chatgpt', 'anthropic', 'claude', 'perplexity', 'midjourney', 'cursor', 'copilot', 'github', 'adobe', 'microsoft',
  'office', 'xbox', 'playstation', 'nintendo', 'steam', 'canva', 'notion', 'dropbox', 'figma', 'evernote', 'grammarly', 'zoom',
  'slack', 'duolingo', 'amazonprime', 'primevideo', 'disney', 'hotstar', 'hbomax', 'viu', 'wetv', 'iqiyi', 'trueid', 'monomax',
  'bilibili', 'joox', 'linemusic', 'linetv', 'patreon', 'twitch', 'discord', 'medium', 'substack', 'nordvpn', 'expressvpn',
  'surfshark', 'onepassword', 'bitwarden', 'tinder', 'bumble', 'strava', 'headspace', 'calm', 'audible', 'kindle', 'scribd',
];

/** Lower-case word tokens of a merchant descriptor or name (Thai letters kept). */
export function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .split(/[^a-z0-9฀-๿]+/)
    .filter(Boolean);
}

/** Letters and digits only: "Netflix.com" -> "netflixcom". */
export function compact(s) {
  return tokens(s).join('');
}

/**
 * A stable key for "the same merchant": the tokens without digits, so the
 * random suffix some card descriptors carry ("SPOTIFY P1A2B3") drops out.
 */
export function merchantKey(s) {
  return tokens(s).filter((t) => !/\d/.test(t)).join('');
}

/** Distinctive keys of a subscription: its compact name, its non-generic words, learned descriptors. */
export function subKeys(sub) {
  const words = tokens(sub.name).filter((t) => t.length >= 3 && !GENERIC.has(t));
  const keys = new Set([compact(sub.name), ...words, ...(sub.aliases || [])]);
  keys.delete('');
  return [...keys].filter((k) => k.length >= 3);
}

function tokenHit(token, key) {
  if (token === key) return true;
  if (key.length >= 4 && token.startsWith(key)) return true; // "youtubepremium" ~ "youtube"
  if (token.length >= 5 && key.startsWith(token)) return true; // "youtube" ~ "youtubepremium"
  return false;
}

/**
 * How a descriptor ("GOOGLE *YouTubePremium") names a subscription:
 * 'strong' (its own name or a learned descriptor), 'weak' (only a billing
 * brand such as GOOGLE or APPLE.COM), or null.
 */
export function nameMatches(sub, descriptor) {
  const keys = subKeys(sub);
  const toks = tokens(descriptor);
  const whole = compact(descriptor);
  const mkey = merchantKey(descriptor);
  if ((sub.aliases || []).some((a) => a === whole || a === mkey)) return 'strong';
  let weak = false;
  for (const t of toks) {
    if (GENERIC.has(t) || !keys.some((k) => tokenHit(t, k))) continue;
    if (!FAMILIES.has(t)) return 'strong';
    weak = true;
  }
  return weak ? 'weak' : null;
}

export function looksLikeKnownService(descriptor) {
  return tokens(descriptor).some((t) => KNOWN_SERVICES.some((k) => tokenHit(t, k)));
}

/** Same amount, near it (price change / rounding), or not comparable. */
export function amountRelation(a, b, currencyA, currencyB) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0) || (currencyA || 'THB') !== (currencyB || 'THB')) return 'unknown';
  const diff = Math.abs(x - y) / Math.max(x, y);
  if (diff <= 0.01) return 'same';
  if (diff <= 0.15) return 'near';
  return 'far';
}

/**
 * The saved subscription a charge belongs to, or null. `charge` is
 * { merchant, service, amount, currency, cardLast4 }.
 */
export function findSubscriptionForCharge(subs, charge) {
  let best = null;
  let bestScore = -Infinity;
  for (const sub of subs) {
    const hits = [nameMatches(sub, charge.merchant), charge.service ? nameMatches(sub, charge.service) : null];
    const hit = hits.includes('strong') ? 'strong' : hits.includes('weak') ? 'weak' : null;
    if (!hit) continue;
    const rel = amountRelation(sub.amount, charge.amount, sub.currency, charge.currency);
    // "APPLE.COM/BILL 35.00" is not the ฿99 iCloud plan just because both are Apple.
    if (hit === 'weak' && rel !== 'same' && rel !== 'near') continue;
    let score = hit === 'strong' ? 1 : 0.6;
    if (rel === 'same') score += 0.7;
    else if (rel === 'near') score += 0.4;
    else if (rel === 'far') score -= 0.3;
    if (sub.cardLast4 && charge.cardLast4 && !sub.cardLast4.endsWith(charge.cardLast4) && !charge.cardLast4.endsWith(sub.cardLast4)) score -= 0.4;
    if (sub.status !== 'cancelled') score += 0.05;
    if (score > bestScore) { best = sub; bestScore = score; }
  }
  return best;
}

// ------------------------------------------------------------------ dates

/** The charge one cycle after `key`; the anchor day survives short months. */
export function addCycle(key, cycle, anchorDay) {
  if (!isDayKey(key || '')) return '';
  if (cycle === 'weekly') return addDays(key, 7);
  const p = parseKey(key);
  const anchor = anchorDay || p.d;
  if (cycle === 'monthly') {
    let y = p.y;
    let m = p.m + 1;
    if (m > 12) { m = 1; y += 1; }
    return makeKey(y, m, Math.min(anchor, daysInMonth(y, m)));
  }
  if (cycle === 'yearly') return makeKey(p.y + 1, p.m, Math.min(anchor, daysInMonth(p.y + 1, p.m)));
  return '';
}

/** First charge date on or after `today`, stepping by cycle (unknown cycles stay put). */
export function rollForward(key, cycle, anchorDay, today) {
  let d = key;
  for (let i = 0; d && d < today && i < 1000; i++) {
    const next = addCycle(d, cycle, anchorDay);
    if (!next) break;
    d = next;
  }
  return d;
}

/** Charge dates of a subscription between from and to (inclusive), for the planner. */
export function chargeDatesBetween(sub, from, to) {
  if (sub.status === 'cancelled') return [];
  const out = [];
  if (sub.status === 'trial') {
    if (sub.trialEndsOn && sub.trialEndsOn >= from && sub.trialEndsOn <= to) out.push({ on: sub.trialEndsOn, kind: 'trial_end' });
    return out;
  }
  let d = sub.nextChargeOn;
  for (let i = 0; d && d <= to && i < 400; i++) {
    if (d >= from) out.push({ on: d, kind: 'charge' });
    const next = addCycle(d, sub.cycle, sub.anchorDay);
    if (!next) break;
    d = next;
  }
  return out;
}

export function defaultRemind(status, cycle) {
  return status === 'trial' || cycle === 'yearly';
}

/** Days before the date to remind: trials 2 / 1 / day itself; yearly 7 / 1; others 1. */
export function alertOffsets(sub) {
  if (sub.status === 'cancelled' || !sub.remind) return [];
  if (sub.status === 'trial') return sub.trialEndsOn ? [2, 1, 0] : [];
  if (!sub.nextChargeOn) return [];
  return sub.cycle === 'yearly' ? [7, 1] : [1];
}

/** Future alerts for a subscription: [{ at (UTC ISO), offset, on, kind: trial|renewal }]. */
export function planSubAlerts(sub, { time = '09:00', timeZone = 'Asia/Bangkok', now = new Date() } = {}) {
  const on = sub.status === 'trial' ? sub.trialEndsOn : sub.nextChargeOn;
  if (!isDayKey(on || '')) return [];
  const kind = sub.status === 'trial' ? 'trial' : 'renewal';
  return alertOffsets(sub)
    .map((offset) => ({ offset, on, kind, at: zonedToUtc(addDays(on, -offset), time, timeZone) }))
    .filter((a) => new Date(a.at) > now);
}

/**
 * Keep dates current without any charge being reported: a trial past its
 * end becomes active (its first charge was the end date), and a passed
 * charge date moves to the next one. Returns { patch, trialEnded } or null.
 */
export function advance(sub, today) {
  if (sub.status === 'cancelled') return null;
  if (sub.status === 'trial') {
    if (!sub.trialEndsOn || sub.trialEndsOn >= today) return null;
    const anchorDay = sub.anchorDay || parseKey(sub.trialEndsOn).d;
    const next = sub.cycle === 'unknown' ? '' : rollForward(sub.trialEndsOn, sub.cycle, anchorDay, today);
    return { patch: { status: 'active', nextChargeOn: next, anchorDay, remind: defaultRemind('active', sub.cycle), trialEndedOn: sub.trialEndsOn }, trialEnded: true };
  }
  if (sub.nextChargeOn && sub.nextChargeOn < today && sub.cycle !== 'unknown') {
    return { patch: { nextChargeOn: rollForward(sub.nextChargeOn, sub.cycle, sub.anchorDay, today) }, trialEnded: false };
  }
  return null;
}

// ------------------------------------------------------------- history

/**
 * Same merchant and amount seen about a cycle earlier? Returns 'monthly',
 * 'yearly', 'weekly' or ''. `history` is [{ key, amount, currency, on }].
 */
export function detectRecurring(history, charge) {
  const key = merchantKey(charge.merchant);
  if (!key || !isDayKey(charge.on || '')) return '';
  for (const h of history) {
    if (h.key !== key || h.on === charge.on) continue;
    const rel = amountRelation(h.amount, charge.amount, h.currency, charge.currency);
    if (rel !== 'same' && rel !== 'near') continue;
    const gap = Math.abs(diffDays(h.on, charge.on));
    if (gap >= 26 && gap <= 35) return 'monthly';
    if (gap >= 355 && gap <= 375) return 'yearly';
    if (gap >= 6 && gap <= 8) return 'weekly';
  }
  return '';
}

/** Days until a date (negative when past), or null. */
export function daysUntilKey(on, today) {
  return isDayKey(on || '') ? diffDays(today, on) : null;
}

/** Rough monthly total per currency of what is being paid (trials are free until they end). */
export function monthlyTotals(subs) {
  const totals = {};
  for (const s of subs) {
    if (s.status !== 'active' || !(s.amount > 0)) continue;
    const per = { monthly: 1, yearly: 1 / 12, weekly: 52 / 12 }[s.cycle];
    if (!per) continue;
    const c = s.currency || 'THB';
    totals[c] = Math.round(((totals[c] || 0) + s.amount * per) * 100) / 100;
  }
  return totals;
}
