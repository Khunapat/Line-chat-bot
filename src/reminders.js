/**
 * Reminder scheduling helpers. Reminders live in Drive (`_data/reminders.json`)
 * and are fired by `/cron/reminders`, which Cloud Scheduler calls every minute.
 *
 * Reminder shape:
 *   { id, userId, text, at: ISO string, repeat: 'none'|'daily'|'weekly'|'monthly'|'yearly' }
 */

export const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

export function nextOccurrence(atIso, repeat) {
  const d = new Date(atIso);
  switch (repeat) {
    case 'daily': d.setUTCDate(d.getUTCDate() + 1); break;
    case 'weekly': d.setUTCDate(d.getUTCDate() + 7); break;
    case 'monthly': d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'yearly': d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default: return null;
  }
  return d.toISOString();
}

/**
 * Fire every reminder whose time has passed. `notify(reminder)` sends the
 * message; on success one-off reminders are removed and repeating ones
 * advanced (skipping any occurrences already in the past).
 */
export async function fireDueReminders(store, notify, now = new Date()) {
  const list = await store.reminders();
  const due = list.filter((r) => new Date(r.at) <= now);
  let fired = 0;
  for (const r of due) {
    try {
      await notify(r);
      fired++;
      if (r.repeat && r.repeat !== 'none') {
        let next = nextOccurrence(r.at, r.repeat);
        while (next && new Date(next) <= now) next = nextOccurrence(next, r.repeat);
        await store.updateReminder(r.id, { at: next });
      } else {
        await store.removeReminder(r.id);
      }
    } catch (err) {
      console.error('reminder notify failed', r.id, err?.message || err);
    }
  }
  return { checked: list.length, fired };
}

// ------------------------------------------------------------ formatting

const THAI_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์'];
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

/** "วันนี้ 18:00 น." / "พรุ่งนี้ 10:15 น." / "ศุกร์ 12 ก.ย. 09:00 น." */
export function describeWhen(atIso, timeZone, now = new Date()) {
  const at = new Date(atIso);
  const a = zonedParts(at, timeZone);
  const n = zonedParts(now, timeZone);
  const hhmm = `${String(a.hour).padStart(2, '0')}:${String(a.minute).padStart(2, '0')} น.`;

  const dayIndex = (p) => Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
  const diff = dayIndex(a) - dayIndex(n);
  if (diff === 0) return `วันนี้ ${hhmm}`;
  if (diff === 1) return `พรุ่งนี้ ${hhmm}`;
  if (diff === 2) return `มะรืนนี้ ${hhmm}`;
  const year = a.year !== n.year ? ` ${a.year + 543}` : '';
  return `${THAI_DAYS[a.weekday]} ${a.day} ${THAI_MONTHS[a.month - 1]}${year} ${hhmm}`;
}

export function describeRepeat(repeat) {
  return {
    daily: 'ทุกวัน', weekly: 'ทุกสัปดาห์', monthly: 'ทุกเดือน', yearly: 'ทุกปี',
  }[repeat] || '';
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
