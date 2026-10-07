/**
 * Deadline logic that never touches Drive or LINE, so it is easy to test:
 *   - the alert schedule (how many days before a deadline, and at what time)
 *   - whether a new announcement is one we already saved (poster + text of
 *     the same activity should become one record, not two)
 *   - how to fold the new details into the saved record
 *   - the order the deadline list is shown in
 */
import { daysUntil, localDateTimeToUtc } from './opportunities.js';

// ------------------------------------------------------------------ alerts

/** 7, 3 and 1 days before, plus the deadline day itself, at 09:00. */
export const DEFAULT_ALERTS = Object.freeze({ days: Object.freeze([7, 3, 1, 0]), time: '09:00' });

export const ALERT_PRESETS = Object.freeze([
  { key: 'std', days: [7, 3, 1, 0] },
  { key: 'early', days: [14, 7, 3, 1, 0] },
  { key: 'light', days: [3, 1, 0] },
]);

export const ALERT_TIMES = Object.freeze(['08:00', '12:00', '20:00']);

const MAX_DAYS_BEFORE = 60;
const MAX_ALERTS = 8;

/** Unique whole days 0..60, largest first, at most 8. 0 = the deadline day. */
export function normalizeDays(days) {
  const list = (Array.isArray(days) ? days : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= MAX_DAYS_BEFORE);
  return [...new Set(list)].sort((a, b) => b - a).slice(0, MAX_ALERTS);
}

/** "9:5" is rejected, "9.00" / "09:00" -> "09:00". Returns null when invalid. */
export function normalizeTime(t) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(t ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/**
 * Settings as stored -> usable settings. Missing days mean the default; an
 * explicit empty list means alerts are switched off.
 */
export function normalizeAlerts(a) {
  const days = Array.isArray(a?.days) ? normalizeDays(a.days) : [...DEFAULT_ALERTS.days];
  return { days, time: normalizeTime(a?.time) || DEFAULT_ALERTS.time };
}

export function alertLabel(offset) {
  if (offset === 0) return 'วันนี้วันสุดท้าย';
  if (offset === 1) return 'พรุ่งนี้วันสุดท้าย';
  if (offset === 7) return 'อีก 1 สัปดาห์จะปิดรับ';
  if (offset === 14) return 'อีก 2 สัปดาห์จะปิดรับ';
  return `อีก ${offset} วันจะปิดรับ`;
}

/**
 * When to alert for a deadline (YYYY-MM-DD), soonest first, future only.
 * Returns [{ at: UTC ISO, offset: days before, label }].
 */
export function alertTimes(deadlineIso, alerts, timeZone, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadlineIso || '')) return [];
  const { days, time } = normalizeAlerts(alerts);
  const [hh, mm] = time.split(':').map(Number);
  const [y, m, d] = deadlineIso.split('-').map(Number);
  return days
    .map((offset) => {
      const day = new Date(Date.UTC(y, m - 1, d - offset)).toISOString().slice(0, 10);
      return { at: localDateTimeToUtc(day, hh, mm, timeZone), offset, label: alertLabel(offset) };
    })
    .filter((t) => new Date(t.at) > now);
}

/** The schedule one item uses: its own days when set, else the chat's. */
export function alertsFor(opp, settings) {
  const base = normalizeAlerts(settings);
  return Array.isArray(opp?.alertDays) ? { days: normalizeDays(opp.alertDays), time: base.time } : base;
}

/** "ก่อน 7 · 3 · 1 วัน + วันสุดท้าย" */
export function describeAlertDays(days) {
  const d = normalizeDays(days);
  if (d.length === 0) return 'ไม่เตือน';
  const before = d.filter((x) => x > 0);
  const parts = [];
  if (before.length) parts.push(`ก่อน ${before.join(' · ')} วัน`);
  if (d.includes(0)) parts.push('วันสุดท้าย');
  return parts.join(' + ');
}

/** "ก่อน 7 · 3 · 1 วัน + วันสุดท้าย เวลา 09:00 น." */
export function describeAlerts(alerts) {
  const a = normalizeAlerts(alerts);
  if (a.days.length === 0) return 'ปิดการเตือน deadline อยู่';
  return `${describeAlertDays(a.days)} เวลา ${a.time} น.`;
}

/**
 * Typed command, no AI needed:
 *   "เตือน deadline ก่อน 10 5 2 1 วัน 20:00"
 *   "ตั้งเตือนเดดไลน์ 14,7,3,1,0"   "เตือน deadline ก่อน 2 สัปดาห์ และวันสุดท้าย"
 *   "เตือน deadline เวลา 20.00"      "ปิดเตือน deadline"
 * Returns { days?, time?, off? } or null when the text is not this command.
 */
export function parseAlertCommand(text) {
  const t = String(text || '').trim();
  if (/^(?:ปิด|หยุด)(?:การ)?เตือน\s*(?:deadline|เดดไลน์|เดทไลน์|เดตไลน์)/i.test(t)) return { off: true };
  const m = /^(?:ตั้ง)?(?:การ)?เตือน\s*(?:deadline|เดดไลน์|เดทไลน์|เดตไลน์)\s*(.*)$/is.exec(t);
  if (!m) return null;
  let rest = m[1];
  const out = {};
  const tm = /(\d{1,2})[:.](\d{2})/.exec(rest);
  if (tm) {
    out.time = normalizeTime(`${tm[1]}:${tm[2]}`);
    rest = rest.replace(tm[0], ' ');
    if (!out.time) return null;
  }
  const days = [];
  rest = rest.replace(/(\d+)\s*(?:สัปดาห์|อาทิตย์|weeks?|wk)/gi, (_, n) => {
    days.push(Number(n) * 7);
    return ' ';
  });
  for (const n of rest.match(/\d+/g) || []) days.push(Number(n));
  if (/วันสุดท้าย|วันปิด|วันหมดเขต|วันนั้น/.test(rest)) days.push(0);
  if (days.length) {
    const norm = normalizeDays(days);
    if (norm.length === 0) return null;
    out.days = norm;
  }
  return out.days || out.time ? out : null;
}

// ---------------------------------------------------------------- matching

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'in', 'on', 'to', 'at', 'by', 'with', 'call',
  'program', 'programme', 'programs', 'programmes', 'project', 'open', 'opening',
  'application', 'applications', 'apply', 'registration', 'register', 'announcement',
]);
const THAI_FILLERS = /โครงการ|เปิดรับสมัคร|รับสมัคร|ประกาศ|ขอเชิญ|ประจำปี/g;

/**
 * Lowercase, no punctuation, no filler words like "programme" / "โครงการ",
 * and Thai-calendar years (2569) written as Gregorian (2026).
 */
export function normTitle(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(THAI_FILLERS, ' ')
    .replace(/\d+/g, (n) => {
      const v = Number(n);
      return n.length === 4 && v >= 2400 && v <= 2700 ? String(v - 543) : n;
    })
    .replace(/[^\p{L}\p{N}\p{M}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .join(' ');
}

function numbersIn(s) {
  return new Set(String(s).match(/\d+/g) || []);
}

function bigrams(s) {
  const counts = new Map();
  for (const word of s.split(' ')) {
    for (let i = 0; i < word.length - 1; i++) {
      const g = word.slice(i, i + 2);
      counts.set(g, (counts.get(g) || 0) + 1);
    }
  }
  return counts;
}

/**
 * 0..1 similarity of two titles (Dice coefficient over letter pairs, which
 * works for Thai text without spaces too). One title containing the other
 * counts as very similar; different numbers ("Round 1" vs "Round 2",
 * "2026" vs "2027") count as different.
 */
export function titleSimilarity(a, b) {
  const A = normTitle(a);
  const B = normTitle(b);
  if (!A || !B) return 0;
  const na = numbersIn(A);
  const nb = numbersIn(B);
  const numbersClash = na.size > 0 && nb.size > 0 && ![...na].some((n) => nb.has(n));
  let score;
  if (A === B) score = 1;
  else {
    const ga = bigrams(A);
    const gb = bigrams(B);
    let inter = 0;
    let total = 0;
    for (const v of ga.values()) total += v;
    for (const v of gb.values()) total += v;
    for (const [g, v] of ga) inter += Math.min(v, gb.get(g) || 0);
    score = total ? (2 * inter) / total : 0;
    const flatA = A.replace(/\s/g, '');
    const flatB = B.replace(/\s/g, '');
    const [short, long] = flatA.length <= flatB.length ? [flatA, flatB] : [flatB, flatA];
    if (short.length >= 6 && long.includes(short)) score = Math.max(score, 0.85);
  }
  return numbersClash ? Math.min(score, 0.3) : score;
}

/** host + path + meaningful query, without www., trailing slash or tracking params. */
export function normalizeUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    if (!/^https?:$/.test(x.protocol)) return '';
    const host = x.hostname.replace(/^www\./, '').toLowerCase();
    const path = x.pathname.replace(/\/+$/, '');
    const params = [...x.searchParams]
      .filter(([k]) => !/^(utm_.*|fbclid|gclid|igshid|si|ref)$/i.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const q = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return host + path + q;
  } catch {
    return '';
  }
}

/** Same page, and not just a site's home page (one site can host many calls). */
export function sameSpecificUrl(a, b) {
  const x = normalizeUrl(a);
  const y = normalizeUrl(b);
  return Boolean(x) && x === y && /[/?]/.test(x);
}

/** Saved items a new announcement could be a repeat of. */
export function isActiveOpportunity(o, timeZone, now = new Date()) {
  if (o.deadline && daysUntil(o.deadline, timeZone, now) < -7) return false;
  const t = Date.parse(o.updatedAt || o.createdAt || '');
  if (!o.deadline && Number.isFinite(t) && now.getTime() - t > 180 * 86_400_000) return false;
  return true;
}

/** Most recently touched active items, for the model to compare against. */
export function oppCandidates(list, timeZone, now = new Date(), limit = 25) {
  const stamp = (o) => String(o.updatedAt || o.createdAt || '');
  return list
    .filter((o) => isActiveOpportunity(o, timeZone, now))
    .sort((a, b) => stamp(b).localeCompare(stamp(a)))
    .slice(0, limit);
}

/** "id | title | deadline | organizer" lines for a prompt. */
export function candidateLines(cands) {
  return cands.map((o) => `${o.id} | ${o.title} | ${o.deadline || '-'} | ${o.organizer || '-'}`).join('\n');
}

const RECENT_MS = 45 * 60 * 1000;

/**
 * Decide whether `fields` (a freshly read announcement) is an item already in
 * `list`. Returns { match, suggestion }:
 *   match      - { opp, reason } to merge into automatically, or null
 *   suggestion - { opp } worth offering as "same as this one? merge" when we
 *                are not sure enough to merge on our own, or null
 *
 * `sameAs` is the model's own judgement (it saw the saved list); `aiChecked`
 * says the model was asked, so weak guesses should not overrule a "no".
 */
export function findDuplicate(list, fields, { sameAs = '', userId, timeZone, now = new Date(), aiChecked = false } = {}) {
  const active = list.filter((o) => isActiveOpportunity(o, timeZone, now));
  if (sameAs) {
    const opp = list.find((o) => o.id === sameAs);
    if (opp) return { match: { opp, reason: 'ai' }, suggestion: null };
  }
  let best = null;
  let bestSuggestion = null;
  for (const o of active) {
    const sim = titleSimilarity(o.title, fields.title);
    const dlA = o.deadline || '';
    const dlB = fields.deadline || '';
    const compatible = !dlA || !dlB || dlA === dlB;
    const sameDeadline = Boolean(dlA) && dlA === dlB;
    const sameLink = [o.link, ...(o.links || [])].some((l) => sameSpecificUrl(l, fields.link));
    const age = now.getTime() - Date.parse(o.updatedAt || o.createdAt || 0);
    const recent = age >= -60_000 && age <= RECENT_MS && (!userId || !o.userId || o.userId === userId);

    let score = 0;
    let reason = '';
    if (sameLink && (compatible || sim >= 0.5)) { score = 3 + sim; reason = 'link'; }
    else if (compatible && sim >= 0.8) { score = 2 + sim; reason = 'title'; }
    else if (!aiChecked && recent && compatible && (sim >= 0.45 || (sameDeadline && sim >= 0.3))) { score = 1 + sim; reason = 'recent'; }
    if (score && (!best || score > best.score)) best = { opp: o, reason, score };

    if (!score && recent && compatible && (sim >= 0.3 || sameDeadline)) {
      if (!bestSuggestion || sim > bestSuggestion.sim) bestSuggestion = { opp: o, sim };
    }
  }
  if (best) return { match: { opp: best.opp, reason: best.reason }, suggestion: null };
  return { match: null, suggestion: bestSuggestion ? { opp: bestSuggestion.opp } : null };
}

// ------------------------------------------------------------------ merging

const FIELD_LABELS = {
  organizer: 'ผู้จัด', summary: 'รายละเอียด', deadline_note: 'เวลาปิดรับ', event_dates: 'วันจัด',
  eligibility: 'คุณสมบัติ', cost: 'ค่าใช้จ่าย/รางวัล', contact: 'ช่องทางติดต่อ', link: 'ลิงก์',
  deadline: 'วันหมดเขต', poster: 'โปสเตอร์',
};

export function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const k = normalizeUrl(u);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(String(u).trim());
  }
  return out;
}

export function sameSource(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.fileId || b.fileId) return a.fileId === b.fileId;
  if (a.url || b.url) return normalizeUrl(a.url) === normalizeUrl(b.url);
  return true; // two plain-text sources
}

const isVisual = (s) => s?.kind === 'image' || s?.kind === 'pdf';

/**
 * Fold a new reading of the same activity into the saved record.
 * Empty fields are filled; a longer, more detailed value replaces a shorter
 * one; contacts are combined; a poster is attached when the record had none.
 * When the two deadlines disagree the earlier one is kept, so no alert is
 * ever late. Returns { patch, added: [Thai field labels], deadlineChanged,
 * otherDeadline: the date that was not used, or '' }.
 */
export function mergeOpportunity(existing, fields, source, { now = new Date() } = {}) {
  const patch = {};
  const added = [];
  for (const k of ['organizer', 'summary', 'deadline_note', 'event_dates', 'eligibility', 'cost', 'contact']) {
    const a = String(existing[k] || '').trim();
    const b = String(fields[k] || '').trim();
    if (!b || a === b) continue;
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    if (!a || bl.includes(al)) { patch[k] = b; added.push(FIELD_LABELS[k]); continue; }
    if (al.includes(bl)) continue;
    if (k === 'contact') { patch[k] = `${a} · ${b}`; added.push(FIELD_LABELS[k]); continue; }
    if (b.length > a.length * 1.2) { patch[k] = b; added.push(FIELD_LABELS[k]); }
  }

  const newTitle = String(fields.title || '').trim();
  if (newTitle && newTitle !== existing.title) {
    if (!existing.title || existing.title === 'ไม่มีชื่อ') patch.title = newTitle;
    else if (newTitle.length <= 90 && newTitle.length > existing.title.length
      && normTitle(newTitle).includes(normTitle(existing.title))) patch.title = newTitle;
  }
  if ((!existing.kind || existing.kind === 'other') && fields.kind && fields.kind !== 'other') patch.kind = fields.kind;

  if (!existing.link && fields.link) { patch.link = String(fields.link).trim(); added.push(FIELD_LABELS.link); }
  const links = uniqueUrls([existing.link, ...(existing.links || []), fields.link]);
  if (links.length > 1 && links.length !== (existing.links || []).length) patch.links = links;

  let deadlineChanged = false;
  let otherDeadline = '';
  const da = existing.deadline || '';
  const db = fields.deadline || '';
  if (!da && db) {
    patch.deadline = db;
    deadlineChanged = true;
    added.push(FIELD_LABELS.deadline);
  } else if (da && db && da !== db) {
    if (db < da) {
      patch.deadline = db;
      deadlineChanged = true;
      otherDeadline = da;
    } else {
      otherDeadline = db;
    }
  }

  const sources = existing.sources ? [...existing.sources] : (existing.source ? [existing.source] : []);
  if (source && !sources.some((s) => sameSource(s, source))) {
    sources.push(source);
    patch.sources = sources;
  }
  if (isVisual(source) && !isVisual(existing.source)) {
    patch.source = source;
    added.push(FIELD_LABELS.poster);
  }

  patch.confidence = Math.max(Number(existing.confidence) || 0, Number(fields.confidence) || 0);
  patch.updatedAt = now.toISOString();
  patch.mergeCount = (existing.mergeCount || 0) + 1;
  return { patch, added, deadlineChanged, otherDeadline };
}

// -------------------------------------------------------------------- list

/**
 * Groups for the deadline list: still open (soonest first), no date given,
 * already applied, and recently closed (most recent first, a few only).
 */
export function groupForList(list, timeZone, now = new Date(), { pastDays = 7, maxPast = 3 } = {}) {
  const items = list.map((o) => ({ o, days: o.deadline ? daysUntil(o.deadline, timeZone, now) : null }));
  const isApplied = (x) => x.o.status === 'applied';
  const open = (x) => x.days === null || x.days >= 0;
  const byDays = (a, b) => (a.days ?? 1e9) - (b.days ?? 1e9);
  const upcoming = items.filter((x) => !isApplied(x) && x.days !== null && x.days >= 0).sort(byDays);
  const undated = items.filter((x) => !isApplied(x) && x.days === null);
  const applied = items.filter((x) => isApplied(x) && open(x)).sort(byDays);
  const pastAll = items.filter((x) => x.days !== null && x.days < 0).sort((a, b) => b.days - a.days);
  const past = pastAll.filter((x) => x.days >= -pastDays).slice(0, maxPast);
  const pick = (arr) => arr.map((x) => x.o);
  return {
    upcoming: pick(upcoming),
    undated: pick(undated),
    applied: pick(applied),
    past: pick(past),
    hiddenPast: pastAll.length - past.length,
  };
}
