/**
 * Reading bank / card notifications (e-mail, SMS, pasted text) into a
 * charge: { kind, merchant, service, amount, currency, on, time, cardLast4,
 * looksRecurring, cycle, trialEndsOn, parser }.
 *
 * Known formats are read with patterns (no AI, nothing leaves the server);
 * anything else can go to the AI with PAYMENT_SCHEMA. One-time passwords
 * are never read, stored or sent anywhere.
 */
import { createHash } from 'node:crypto';
import { makeKey, isDayKey, zoned } from '../web/shared/dates.js';
import { CYCLES } from './subscriptions.js';

export const PAYMENT_KINDS = ['none', 'charge', 'payment', 'transfer', 'refund', 'trial_started', 'subscription_started', 'renewal_notice'];

/** Structured output for the AI (also embedded in the poster/receipt schema). */
export const PAYMENT_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: PAYMENT_KINDS,
      description: 'charge = card charged; payment = bill / QR payment from an account; transfer = money sent to a person; refund; trial_started = a free trial began; subscription_started = a paid plan began; renewal_notice = "your plan renews on ..."; none = not a money movement (OTP, ads, anything else)',
    },
    merchant: { type: 'string', description: 'merchant / payee exactly as printed, or empty' },
    service: { type: 'string', description: 'clean product name when it is a subscription service, e.g. "Netflix", "ChatGPT Plus", "iCloud+", or empty' },
    amount: { type: 'number', description: 'amount charged or due, 0 if none' },
    currency: { type: 'string', description: 'ISO 4217 code, THB for baht' },
    date: { type: 'string', description: 'YYYY-MM-DD in the Gregorian calendar (2569 = 2026) of the charge or start, or empty' },
    card_last4: { type: 'string', description: 'last 3-4 digits of the card / account shown, or empty' },
    cycle: { type: 'string', enum: CYCLES, description: 'billing cycle if stated or obvious, else unknown' },
    trial_end_date: { type: 'string', description: 'YYYY-MM-DD when a free trial ends (first charge), or empty' },
    looks_recurring: { type: 'boolean', description: 'true when this looks like a subscription or other recurring charge' },
  },
  required: ['kind', 'merchant', 'service', 'amount', 'currency', 'date', 'card_last4', 'cycle', 'trial_end_date', 'looks_recurring'],
  additionalProperties: false,
};

// ------------------------------------------------------------- privacy

const OTP = /\bOTP\b|รหัส\s*OTP|one[\s-]?time[\s-]?pass|รหัสยืนยัน(?:ตัวตน)?|verification\s+code|security\s+code|รหัสผ่านใช้ครั้งเดียว/i;

/** True for messages that carry a one-time code: never stored, never sent to the AI. */
export function isOneTimeCode(text) {
  return OTP.test(String(text || ''));
}

/** Stable id for de-duplication; the text itself is not kept. */
export function fingerprint({ source = '', id = '', text = '' }) {
  if (id) return `${source}:${String(id).slice(0, 120)}`;
  return 'h:' + createHash('sha256').update(String(text).replace(/\s+/g, ' ').trim()).digest('base64url').slice(0, 32);
}

// --------------------------------------------------------------- dates

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_ABBR = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** 2569 -> 2026, 69 -> 2026 (Buddhist, two digits above 40), 26 -> 2026. */
export function normYear(y) {
  const n = Number(y);
  if (!Number.isFinite(n)) return null;
  if (n >= 2400) return n - 543;
  if (n >= 1900) return n;
  if (n > 40 && n < 100) return 2500 + n - 543;
  if (n >= 0 && n <= 40) return 2000 + n;
  return null;
}

function monthIndex(name) {
  const s = String(name).toLowerCase().replace(/\s+/g, '');
  let i = TH_MONTHS.indexOf(name);
  if (i >= 0) return i;
  i = TH_ABBR.findIndex((a) => a.replace(/\s+/g, '') === s);
  if (i >= 0) return i;
  i = EN_MONTHS.findIndex((m) => m === s || (s.length >= 3 && m.startsWith(s.replace(/\.$/, ''))));
  return i;
}

const MONTH_WORD = `(${[...TH_MONTHS, ...TH_ABBR.map((a) => a.replace(/\./g, '\\.'))].join('|')}|[A-Za-z]{3,9}\\.?)`;

/** "07:50" right after a date ("เวลา 07:50:20 น.", "at 07:50", "10.05 น."), or ''. */
function timeAfter(rest) {
  const m = /^[^\d\n]{0,12}?(\d{1,2})(?::(\d{2})|\.(\d{2})(?=\s*น))/.exec(rest);
  if (!m) return '';
  const h = Number(m[1]);
  const mi = m[2] ?? m[3];
  return h < 24 ? `${String(h).padStart(2, '0')}:${mi}` : '';
}

/** First real date in the text as { on, time } (Gregorian day key), or null. */
export function findDate(text) {
  const s = String(text || '');
  // "19 สิงหาคม 2569", "19 ส.ค. 69", "19 August 2026", "23 Oct 2026"
  const named = new RegExp(`(\\d{1,2})\\s*${MONTH_WORD}\\s*(\\d{4}|\\d{2})(?!\\d)`, 'g');
  for (let m = named.exec(s); m; m = named.exec(s)) {
    const mi = monthIndex(m[2]);
    const y = normYear(m[3]);
    const on = mi >= 0 && y ? makeKey(y, mi + 1, Number(m[1])) : '';
    if (isDayKey(on)) return { on, time: timeAfter(s.slice(m.index + m[0].length)) };
    named.lastIndex = m.index + 1; // "20.00 THB 23 Oct": try again from the next digit
  }
  // "23/10/69", "23-10-2026"
  const numeric = /(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/g;
  for (let m = numeric.exec(s); m; m = numeric.exec(s)) {
    const y = normYear(m[3]);
    const on = y ? makeKey(y, Number(m[2]), Number(m[1])) : '';
    if (isDayKey(on)) return { on, time: timeAfter(s.slice(m.index + m[0].length)) };
    numeric.lastIndex = m.index + 1;
  }
  return null;
}

// ------------------------------------------------------------- parsers

const num = (s) => Number(String(s).replace(/,/g, ''));

/** One line endings, plain spaces (mail clients add \r\n and non-breaking spaces). */
export function cleanText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').replace(/[   ]/g, ' ');
}

/**
 * The value after a label, on the same line (tab separated, as in the bank's
 * table) or on one of the next two lines (Gmail's plain-text copy).
 */
function field(s, label) {
  const m = new RegExp(`(?:${label})[ \\t*:]*(?:\\n[ \\t*:]*){0,2}([^\\n]*\\S[^\\n]*)`, 'i').exec(s);
  return m ? m[1].replace(/^[\s*]+|[\s*]+$/g, '') : '';
}

function lastDigits(s) {
  const m = /(\d{3,4})\s*$/.exec(String(s || '').trim());
  return m ? m[1] : '';
}

/**
 * Bangkok Bank "ยืนยันการจ่ายเงิน / Payment confirmation" and similar
 * transfer e-mails (Thai and English blocks).
 */
export function parseBangkokBank(text) {
  const s = cleanText(text);
  if (!/ธนาคารกรุงเทพ|Bangkok Bank/i.test(s)) return null;
  const payee = field(s, 'ชื่อบริษัท\\s*/\\s*ชื่อผู้ให้บริการ') || field(s, 'Payee name')
    || field(s, 'ชื่อบัญชีผู้รับ|To account name');
  const amount = /([\d,]+\.\d{2})/.exec(field(s, 'จำนวนเงิน\\s*\\(บาท\\)') || field(s, 'Amount\\s*\\(Baht\\)'))?.[1];
  if (!payee || !amount) return null;
  const account = /[\dxX*-]{4,}/.exec(field(s, 'เลขที่บัญชี\\s*/\\s*หมายเลขบัตรเครดิต|Account no\\.\\s*/\\s*credit card no\\.'))?.[0] || '';
  const d = findDate(field(s, 'วันที่') || field(s, '\\bDate\\b') || s);
  const kind = /โอนเงิน|Fund transfer|Transfer confirmation/i.test(s) ? 'transfer' : 'payment';
  return {
    kind, merchant: payee.slice(0, 80), service: '', amount: num(amount), currency: 'THB',
    on: d?.on || '', time: d?.time || '', cardLast4: lastDigits(account), cycle: 'unknown', trialEndsOn: '', looksRecurring: false, parser: 'bbl',
  };
}

const CURRENCY = { '฿': 'THB', 'บาท': 'THB', 'บ.': 'THB', 'thb': 'THB', 'usd': 'USD', 'us$': 'USD', '$': 'USD', 'eur': 'EUR', '€': 'EUR', 'gbp': 'GBP', '£': 'GBP', 'jpy': 'JPY', '¥': 'JPY', 'sgd': 'SGD' };
const CUR = '(THB|USD|EUR|GBP|JPY|SGD|US\\$|฿|\\$|€|£|¥|บาท|บ\\.)';
const AMT = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';

// A card / account message says money moved; adverts say "%" or "promotion".
const SPEND = /ใช้จ่าย|ชำระ|ตัดบัตร|ตัดเงิน|หักเงิน|หักบัญชี|ทำรายการ|ใช้บัตร|รูดบัตร|คืนเงิน|charged|spent|purchase|payment|transaction|debited|paid|billed|refund/i;
const PROMO = /%|โปรโมชั่น|โปรฯ|ส่วนลด|รับสิทธิ์|ลุ้นรับ|แจกฟรี|\bpromo|\bdiscount|\bcashback|\boffer\b/i;

/**
 * Common card SMS / e-mail shapes, e.g.
 *   "บัตร xx1234 ใช้จ่าย 419.00 บาท ที่ NETFLIX.COM 23/10/69 10:05"
 *   "Your card ending 1234 was charged USD 20.00 at OPENAI *CHATGPT SUBSCR on 23 Oct 2026"
 * Needs a spend word, an amount with a currency and a merchant after ที่ / at / @.
 */
export function parseGenericCard(text) {
  const s = cleanText(text).replace(/\s+/g, ' ').trim();
  if (!SPEND.test(s) || PROMO.test(s)) return null;
  const before = new RegExp(`${CUR}\\s?${AMT}`, 'i').exec(s);
  const after = new RegExp(`${AMT}\\s?${CUR}`, 'i').exec(s);
  let amount;
  let cur;
  if (before && (!after || before.index <= after.index)) { cur = before[1]; amount = before[2]; } else if (after) { amount = after[1]; cur = after[2]; }
  if (!amount || !(num(amount) > 0)) return null;
  const m = /(?:(?:^|\s)ที่|\bat(?=\s)|@|ร้าน|merchant:?)\s*([A-Za-z0-9฀-๿][A-Za-z0-9฀-๿*.,&'/_+ -]{1,60}?)(?=\s+(?:on\b|วันที่|เมื่อ|เวลา|ยอด|คงเหลือ|balance|avail|with\b|via\b|using\b|\d{1,2}[/.-]\d{1,2})|\s*[.,;]?\s*$|\s+(?:THB|USD|฿|\$)?\s?\d[\d,]*\.\d{2})/i.exec(s);
  if (!m) return null;
  const merchant = m[1].trim().replace(/[.,;]+$/, '');
  if (merchant.length < 2) return null;
  const card = /(?:x{2,}|\*{2,}|•{2,}|ending(?:\s+in)?|ลงท้าย(?:ด้วย)?|หมายเลข)\s*-?\s*(\d{3,4})(?!\d)/i.exec(s)?.[1] || '';
  const d = findDate(s);
  const kind = /คืนเงิน|refund|reversal|ยกเลิกรายการ/i.test(s) ? 'refund' : 'charge';
  return {
    kind, merchant, service: '', amount: num(amount), currency: CURRENCY[cur.toLowerCase()] || 'THB',
    on: d?.on || '', time: d?.time || '', cardLast4: card, cycle: 'unknown', trialEndsOn: '', looksRecurring: false, parser: 'generic',
  };
}

/** A day and month without a year ("14/10"): the most recent one, not in the future. */
export function dayMonthToKey(d, m, { now = new Date(), timeZone = 'Asia/Bangkok' } = {}) {
  const today = zoned(now, timeZone).key;
  const y = Number(today.slice(0, 4));
  for (const year of [y, y - 1]) {
    const k = makeKey(year, Number(m), Number(d));
    if (isDayKey(k) && k <= today) return k;
  }
  return '';
}

/**
 * Bangkok Bank card SMS:
 *   "14/10 09:33 ชำระ189.00บ โดยบัตร x'1111 ณGOOGLE(GOOGLE ONE"
 * and the messages that only report the account side or a balance, which
 * are the same money again and are read as kind "none":
 *   "ถอน/โอน/จ่ายเงินจากบ/ชX0000 ผ่านบัตร 699.00บ ใช้ได้697.49บ"
 *   "บ/ชX0000 วันที่ 19/10 เวลา 06:01 เงินในบ/ชใช้ได้ 697.49 บ"
 */
export function parseBangkokBankSms(text, opts = {}) {
  const s = cleanText(text).replace(/\s+/g, ' ').trim();
  const m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2}):(\d{2})\s*(ชำระ|คืนเงิน|ยกเลิก(?:รายการ)?)\s*([\d,]+\.\d{2})\s*บ\.?\s*(?:โดย)?บัตร\s*[xX*]'?\s*(\d{3,4})\s*ณ\s*(.+)$/.exec(s);
  if (m) {
    const on = m[3] ? (() => { const y = normYear(m[3]); const k = y ? makeKey(y, Number(m[2]), Number(m[1])) : ''; return isDayKey(k) ? k : ''; })() : dayMonthToKey(m[1], m[2], opts);
    const merchant = m[9].trim().replace(/[.,;]+$/, '').slice(0, 80);
    if (!merchant) return null;
    return {
      kind: m[6] === 'ชำระ' ? 'charge' : 'refund', merchant, service: '', amount: num(m[7]), currency: 'THB',
      on, time: `${m[4].padStart(2, '0')}:${m[5]}`, cardLast4: m[8], cycle: 'unknown', trialEndsOn: '', looksRecurring: false, parser: 'bbl-sms',
    };
  }
  if (/บ\/ช\s*[xX*]?\d{3,4}/.test(s) && /ใช้ได้\s*[\d,]+\.\d{2}\s*บ/.test(s) && !/\sณ\S/.test(s)) {
    return { kind: 'none', merchant: '', service: '', amount: 0, currency: 'THB', on: '', time: '', cardLast4: '', cycle: 'unknown', trialEndsOn: '', looksRecurring: false, parser: 'bbl-sms' };
  }
  return null;
}

/**
 * Pattern readers in order; null when none of them understands the text.
 * kind "none" means "understood, and it is not a new charge" (a balance).
 */
export function parseKnownFormats(text, opts = {}) {
  return parseBangkokBankSms(text, opts) || parseBangkokBank(text) || parseGenericCard(text);
}

/** AI result (PAYMENT_SCHEMA) -> charge, or null when it is not a money movement. */
export function normalizePayment(p) {
  if (!p || typeof p !== 'object' || !PAYMENT_KINDS.includes(p.kind) || p.kind === 'none') return null;
  const amount = Number(p.amount) || 0;
  const merchant = String(p.merchant || p.service || '').trim().slice(0, 80);
  if (!merchant) return null;
  if (!amount && !['trial_started', 'renewal_notice', 'subscription_started'].includes(p.kind)) return null;
  const date = String(p.date || '');
  const trial = String(p.trial_end_date || '');
  return {
    kind: p.kind, merchant, service: String(p.service || '').trim().slice(0, 60), amount,
    currency: /^[A-Z]{3}$/.test(p.currency || '') ? p.currency : 'THB',
    on: isDayKey(date) ? date : '', time: '', cardLast4: String(p.card_last4 || '').replace(/\D/g, '').slice(-4),
    cycle: CYCLES.includes(p.cycle) ? p.cycle : 'unknown', trialEndsOn: isDayKey(trial) ? trial : '',
    looksRecurring: Boolean(p.looks_recurring), parser: 'ai',
  };
}

export function paymentPrompt(todayIso) {
  return `You read one bank or card notification (SMS, e-mail, app screenshot or a pasted message) and extract the money movement.
Today is ${todayIso}. Thai dates may use the Buddhist year: 2569 = 2026, and two-digit 69 = 2026.
Use kind "none" for anything that is not a money movement (one-time passwords, adverts, statements, balance only).
Copy the merchant or payee as printed. Never invent an amount, a date or card digits: leave them empty or 0.`;
}

/** Ask the AI to read a notification text it could not parse with patterns. */
export async function extractCharge(provider, text, { now = new Date(), timeZone = 'Asia/Bangkok' } = {}) {
  const today = zoned(now, timeZone).key;
  const out = await provider.extract({
    system: paymentPrompt(today),
    parts: [{ text: String(text).slice(0, 6000) }],
    schema: PAYMENT_SCHEMA,
  });
  return normalizePayment(out);
}
