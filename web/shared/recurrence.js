/**
 * Reminder repeats, computed on the wall clock of the reminder's time zone
 * so "every month on the 1st at 05:00" stays on the 1st in Bangkok (doing
 * the maths in UTC would land on the 30th or 31st).
 *
 * Monthly and yearly repeats remember the day they were set for
 * (`anchorDay`). A month without that day (31 in April, 29 Feb in most
 * years) uses its last day instead, and the next month goes back to the
 * anchor. Shared by the server (firing) and the web app (previews), so the
 * two always agree.
 */
import { zoned, zonedToUtc, parseKey, makeKey, addDays, daysInMonth, DEFAULT_TZ } from './dates.js';

export const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

export function anchorOf(reminder, timeZone = DEFAULT_TZ) {
  const a = Number(reminder.anchorDay);
  if (Number.isInteger(a) && a >= 1 && a <= 31) return a;
  return parseKey(zoned(reminder.at, timeZone).key).d;
}

/** The occurrence after `atIso`, or null for one-off reminders. */
export function nextOccurrence(atIso, repeat, { timeZone = DEFAULT_TZ, anchorDay } = {}) {
  if (!REPEATS.includes(repeat) || repeat === 'none') return null;
  const z = zoned(atIso, timeZone);
  let key;
  if (repeat === 'daily') key = addDays(z.key, 1);
  else if (repeat === 'weekly') key = addDays(z.key, 7);
  else {
    const p = parseKey(z.key);
    const anchor = anchorDay || p.d;
    let y = p.y;
    let m = p.m;
    if (repeat === 'monthly') { m += 1; if (m > 12) { m = 1; y += 1; } } else y += 1;
    key = makeKey(y, m, Math.min(anchor, daysInMonth(y, m)));
  }
  return zonedToUtc(key, z.hm, timeZone);
}

/** The next `n` times a reminder fires after `now` (its own time included). */
export function upcoming(reminder, n = 3, { timeZone = DEFAULT_TZ, now = new Date() } = {}) {
  const out = [];
  const anchorDay = anchorOf(reminder, timeZone);
  let at = reminder.at;
  for (let i = 0; i < 1000 && out.length < n && at; i++) {
    if (new Date(at) > now) out.push(at);
    at = nextOccurrence(at, reminder.repeat || 'none', { timeZone, anchorDay });
  }
  return out;
}

/** Whether a reminder fires on a given day (planner dots and day lists). */
export function occursOn(reminder, dayKey, { timeZone = DEFAULT_TZ } = {}) {
  const start = zoned(reminder.at, timeZone).key;
  if (dayKey < start) return false;
  const repeat = reminder.repeat || 'none';
  if (repeat === 'none') return dayKey === start;
  if (repeat === 'daily') return true;
  const s = parseKey(start);
  const d = parseKey(dayKey);
  if (repeat === 'weekly') {
    const days = Math.round((Date.UTC(d.y, d.m - 1, d.d) - Date.UTC(s.y, s.m - 1, s.d)) / 86_400_000);
    return days % 7 === 0;
  }
  const anchor = anchorOf(reminder, timeZone);
  if (repeat === 'yearly' && d.m !== s.m) return false;
  return d.d === Math.min(anchor, daysInMonth(d.y, d.m));
}

/** True when a monthly / yearly anchor is missing from some months. */
export function needsMonthEndNote(repeat, anchorDay, month) {
  if (repeat === 'monthly') return anchorDay >= 29;
  if (repeat === 'yearly') return month === 2 && anchorDay === 29;
  return false;
}
