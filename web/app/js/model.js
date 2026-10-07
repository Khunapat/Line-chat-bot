// What the screens say about reminders and deadlines. Pure functions of the
// data from /api/app plus the translator, so every screen words things the
// same way.

import { formatDay, formatTime, formatDateTime, zoned, parseKey, WEEKDAY_NAMES } from '../../shared/dates.js';
import { upcoming, anchorOf, needsMonthEndNote } from '../../shared/recurrence.js';

// ----------------------------------------------------------------- deadlines

export function deadlineTone(item) {
  if (item.daysLeft === null || item.daysLeft === undefined) return 'nodate';
  if (item.daysLeft < 0) return 'closed';
  if (item.daysLeft <= 3) return 'urgent';
  if (item.daysLeft <= 7) return 'soon';
  return 'later';
}

export function bucket(item) {
  if (item.status === 'applied') return 'applied';
  return deadlineTone(item) === 'closed' ? 'closed' : 'open';
}

export function countdown(item, T) {
  if (item.status === 'applied') return T('appliedState');
  const n = item.daysLeft;
  if (n === null || n === undefined) return T('cdNoDate');
  if (n < 0) return T('cdClosed', { n: -n });
  if (n === 0) return T('cdToday');
  if (n === 1) return T('cdTomorrow');
  return T('cdDays', { n });
}

/** The organiser's note is shown as written; a date-only item says "no time given". */
export function noteText(item, T) {
  const n = String(item.deadlineNote || '').trim();
  if (/^\d{1,2}[:.]\d{2}/.test(n)) return T('orgNote', { note: n });
  return n ? `${T('noTime')} · ${n}` : T('noTime');
}

export function kindName(kind, T) {
  return T(`kind_${kind || 'other'}`);
}

export function sourceName(item, T) {
  const k = item.source?.kind || 'text';
  return T(`src_${['pdf', 'image', 'link', 'text'].includes(k) ? k : 'text'}`);
}

export function stubOf(item, lang, T) {
  const tone = item.status === 'applied' ? 'applied' : deadlineTone(item);
  if (!item.deadline) return { tone: 'nodate', dd: '?', mm: T('stubNoDate') };
  return { tone, dd: String(parseKey(item.deadline).d), mm: formatDay(item.deadline, lang, 'dmy').split(' ').slice(1).join(' ') };
}

export function sortDeadlines(list) {
  const order = { urgent: 0, soon: 1, later: 2, nodate: 3, closed: 4 };
  const b = { open: 0, applied: 1, closed: 2 };
  return [...list].sort((x, y) => (b[bucket(x)] - b[bucket(y)])
    || (order[deadlineTone(x)] - order[deadlineTone(y)])
    || ((x.deadline || '9') < (y.deadline || '9') ? -1 : (x.deadline || '9') > (y.deadline || '9') ? 1 : 0));
}

export function alertChip(alerts, lang, T) {
  const days = (alerts?.days || []).filter((d) => d > 0);
  const time = formatTime(alerts?.time || '09:00', lang);
  if (!alerts?.days?.length) return T('alertsOffChip');
  if (!days.length) return T('alertsChipDayOnly', { time });
  return T('alertsChip', { days: days.join('·'), time });
}

export function offsetLabel(n, T) {
  return n === 0 ? T('alertClosingDay') : T('alertDayBefore', { n });
}

// ----------------------------------------------------------------- reminders

/** "ทุกวันพุธ เวลา 09:00 น." / "Every Wednesday at 09:00" / "ครั้งเดียว · …" */
export function repeatSummary(r, { lang, T, tz }) {
  const z = zoned(r.at, tz);
  const time = formatTime(z.hm, lang);
  const p = parseKey(z.key);
  const anchor = anchorOf(r, tz);
  switch (r.repeat) {
    case 'daily': return T('everyDayAt', { time });
    case 'weekly': return T('everyWeekAt', { wd: WEEKDAY_NAMES[lang === 'en' ? 'en' : 'th'][new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()], time });
    case 'monthly': return T('everyMonthAt', { d: anchor, time });
    case 'yearly': return T('everyYearAt', { dm: `${anchor} ${formatDay(z.key, lang, 'mon')}`, time });
    default: return T('onceAt', { when: formatDateTime(r.at, lang, tz) });
  }
}

/** Short repeat name for agenda rows: "ทุกวัน". */
export function repeatShort(r, T) {
  return r.repeat && r.repeat !== 'none' ? T(r.repeat) : '';
}

export function nextLine(r, { lang, T, tz, now }) {
  if (!r.repeat || r.repeat === 'none') return '';
  const next = upcoming(r, 3, { timeZone: tz, now });
  if (!next.length) return '';
  return T('nextLine', { list: next.map((iso) => { const z = zoned(iso, tz); return `${formatDay(z.key, lang, 'dm')} ${formatTime(z.hm, lang)}`; }).join(' · ') });
}

export function monthEndNote(r, { T, tz }) {
  const anchor = anchorOf(r, tz);
  const month = parseKey(zoned(r.at, tz).key).m;
  if (!needsMonthEndNote(r.repeat, anchor, month)) return '';
  return r.repeat === 'yearly' ? T('leapNote') : T('monthEndNote', { d: anchor });
}

/** upcoming (one-off, not sent) / repeat / done (sent in the last 24 h). */
export function categorize(list, now) {
  const out = { upcoming: [], repeat: [], done: [] };
  for (const r of list) {
    if (r.firedAt) out.done.push(r);
    else if (r.repeat && r.repeat !== 'none') out.repeat.push(r);
    else if (new Date(r.at) > now) out.upcoming.push(r);
    else out.done.push(r);
  }
  const byAt = (a, b) => a.at.localeCompare(b.at);
  out.upcoming.sort(byAt);
  out.repeat.sort(byAt);
  out.done.sort((a, b) => (b.firedAt || b.at).localeCompare(a.firedAt || a.at));
  return out;
}

/** Greeting by the hour in the tenant's zone. */
export function greeting(name, { T, tz, now }) {
  const h = Number(zoned(now, tz).hm.slice(0, 2));
  if (!name) return T('greetNoName');
  if (h < 12) return T('greetMorning', { name });
  if (h < 17) return T('greetAfternoon', { name });
  return T('greetEvening', { name });
}

export function fileKindName(kind, T) {
  return T({ image: 'ftImage', pdf: 'ftPdf', doc: 'ftDoc', sheet: 'ftSheet', video: 'ftVideo', audio: 'ftAudio' }[kind] || 'ftFile');
}

export function fileIconName(kind) {
  return { image: 'gallery', pdf: 'pdf', doc: 'doc', sheet: 'doc', video: 'video', audio: 'audio' }[kind] || 'clip';
}
