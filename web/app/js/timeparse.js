// Reading times and short "chat-style" reminders typed in the editor.
// Never guesses: "2 โมง" could be 08:00 or 14:00, so it comes back as a
// question with both options instead of a time.

import { addDays, dow, isDayKey, makeKey, parseKey } from '../../shared/dates.js';

const pad = (n) => String(n).padStart(2, '0');
const hm = (h, m = 0) => `${pad(h)}:${pad(m)}`;

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
function arabic(s) {
  return s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
}

/**
 * Parse one time expression.
 *   { hm: '14:30', word }                         unambiguous
 *   { ambiguous: true, word, options: [{ hm, part }] }  needs a choice
 *   null                                          not a time
 * `part` is 'morning' | 'afternoon' | 'night' for the option label.
 */
export function parseTime(input) {
  if (!input) return null;
  const s = arabic(String(input)).trim().toLowerCase().replace(/\s+/g, ' ');
  let m;
  const mins = (x) => (x ? Number(x) : 0);

  if ((m = /^(?:เวลา\s*)?(\d{1,2})[:.](\d{2})\s*(?:น\.?|นาฬิกา)?$/.exec(s))) {
    const h = Number(m[1]); const mi = Number(m[2]);
    if (h <= 23 && mi <= 59) return { hm: hm(h, mi), word: m[0] };
    return null;
  }
  if ((m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)$/.exec(s))) {
    let h = Number(m[1]); const mi = mins(m[2]);
    if (h < 1 || h > 12 || mi > 59) return null;
    const pm = m[3].startsWith('p');
    if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    return { hm: hm(h, mi), word: m[0] };
  }
  if (/^(noon|เที่ยง(?:วัน)?(?:ตรง)?)$/.test(s)) return { hm: '12:00', word: s };
  if (/^(midnight|เที่ยงคืน)$/.test(s)) return { hm: '00:00', word: s };
  if ((m = /^บ่าย\s*(?:(\d{1,2})\s*)?(?:โมง)?\s*(ครึ่ง)?$/.exec(s))) {
    const n = m[1] ? Number(m[1]) : 1;
    if (n < 1 || n > 5) return null;
    return { hm: hm(n + 12, m[2] ? 30 : 0), word: m[0] };
  }
  if ((m = /^(\d{1,2})\s*โมง\s*(เช้า|เย็น)\s*(ครึ่ง)?$/.exec(s))) {
    const n = Number(m[1]); const half = m[3] ? 30 : 0;
    if (m[2] === 'เช้า') {
      if (n >= 1 && n <= 5) return { hm: hm(n + 6, half), word: m[0] };
      if (n >= 6 && n <= 11) return { hm: hm(n, half), word: m[0] };
      return null;
    }
    if (n >= 4 && n <= 6) return { hm: hm(n + 12, half), word: m[0] };
    return null;
  }
  if ((m = /^(\d)\s*ทุ่ม\s*(ครึ่ง)?$/.exec(s))) {
    const n = Number(m[1]);
    if (n < 1 || n > 5) return null;
    return { hm: hm(n + 18, m[2] ? 30 : 0), word: m[0] };
  }
  if ((m = /^ตี\s*(\d)\s*(ครึ่ง)?$/.exec(s))) {
    const n = Number(m[1]);
    if (n < 1 || n > 5) return null;
    return { hm: hm(n, m[2] ? 30 : 0), word: m[0] };
  }
  if ((m = /^(\d{1,2})\s*โมง\s*(ครึ่ง)?$/.exec(s))) {
    const n = Number(m[1]); const half = m[2] ? 30 : 0;
    if (n >= 7 && n <= 11) return { hm: hm(n, half), word: m[0] };
    if (n === 12) return { hm: hm(12, half), word: m[0] };
    if (n >= 1 && n <= 5) return { ambiguous: true, word: m[0], options: [{ hm: hm(n + 6, half), part: 'morning' }, { hm: hm(n + 12, half), part: 'afternoon' }] };
    if (n === 6) return { ambiguous: true, word: m[0], options: [{ hm: hm(6, half), part: 'morning' }, { hm: hm(18, half), part: 'afternoon' }] };
    return null;
  }
  if ((m = /^(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?$/.exec(s))) {
    const h = Number(m[1]); const mi = mins(m[2]);
    if (mi > 59) return null;
    if (h >= 13 && h <= 23) return { hm: hm(h, mi), word: m[0] };
    if (h === 0) return { hm: hm(0, mi), word: m[0] };
    if (h >= 1 && h <= 12 && !m[2]) {
      return { ambiguous: true, word: m[0], options: [{ hm: hm(h === 12 ? 0 : h, mi), part: h === 12 ? 'night' : 'morning' }, { hm: hm(h === 12 ? 12 : h + 12, mi), part: 'afternoon' }] };
    }
    if (h >= 1 && h <= 12) return { hm: hm(h, mi), word: m[0] };
  }
  return null;
}

const TIME_PATTERNS = [
  /(?:เวลา\s*)?\d{1,2}[:.]\d{2}\s*(?:น\.?|นาฬิกา)?/,
  /\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)/i,
  /บ่าย\s*\d{0,2}\s*(?:โมง)?\s*(?:ครึ่ง)?/,
  /\d{1,2}\s*โมง\s*(?:เช้า|เย็น)?\s*(?:ครึ่ง)?/,
  /\d\s*ทุ่ม\s*(?:ครึ่ง)?/,
  /ตี\s*\d\s*(?:ครึ่ง)?/,
  /เที่ยงคืน|เที่ยง(?:วัน)?|noon|midnight/i,
  /\bat\s+\d{1,2}(?:[:.]\d{2})?\b/i,
];

const TH_WEEKDAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์'];
const EN_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * A short chat-style reminder -> editor fields. Only fills what it can read;
 * the user confirms everything before it is saved.
 * Returns { text, day, dayImplicit, time (parseTime result), repeat } or null.
 */
export function parseNatural(input, { today }) {
  let s = arabic(String(input || '')).trim();
  if (!s) return null;
  let day = '';
  let repeat = 'none';
  let time = null;
  const take = (re) => {
    const m = re.exec(s);
    if (!m) return null;
    s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim();
    return m;
  };

  let m;
  if ((m = take(/ทุกวัน(จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|ศุกร์|เสาร์|อาทิตย์)/))) {
    repeat = 'weekly';
    day = nextWeekday(today, TH_WEEKDAYS.findIndex((w) => m[1].startsWith(w)), { allowToday: true });
  } else if ((m = take(/\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i))) {
    repeat = 'weekly';
    day = nextWeekday(today, EN_WEEKDAYS.indexOf(m[1].toLowerCase()), { allowToday: true });
  } else if (take(/ทุกวัน(?!ที่)|every\s*day|daily/i)) repeat = 'daily';
  else if (take(/ทุก(?:สัปดาห์|อาทิตย์)|every\s*week|weekly/i)) repeat = 'weekly';
  else if (take(/ทุกเดือน|every\s*month|monthly/i)) repeat = 'monthly';
  else if (take(/ทุกปี|every\s*year|yearly|annually/i)) repeat = 'yearly';

  if (day) { /* weekday repeat already set the first day */ } else if ((m = take(/วันนี้|today|tonight|คืนนี้/i))) day = today;
  else if ((m = take(/มะรืน(?:นี้)?|day after tomorrow/i))) day = addDays(today, 2);
  else if ((m = take(/พรุ่งนี้|tomorrow/i))) day = addDays(today, 1);
  else if ((m = take(/(?:วัน)?(จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|ศุกร์|เสาร์|อาทิตย์)(?:หน้า)?/))) {
    const idx = TH_WEEKDAYS.findIndex((w) => m[1].startsWith(w));
    day = nextWeekday(today, idx);
  } else if ((m = take(/\b(?:on\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i))) {
    day = nextWeekday(today, EN_WEEKDAYS.indexOf(m[1].toLowerCase()));
  } else if ((m = take(/(?:วันที่\s*)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/))) {
    const d = Number(m[1]); const mo = Number(m[2]);
    const t = parseKey(today);
    let y = m[3] ? Number(m[3]) : t.y;
    if (y < 100) y += 2000;
    if (y > 2400) y -= 543; // Buddhist year
    let key = makeKey(y, mo, d);
    if (!m[3] && isDayKey(key) && key < today) key = makeKey(y + 1, mo, d);
    if (isDayKey(key)) day = key;
  }

  for (const re of TIME_PATTERNS) {
    const found = re.exec(s);
    if (!found) continue;
    const parsed = parseTime(found[0].replace(/^at\s+/i, 'at '));
    if (parsed) {
      time = parsed;
      s = (s.slice(0, found.index) + ' ' + s.slice(found.index + found[0].length)).trim();
      break;
    }
  }

  let text = s
    .replace(/^(?:ช่วย)?(?:ตั้ง)?เตือน(?:ให้)?(?:หน่อย)?(?:ว่า)?/, '')
    .replace(/^remind\s+me\s+(?:to\s+)?/i, '')
    .replace(/\s*(?:ให้หน่อย|หน่อย|นะ|ด้วย)\s*$/, '')
    .replace(/^(?:to|at|on)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!day && !time && repeat === 'none') return null;
  return { text, day: day || today, dayImplicit: !day, time, repeat };
}

function nextWeekday(today, idx, { allowToday = false } = {}) {
  if (idx < 0) return '';
  let n = (idx - dow(today) + 7) % 7;
  if (n === 0 && !allowToday) n = 7;
  return addDays(today, n);
}
