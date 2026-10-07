/**
 * Reminder scheduling helpers. Reminders live in Drive (`_data/reminders.json`)
 * and are fired by `/cron/reminders`, which Cloud Scheduler calls every minute.
 *
 * Reminder shape:
 *   { id, userId, text, at: ISO string, repeat: 'none'|'daily'|'weekly'|'monthly'|'yearly',
 *     anchorDay?: day of month a monthly / yearly repeat was set for }
 */
import { nextOccurrence as sharedNext, anchorOf } from '../web/shared/recurrence.js';
import { L, currentLang } from './lang.js';

export { REPEATS } from '../web/shared/recurrence.js';

/**
 * The occurrence after `atIso`. Computed on the wall clock of `timeZone`, and
 * monthly / yearly repeats keep their `anchorDay` (see web/shared/recurrence.js).
 */
export function nextOccurrence(atIso, repeat, { timeZone = 'Asia/Bangkok', anchorDay } = {}) {
  return sharedNext(atIso, repeat, { timeZone, anchorDay });
}

/**
 * Fire every reminder whose time has passed. `notify(reminder)` sends the
 * message; on success one-off reminders are removed and repeating ones
 * advanced (skipping any occurrences already in the past).
 *
 * With `{ batch: true }` notify receives all due reminders at once, so they
 * can go out as one push (LINE counts one push per recipient, however many
 * messages it carries); they are marked done only when that push succeeds.
 */
export async function fireDueReminders(store, notify, now = new Date(), { batch = false, timeZone = 'Asia/Bangkok' } = {}) {
  const list = await store.reminders();
  const due = list.filter((r) => !r.firedAt && new Date(r.at) <= now);
  const settle = async (r) => {
    if (r.repeat && r.repeat !== 'none') {
      const anchorDay = anchorOf(r, timeZone);
      let next = nextOccurrence(r.at, r.repeat, { timeZone, anchorDay });
      while (next && new Date(next) <= now) next = nextOccurrence(next, r.repeat, { timeZone, anchorDay });
      await store.updateReminder(r.id, { at: next, ...(r.repeat === 'monthly' || r.repeat === 'yearly' ? { anchorDay } : {}) });
    } else {
      // Keep it around (hidden) so the snooze / done buttons still work.
      await store.updateReminder(r.id, { firedAt: now.toISOString() });
    }
  };
  let fired = 0;
  if (batch) {
    let sent = false;
    if (due.length) {
      try {
        await notify(due);
        sent = true;
      } catch (err) {
        console.error('reminder batch notify failed', due.map((r) => r.id).join(','), err?.message || err);
      }
    }
    if (sent) {
      fired = due.length;
      for (const r of due) {
        try {
          await settle(r);
        } catch (err) {
          console.error('reminder sent but not marked', r.id, err?.message || err);
        }
      }
    }
  } else {
    for (const r of due) {
      try {
        await notify(r);
        fired++;
        await settle(r);
      } catch (err) {
        console.error('reminder notify failed', r.id, err?.message || err);
      }
    }
  }
  // Purge fired one-offs older than a day.
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  for (const r of list) {
    if (r.firedAt && new Date(r.firedAt).getTime() < cutoff) await store.removeReminder(r.id);
  }
  return { checked: list.length, fired };
}

/** Reminders still pending (not yet fired), soonest first. */
export function pendingReminders(list, userId) {
  return list
    .filter((r) => !r.firedAt && (!userId || r.userId === userId))
    .sort((a, b) => a.at.localeCompare(b.at));
}

// ------------------------------------------------------------ formatting

const THAI_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์'];
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** Parts of a Date in a given IANA time zone. */
export function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')) % 24, minute: Number(get('minute')), weekday,
  };
}

/** "วันนี้ 18:00 น." / "พรุ่งนี้ 10:15 น." / "ศุกร์ 12 ก.ย. 09:00 น." (English: "Today 18:00", "Fri 12 Sep 09:00") */
export function describeWhen(atIso, timeZone, now = new Date()) {
  const lang = currentLang();
  const at = new Date(atIso);
  const a = zonedParts(at, timeZone);
  const n = zonedParts(now, timeZone);
  const hm = `${String(a.hour).padStart(2, '0')}:${String(a.minute).padStart(2, '0')}`;
  const hhmm = lang === 'en' ? hm : `${hm} น.`;

  const dayIndex = (p) => Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
  const diff = dayIndex(a) - dayIndex(n);
  if (diff === 0) return `${L('b_today')} ${hhmm}`;
  if (diff === 1) return `${L('b_tomorrow')} ${hhmm}`;
  if (diff === 2) return `${L('b_dayAfter')} ${hhmm}`;
  if (lang === 'en') {
    const year = a.year !== n.year ? ` ${a.year}` : '';
    return `${EN_DAYS[a.weekday]} ${a.day} ${EN_MONTHS[a.month - 1]}${year} ${hhmm}`;
  }
  const year = a.year !== n.year ? ` ${a.year + 543}` : '';
  return `${THAI_DAYS[a.weekday]} ${a.day} ${THAI_MONTHS[a.month - 1]}${year} ${hhmm}`;
}

export function describeRepeat(repeat) {
  return ['daily', 'weekly', 'monthly', 'yearly'].includes(repeat) ? L(repeat) : '';
}

/** ISO-like local timestamp with offset, e.g. 2026-09-08T21:32:00+07:00 */
export function localIsoWithOffset(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offsetMin = Math.round((asUtc - date.getTime() + (date.getTime() % 60_000)) / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:00${off}`;
}
