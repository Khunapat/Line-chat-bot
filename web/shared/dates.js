/**
 * Date helpers shared by the server and the web app. Plain ES module with no
 * imports, so the browser can load it as-is from /app/shared/dates.js.
 *
 * Dates without a time are "day keys" (YYYY-MM-DD) in the tenant's time zone
 * (Asia/Bangkok by default). Instants are ISO strings in UTC. Thai output uses
 * Buddhist years (2569); English output uses Gregorian years (2026).
 */

export const DEFAULT_TZ = 'Asia/Bangkok';

const pad = (n) => String(n).padStart(2, '0');

export function isDayKey(k) {
  if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  const [y, m, d] = k.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return { y, m, d };
}

export function makeKey(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Day of week, 0 = Sunday. */
export function dow(k) {
  const p = parseKey(k);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

export function addDays(k, n) {
  const p = parseKey(k);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return makeKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole calendar days from a to b (b - a). */
export function diffDays(a, b) {
  const x = parseKey(a);
  const y = parseKey(b);
  return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86_400_000);
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Monday that starts the week containing k. */
export function weekStart(k) {
  return addDays(k, -((dow(k) + 6) % 7));
}

/** { key: 'YYYY-MM-DD', hm: 'HH:MM' } of an instant in a time zone. */
export function zoned(iso, timeZone = DEFAULT_TZ) {
  const date = iso instanceof Date ? iso : new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { key: `${get('year')}-${get('month')}-${get('day')}`, hm: `${pad(Number(get('hour')) % 24)}:${get('minute')}` };
}

export function todayKey(timeZone = DEFAULT_TZ, now = new Date()) {
  return zoned(now, timeZone).key;
}

/**
 * The UTC instant of a wall-clock time in a time zone. Uses the zone's offset
 * at that moment, so it is right across DST changes outside Thailand too.
 */
export function zonedToUtc(key, hm, timeZone = DEFAULT_TZ) {
  const p = parseKey(key);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(p.y, p.m - 1, p.d, h, mi);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const z = zoned(new Date(t), timeZone);
    const zp = parseKey(z.key);
    const [zh, zm] = z.hm.split(':').map(Number);
    const shown = Date.UTC(zp.y, zp.m - 1, zp.d, zh, zm);
    const delta = guess - shown;
    if (delta === 0) break;
    t += delta;
  }
  return new Date(t).toISOString();
}

export function validTime(hm) {
  return typeof hm === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(hm);
}

// ---------------------------------------------------------------- formatting

const TH_DOW = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const TH_DOW_FULL = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_MON_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const EN_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EN_DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EN_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EN_MON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const WEEKDAY_NAMES = { th: TH_DOW_FULL, en: EN_DOW_FULL };

/** Year as shown: Buddhist era in Thai, Gregorian in English. */
export function shownYear(y, lang) {
  return lang === 'en' ? y : y + 543;
}

/**
 * Format a day key.
 *   dw    พ. / Wed
 *   mon   ต.ค. / Oct
 *   my    ตุลาคม 2569 / October 2026
 *   dm    7 ต.ค. / 7 Oct
 *   dmy   7 ต.ค. 69 / 7 Oct 26 (compact stub)
 *   full  วันพุธที่ 7 ตุลาคม 2569 / Wednesday 7 October 2026
 *   (default) พ. 7 ต.ค. 2569 / Wed 7 Oct 2026
 */
export function formatDay(k, lang = 'th', style) {
  const en = lang === 'en';
  const p = parseKey(k);
  const w = dow(k);
  const y = shownYear(p.y, lang);
  switch (style) {
    case 'dw': return en ? EN_DOW[w] : TH_DOW[w];
    case 'dwFull': return en ? EN_DOW_FULL[w] : TH_DOW_FULL[w];
    case 'mon': return en ? EN_MON[p.m - 1] : TH_MON[p.m - 1];
    case 'my': return en ? `${EN_MON_FULL[p.m - 1]} ${y}` : `${TH_MON_FULL[p.m - 1]} ${y}`;
    case 'dm': return en ? `${p.d} ${EN_MON[p.m - 1]}` : `${p.d} ${TH_MON[p.m - 1]}`;
    case 'dmy': return en ? `${p.d} ${EN_MON[p.m - 1]} ${String(y).slice(-2)}` : `${p.d} ${TH_MON[p.m - 1]} ${String(y).slice(-2)}`;
    case 'full': return en ? `${EN_DOW_FULL[w]} ${p.d} ${EN_MON_FULL[p.m - 1]} ${y}` : `วัน${TH_DOW_FULL[w]}ที่ ${p.d} ${TH_MON_FULL[p.m - 1]} ${y}`;
    default: return en ? `${EN_DOW[w]} ${p.d} ${EN_MON[p.m - 1]} ${y}` : `${TH_DOW[w]} ${p.d} ${TH_MON[p.m - 1]} ${y}`;
  }
}

/** "09:00 น." in Thai, "09:00" in English. */
export function formatTime(hm, lang = 'th') {
  return lang === 'en' ? hm : `${hm} น.`;
}

/** "พ. 7 ต.ค. 2569 · 09:00 น." for an instant, in the given zone. */
export function formatDateTime(iso, lang = 'th', timeZone = DEFAULT_TZ) {
  const z = zoned(iso, timeZone);
  return `${formatDay(z.key, lang)} · ${formatTime(z.hm, lang)}`;
}

/** Month label for a range of a week: "ตุลาคม 2569" or "ก.ย. 2569 – ต.ค. 2569". */
export function weekTitle(startKey, lang = 'th') {
  const end = addDays(startKey, 6);
  const a = parseKey(startKey);
  const b = parseKey(end);
  if (a.y === b.y && a.m === b.m) return formatDay(startKey, lang, 'my');
  return `${formatDay(startKey, lang, 'mon')} ${shownYear(a.y, lang)} – ${formatDay(end, lang, 'mon')} ${shownYear(b.y, lang)}`;
}
