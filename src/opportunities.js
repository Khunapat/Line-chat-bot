/**
 * "Opportunities": posters, links and announcements about competitions,
 * applications, scholarships, courses and events. The model reads the image
 * / page / text and fills a fixed schema; we keep the record in Drive, create
 * deadline reminders, put the deadline in the calendar, and maintain a
 * human-readable Opportunities.md.
 */
import { zonedParts, describeWhen } from './reminders.js';

export const KINDS = ['competition', 'application', 'scholarship', 'course', 'event', 'other'];

export const KIND_THAI = {
  competition: 'การแข่งขัน',
  application: 'รับสมัคร',
  scholarship: 'ทุน',
  course: 'คอร์ส/อบรม',
  event: 'กิจกรรม',
  other: 'อื่น ๆ',
};

export const SCHEMA = {
  type: 'object',
  properties: {
    is_opportunity: { type: 'boolean', description: 'true if this is an announcement people can apply to, join, compete in, or attend' },
    kind: { type: 'string', enum: KINDS },
    title: { type: 'string', description: 'short title, original language' },
    organizer: { type: 'string', description: 'organiser / host, or empty' },
    summary: { type: 'string', description: 'one or two sentences in Thai: what it is and who it is for' },
    deadline: { type: 'string', description: 'application / registration deadline as YYYY-MM-DD in the Gregorian calendar (convert Thai Buddhist years: 2569 = 2026), or empty if none' },
    deadline_note: { type: 'string', description: 'time or condition attached to the deadline, e.g. "23:59" or "หรือจนกว่าจะเต็ม", or empty' },
    event_dates: { type: 'string', description: 'when the event / course / competition happens, as written, or empty' },
    eligibility: { type: 'string', description: 'who can apply, short, or empty' },
    cost: { type: 'string', description: 'fee / free / prize money, short, or empty' },
    link: { type: 'string', description: 'registration URL if visible, or empty' },
    contact: { type: 'string', description: 'phone / email / LINE id, or empty' },
    confidence: { type: 'number', description: '0 to 1' },
  },
  required: ['is_opportunity', 'kind', 'title', 'organizer', 'summary', 'deadline', 'deadline_note', 'event_dates', 'eligibility', 'cost', 'link', 'contact', 'confidence'],
  additionalProperties: false,
};

export function systemPrompt(todayIso) {
  return `You read posters, web pages and messages and decide whether they announce something a person can apply to, register for, compete in, attend, or get funding from (competition, job/program application, scholarship, course/training, event/seminar).
Today is ${todayIso}. Dates in Thai may use the Buddhist year (พ.ศ.): subtract 543 to get the Gregorian year (2569 -> 2026). If only day and month are given, assume the next occurrence on or after today.
Output every field. Use empty strings when unknown. Summary in Thai, casual but clear. If the content is not such an announcement (a receipt, a selfie, a chat screenshot, a news article), set is_opportunity=false and leave the other fields empty.`;
}

/** Ask the provider to read an image / PDF. */
export async function extractFromMedia(provider, { mimeType, base64 }, { now = new Date(), timeZone } = {}) {
  const today = todayIso(now, timeZone);
  return normalize(await provider.extract({
    system: systemPrompt(today),
    parts: [
      { inlineData: { mimeType, data: base64 } },
      { text: 'Read this and fill the schema.' },
    ],
    schema: SCHEMA,
  }));
}

/** Ask the provider to read text (a fetched web page, or a pasted message). */
export async function extractFromText(provider, text, { url, now = new Date(), timeZone } = {}) {
  const today = todayIso(now, timeZone);
  const header = url ? `Source URL: ${url}\n\n` : '';
  return normalize(await provider.extract({
    system: systemPrompt(today),
    parts: [{ text: header + text.slice(0, 12_000) }],
    schema: SCHEMA,
  }));
}

function normalize(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of Object.keys(SCHEMA.properties)) out[k] = o[k] ?? '';
  out.is_opportunity = Boolean(o.is_opportunity);
  out.confidence = Number(o.confidence) || 0;
  if (!KINDS.includes(out.kind)) out.kind = 'other';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.deadline)) out.deadline = '';
  return out;
}

/**
 * Fetch a web page and reduce it to readable text. Returns '' when the site
 * blocks us or the response is not HTML.
 */
export async function fetchPageText(url, { timeoutMs = 10_000, maxBytes = 1_500_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; LineDriveArchiver/1.0)',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'th,en;q=0.8',
      },
    });
    const type = resp.headers.get('content-type') || '';
    if (!resp.ok || !/text\/html|text\/plain|xml/.test(type)) return '';
    const buf = Buffer.from(await resp.arrayBuffer());
    return htmlToText(buf.subarray(0, maxBytes).toString('utf8'));
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

export function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
  const metaDesc = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] || '';
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return [title && `Title: ${decodeEntities(title.trim())}`, metaDesc && `Description: ${decodeEntities(metaDesc)}`, body]
    .filter(Boolean)
    .join('\n');
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ------------------------------------------------------------ deadlines

export function todayIso(now, timeZone) {
  const p = zonedParts(now, timeZone || 'UTC');
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Whole days from today (in the zone) to a YYYY-MM-DD date. Negative = past. */
export function daysUntil(dateIso, timeZone, now = new Date()) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const t = zonedParts(now, timeZone || 'UTC');
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.year, t.month - 1, t.day)) / 86_400_000);
}

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** "อีก 12 วัน (20 ก.ย.)", "พรุ่งนี้", "วันนี้", "หมดเขตแล้ว (1 ก.ย.)" */
export function describeDeadline(dateIso, timeZone, now = new Date()) {
  if (!dateIso) return 'ไม่ระบุวันหมดเขต';
  const [, m, d] = dateIso.split('-').map(Number);
  const label = `${d} ${THAI_MONTHS[m - 1]}`;
  const days = daysUntil(dateIso, timeZone, now);
  if (days < 0) return `หมดเขตแล้ว (${label})`;
  if (days === 0) return `วันนี้ (${label})`;
  if (days === 1) return `พรุ่งนี้ (${label})`;
  return `อีก ${days} วัน (${label})`;
}

/** Reminder times for a deadline: 3 days before and the morning of, 09:00 local. */
export function deadlineReminderTimes(dateIso, timeZone, now = new Date()) {
  const at9 = (iso) => localDateTimeToUtc(iso, 9, 0, timeZone);
  const [y, m, d] = dateIso.split('-').map(Number);
  const before = new Date(Date.UTC(y, m - 1, d - 3));
  const beforeIso = before.toISOString().slice(0, 10);
  return [
    { at: at9(beforeIso), label: 'อีก 3 วันจะปิดรับ' },
    { at: at9(dateIso), label: 'วันนี้วันสุดท้าย' },
  ].filter((r) => new Date(r.at) > now);
}

/** Convert a local wall-clock time in `timeZone` to a UTC ISO string. */
export function localDateTimeToUtc(dateIso, hour, minute, timeZone) {
  const [y, m, d] = dateIso.split('-').map(Number);
  // Start from the naive UTC instant, then correct by the zone's offset at that instant.
  let guess = Date.UTC(y, m - 1, d, hour, minute);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone || 'UTC');
    const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess -= localAsUtc - Date.UTC(y, m - 1, d, hour, minute);
  }
  return new Date(guess).toISOString();
}

/** Pending (not past) opportunities first by deadline, then the rest. */
export function sortOpportunities(list, timeZone, now = new Date()) {
  const withDays = list.map((o) => ({ o, days: o.deadline ? daysUntil(o.deadline, timeZone, now) : null }));
  const upcoming = withDays.filter((x) => x.days !== null && x.days >= 0).sort((a, b) => a.days - b.days);
  const undated = withDays.filter((x) => x.days === null);
  const past = withDays.filter((x) => x.days !== null && x.days < 0).sort((a, b) => b.days - a.days);
  return [...upcoming, ...undated, ...past].map((x) => x.o);
}

/** Markdown table for Drive. */
export function renderMarkdown(list, timeZone, now = new Date()) {
  const rows = sortOpportunities(list, timeZone, now).map((o) => {
    const dl = o.deadline ? `${o.deadline} (${describeDeadline(o.deadline, timeZone, now)})` : '-';
    const link = o.link || o.source?.webViewLink || '';
    return `| ${escapeCell(o.title)} | ${KIND_THAI[o.kind] || KIND_THAI.other} | ${dl} | ${escapeCell(o.event_dates)} | ${escapeCell(o.eligibility)} | ${escapeCell(o.cost)} | ${link ? `[เปิด](${link})` : ''} |`;
  });
  return [
    `# Opportunities (${list.length})`,
    '',
    `อัปเดต ${describeWhen(now.toISOString(), timeZone, now)}`,
    '',
    '| ชื่อ | ประเภท | หมดเขต | วันจัด | ใครสมัครได้ | ค่าใช้จ่าย/รางวัล | ลิงก์ |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function escapeCell(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}
