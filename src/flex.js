/**
 * LINE Flex Message builders. Visual style: warm beige cards with olive
 * buttons, dark rounded text - a friendly "notebook" look.
 */
import { describeWhen, describeRepeat } from './reminders.js';
import { daysUntil, KIND_THAI, THAI_MONTHS, todayIso } from './opportunities.js';
import {
  ALERT_PRESETS, ALERT_TIMES, normalizeAlerts, alertsFor, describeAlerts, groupForList,
} from './deadlines.js';

const C = {
  card: '#F4EFE4',
  cardAlt: '#EFE8D8',
  stroke: '#3B3B3B', // the dark outline around cards and buttons
  button: '#8B9270',
  buttonText: '#FFFFFF',
  title: '#2E2E2E',
  text: '#3D3D3D',
  muted: '#8A8A8A',
  link: '#4A4A4A',
};

// Where the hand-drawn icon PNGs are served from (`<publicBase>/static/icons`).
// Until the bot knows its public URL, headings fall back to the emoji.
let assetBase = '';
export function setAssetBase(base) {
  assetBase = String(base || '').replace(/\/$/, '');
}
export function iconUrl(name) {
  return assetBase ? `${assetBase}/static/icons/${name}.png` : null;
}

/** Leading emoji in a title -> icon file name. */
const EMOJI_ICON = {
  '📁': 'folder', '🗂️': 'folder', '🖼️': 'gallery', '⏰': 'bell', '🔔': 'bell', '🎯': 'target', '📝': 'note',
  '🔗': 'link', '👥': 'group', '⚙️': 'settings', '🤖': 'ai', '📅': 'calendar', '🗓️': 'calendar', '📍': 'pin',
  '🔍': 'search', '📄': 'doc', '📎': 'clip', '🎬': 'video', '🎙️': 'audio', '✅': 'check', '👋': 'wave', '🕐': 'clock',
  '🗑️': 'trash', '🗑': 'trash',
};
const LEADING_EMOJI = /^(\p{Extended_Pictographic}\uFE0F?)\s*/u;

/** Split "📁 title" into { icon, text } when the emoji has a drawn icon. */
export function splitIcon(title) {
  const m = LEADING_EMOJI.exec(title || '');
  const icon = m && EMOJI_ICON[m[1]];
  return icon ? { icon, text: title.slice(m[0].length) } : { icon: null, text: title };
}

export function textMessage(text) {
  return { type: 'text', text: String(text).slice(0, 5000) };
}

export function flexMessage(altText, contents) {
  return { type: 'flex', altText: String(altText).slice(0, 400), contents };
}

// ------------------------------------------------------------- pieces

function heading(title) {
  const { icon, text } = splitIcon(title);
  const url = icon && iconUrl(icon);
  const label = { type: 'text', text: url ? text : title, weight: 'bold', size: 'md', color: C.title, wrap: true };
  if (!url) return label;
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    alignItems: 'center',
    contents: [
      { type: 'image', url, size: '26px', aspectMode: 'fit', flex: 0 },
      { ...label, flex: 1, gravity: 'center' },
    ],
  };
}

function body(text, opts = {}) {
  return { type: 'text', text, size: opts.size || 'md', color: opts.color || C.text, wrap: true, ...opts.extra };
}

function muted(text) {
  return { type: 'text', text, size: 'sm', color: C.muted, wrap: true };
}

/** An outlined, rounded button. Boxes support borders; the button component does not. */
function button(label, action, style = 'primary') {
  const primary = style === 'primary';
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    backgroundColor: primary ? C.button : C.card,
    borderWidth: '2px',
    borderColor: C.stroke,
    cornerRadius: '14px',
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingStart: '8px',
    paddingEnd: '8px',
    justifyContent: 'center',
    action,
    contents: [{ type: 'text', text: label, align: 'center', weight: 'bold', size: 'sm', color: primary ? C.buttonText : C.title, wrap: true }],
  };
}

function uriAction(label, uri) {
  return { type: 'uri', label, uri };
}

export function postbackAction(label, data, displayText) {
  return { type: 'postback', label, data, displayText };
}

/**
 * One stroked card. The bubble's own background is the stroke colour and the
 * inner box is inset by the stroke width, which draws a clean outline that
 * follows LINE's bubble rounding. The footer lives inside the same frame.
 */
function bubble({ contents, footer, size = 'mega' }) {
  const inner = [...contents];
  if (footer?.length) {
    // The filler pushes the buttons to the bottom, so bubbles side by side in
    // a carousel keep their buttons on one line.
    inner.push({ type: 'filler' }, { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: footer });
  }
  return {
    type: 'bubble',
    size,
    styles: { body: { backgroundColor: C.stroke } },
    body: {
      // Horizontal so the single child is stretched to the full bubble height:
      // carousel bubbles are all as tall as the tallest one, and the cream card
      // must follow, or the dark frame shows through underneath.
      type: 'box',
      layout: 'horizontal',
      paddingAll: '3px',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          flex: 1,
          spacing: 'sm',
          paddingAll: '18px',
          backgroundColor: C.card,
          cornerRadius: '15px',
          contents: inner,
        },
      ],
    },
  };
}

/** The inner card box of a bubble built by bubble(). Used by tests. */
export function cardOf(bubbleObj) {
  return bubbleObj.body.contents[0];
}

// -------------------------------------------------------------- files

export const LINK_MIME = 'text/uri-list';

function fileSubtitle(file) {
  const bits = [];
  if (file.day) bits.push(file.day);
  if (file.isLink && file.host) bits.push(file.host);
  else if (file.size) bits.push(humanSize(file.size));
  return bits.join(' · ');
}

/** Emoji by file type, for cards without a picture. */
export function fileIcon(file) {
  const m = (file?.mimeType || '').toLowerCase();
  if (file?.isLink || m === LINK_MIME) return '🔗';
  if (m.startsWith('image/')) return '🖼️';
  if (m.startsWith('video/')) return '🎬';
  if (m.startsWith('audio/')) return '🎙️';
  if (m === 'application/pdf') return '📄';
  if (/\.md$/i.test(file?.name || '') || m === 'text/markdown') return '📝';
  return '📎';
}

/** Drawn icon name by file type (see assets/icons-src). */
export function fileIconName(file) {
  const m = (file?.mimeType || '').toLowerCase();
  if (file?.isLink || m === LINK_MIME) return 'link';
  if (m.startsWith('image/')) return 'gallery';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (/\.md$/i.test(file?.name || '') || m === 'text/markdown') return 'note';
  return 'clip';
}

function heroImage(url) {
  return { type: 'image', url, size: 'full', aspectRatio: '4:3', aspectMode: 'cover', margin: 'md' };
}

/** Picture area of a file card: the thumbnail, or a drawn placeholder of the same shape. */
function fileHero(file) {
  const url = file.thumbUrl || iconUrl(`ph-${fileIconName(file)}`);
  if (!url) return null;
  return { ...heroImage(url), action: file.webViewLink ? uriAction('เปิด', file.webViewLink) : undefined };
}

export function fileBubble(file, { title, uniform = false } = {}) {
  const contents = [];
  if (title) contents.push(heading(title));
  const hero = fileHero(file);
  if (hero) contents.push(hero);
  const name = file.caption || file.name;
  contents.push(body(`${hero ? '' : fileIcon(file) + ' '}${name}`, { extra: { weight: 'bold', margin: 'md', ...(uniform ? { maxLines: 2 } : {}) } }));
  if (file.caption && file.caption !== file.name) contents.push({ ...muted(file.name), ...(uniform ? { maxLines: 1 } : {}) });
  const sub = fileSubtitle(file);
  if (sub) contents.push(muted(sub));
  const open = file.isLink ? 'เปิดลิงก์' : 'เปิดไฟล์';
  return bubble({
    contents,
    footer: [button(open, uriAction(open, file.webViewLink))],
  });
}

/** A saved link, shaped like a file so it can share cards, lists and search. */
export function linkAsFile(link) {
  return {
    id: `link:${link.id}`,
    linkId: link.id,
    isLink: true,
    name: link.title || link.url,
    mimeType: LINK_MIME,
    webViewLink: link.url,
    day: link.day,
    at: link.at,
    host: link.host,
    caption: link.caption || '',
  };
}

export function fileCard(file, opts) {
  return flexMessage(`${opts?.title ? opts.title + ' ' : ''}${file.name}`, fileBubble(file, opts));
}

export function filesCarousel(files, { title } = {}) {
  // Same layout in every bubble (no heading, clamped text) so the row lines up.
  const bubbles = files.slice(0, 10).map((f) => fileBubble(f, { uniform: true }));
  const alt = `${title || 'ไฟล์'}: ${files.map((f) => f.name).join(', ')}`;
  return flexMessage(alt, bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles });
}

// ---------------------------------------------------------- reminders

export function reminderCard(reminder, { timeZone, now, title = '⏰ ตั้งเตือนให้แล้ว' } = {}) {
  const when = describeWhen(reminder.at, timeZone, now);
  const repeat = describeRepeat(reminder.repeat);
  const contents = [
    heading(title),
    body(reminder.text, { extra: { margin: 'md' } }),
    muted(repeat ? `${repeat} ${when}` : when),
  ];
  const footer = [
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        button('เปลี่ยนเวลา', postbackAction('เปลี่ยนเวลา', `action=reschedule&id=${reminder.id}`, 'เปลี่ยนเวลาเตือน')),
        button('ยกเลิก', postbackAction('ยกเลิก', `action=cancel&id=${reminder.id}`, 'ยกเลิกการเตือน')),
      ],
    },
    {
      type: 'text',
      text: 'เปิดดูการเตือนทั้งหมด',
      size: 'sm',
      color: C.link,
      align: 'center',
      decoration: 'underline',
      margin: 'md',
      action: postbackAction('ดูการเตือนทั้งหมด', 'action=list_reminders', 'ดูการเตือนทั้งหมด'),
    },
  ];
  return flexMessage(`${title}: ${reminder.text} ${repeat ? repeat + ' ' : ''}${when}`, bubble({ contents, footer }));
}

/** Urgency colour for a time: red within a day, orange within 3 days, olive otherwise. */
function urgencyColor(atIso, now = new Date()) {
  const hours = (new Date(atIso).getTime() - now.getTime()) / 3_600_000;
  if (hours <= 24) return '#B5482F';
  if (hours <= 72) return '#C98A2B';
  return '#6F7658';
}

export function reminderListCard(reminders, { timeZone, now = new Date(), deadlineAlerts = 0 } = {}) {
  const rows = reminders.length === 0
    ? [muted('ยังไม่มีการเตือนเลย บอกได้เลยว่าให้เตือนอะไรตอนไหน')]
    : reminders.slice(0, 12).map((r) => {
      const color = urgencyColor(r.at, now);
      return {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'md',
        paddingAll: '10px',
        backgroundColor: C.cardAlt,
        borderWidth: '2px',
        borderColor: C.stroke,
        cornerRadius: '12px',
        contents: [
          { type: 'box', layout: 'vertical', width: '6px', backgroundColor: color, cornerRadius: '3px', contents: [{ type: 'filler' }] },
          {
            type: 'box',
            layout: 'vertical',
            flex: 5,
            contents: [
              body(r.text, { size: 'sm', extra: { weight: 'bold' } }),
              { type: 'text', text: `${describeRepeat(r.repeat)} ${describeWhen(r.at, timeZone, now)}`.trim(), size: 'xs', color, wrap: true },
            ],
          },
          {
            type: 'text',
            text: 'ยกเลิก',
            size: 'xs',
            color: C.link,
            align: 'end',
            gravity: 'center',
            decoration: 'underline',
            flex: 2,
            action: postbackAction('ยกเลิก', `action=cancel&id=${r.id}`, `ยกเลิกเตือน: ${r.text}`.slice(0, 300)),
          },
        ],
      };
    });
  const contents = [heading('⏰ การเตือนทั้งหมด'), ...rows];
  if (reminders.length > 12) contents.push(muted(`และอีก ${reminders.length - 12} รายการ`));
  if (deadlineAlerts > 0) {
    // Deadline alerts live with their deadline, not in this list.
    contents.push({
      type: 'text', text: `+ เตือน deadline อีก ${deadlineAlerts} ครั้ง ดูที่เมนู Deadline`, size: 'xs', color: C.link,
      decoration: 'underline', wrap: true, margin: 'lg',
      action: postbackAction('ดู deadline', 'action=opp_list', 'ดู deadline ทั้งหมด'),
    });
  }
  return flexMessage(`การเตือนทั้งหมด ${reminders.length} รายการ`, bubble({ contents, size: 'mega' }));
}

/** The message pushed when a reminder fires: snooze / done buttons. */
export function dueReminderCard(reminder, { userName, timeZone, now } = {}) {
  const who = userName ? `${userName} ` : '';
  const repeat = describeRepeat(reminder.repeat);
  const contents = [
    heading('⏰ ถึงเวลาแล้ว'),
    body(`${who}ถึงเวลา${reminder.text}แล้วนะ`, { extra: { margin: 'md' } }),
  ];
  if (repeat) contents.push(muted(`${repeat} · ครั้งต่อไป ${describeWhen(reminder.at, timeZone, now)}`));
  const data = (min) => `action=snooze&min=${min}&id=${reminder.id}`;
  const footer = [
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        button('เลื่อน 10 นาที', postbackAction('เลื่อน 10 นาที', data(10), 'เลื่อน 10 นาที')),
        button('เลื่อน 1 ชม.', postbackAction('เลื่อน 1 ชม.', data(60), 'เลื่อน 1 ชั่วโมง')),
      ],
    },
    {
      type: 'text',
      text: 'เสร็จแล้ว ✓',
      size: 'sm',
      color: C.link,
      align: 'center',
      decoration: 'underline',
      margin: 'md',
      action: postbackAction('เสร็จแล้ว', `action=done&id=${reminder.id}`, 'เสร็จแล้ว'),
    },
  ];
  return flexMessage(`⏰ ${who}ถึงเวลา${reminder.text}แล้วนะ`, bubble({ contents, footer }));
}

// ------------------------------------------------------ opportunities

const TONE = {
  red: '#B5482F', orange: '#C98A2B', olive: '#6F7658', applied: '#8B9270', past: '#A39E90', none: '#8A8A8A',
};
const THAI_DAYS_SHORT = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์'];

/**
 * How a deadline reads at a glance: badge colour, big day number, month, and
 * the countdown line ("วันนี้วันสุดท้าย!", "อีก 3 วัน", "หมดเขตแล้ว").
 */
export function deadlineView(o, timeZone, now = new Date()) {
  if (!o.deadline) {
    return { color: o.status === 'applied' ? TONE.applied : TONE.none, day: '?', month: 'ไม่ระบุ', countdown: o.status === 'applied' ? '✓ สมัครแล้ว' : 'ไม่ระบุวันปิดรับ', days: null };
  }
  const [y, m, d] = o.deadline.split('-').map(Number);
  const days = daysUntil(o.deadline, timeZone, now);
  const thisYear = Number(todayIso(now, timeZone).slice(0, 4));
  const month = THAI_MONTHS[m - 1] + (y !== thisYear ? ` ${String(y + 543).slice(-2)}` : '');
  const view = { day: String(d), month, days };
  if (o.status === 'applied') return { ...view, color: TONE.applied, countdown: '✓ สมัครแล้ว' };
  if (days < 0) return { ...view, color: TONE.past, countdown: 'หมดเขตแล้ว' };
  if (days === 0) return { ...view, color: TONE.red, countdown: 'วันนี้วันสุดท้าย!' };
  if (days === 1) return { ...view, color: TONE.red, countdown: 'พรุ่งนี้วันสุดท้าย' };
  if (days <= 3) return { ...view, color: TONE.red, countdown: `อีก ${days} วัน` };
  if (days <= 7) return { ...view, color: TONE.orange, countdown: `อีก ${days} วัน` };
  return { ...view, color: TONE.olive, countdown: `อีก ${days} วัน` };
}

/** "อังคาร 7 ต.ค. 2569" */
export function thaiFullDate(dateIso) {
  if (!dateIso) return '';
  const [y, m, d] = dateIso.split('-').map(Number);
  const wd = THAI_DAYS_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${d} ${THAI_MONTHS[m - 1]} ${y + 543}`;
}

/** Calendar-page badge: big day number over the month, filled with the urgency colour. */
function dateBadge(v, { big = false } = {}) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    width: big ? '76px' : '58px',
    backgroundColor: v.color,
    cornerRadius: '12px',
    borderWidth: '2px',
    borderColor: C.stroke,
    paddingAll: big ? '8px' : '5px',
    justifyContent: 'center',
    contents: [
      { type: 'text', text: v.day, size: big ? '3xl' : 'xxl', weight: 'bold', color: '#FFFFFF', align: 'center' },
      { type: 'text', text: v.month, size: 'xs', weight: 'bold', color: '#FFFFFF', align: 'center' },
    ],
  };
}

/** Small outlined pill button for inside a row. */
function chip(label, action, { filled = false } = {}) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    width: '46px',
    paddingAll: '3px',
    cornerRadius: '10px',
    borderWidth: '2px',
    borderColor: C.stroke,
    backgroundColor: filled ? C.button : C.card,
    action,
    contents: [{ type: 'text', text: label, size: 'xs', weight: 'bold', color: filled ? C.buttonText : C.title, align: 'center' }],
  };
}

/** "เตือนล่วงหน้า 7 · 3 · 1 วัน + วันสุดท้าย เวลา 09:00 น." or "ไม่เตือน" when switched off. */
export function alertsPhrase(alerts) {
  const a = normalizeAlerts(alerts);
  if (a.days.length === 0) return 'ไม่เตือน';
  return `เตือน${describeAlerts(a).replace(/^ก่อน/, 'ล่วงหน้า')}`;
}

const shortTitle = (t, n = 40) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));
const kindLine = (o) => [KIND_THAI[o.kind] || KIND_THAI.other, o.organizer].filter(Boolean).join(' · ');

/** "label  value" with the label muted and bold. */
function fact(label, value) {
  return {
    type: 'text',
    wrap: true,
    size: 'sm',
    color: C.text,
    contents: [
      { type: 'span', text: `${label}  `, weight: 'bold', color: C.muted },
      { type: 'span', text: String(value) },
    ],
  };
}

function textLink(text, action, extra = {}) {
  return { type: 'text', text, size: 'sm', color: C.link, decoration: 'underline', action, ...extra };
}

/** One deadline in the list: badge | title, countdown, kind + a delete pill. Tap opens the details. */
function deadlineRow(o, { timeZone, now }) {
  const v = deadlineView(o, timeZone, now);
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: 'md',
    paddingAll: '10px',
    backgroundColor: C.cardAlt,
    borderWidth: '2px',
    borderColor: C.stroke,
    cornerRadius: '14px',
    action: postbackAction('ดูรายละเอียด', `action=opp_view&id=${o.id}`, `ดู ${shortTitle(o.title, 24)}`),
    contents: [
      dateBadge(v),
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        spacing: 'xs',
        justifyContent: 'center',
        contents: [
          // Only two lines show; sending more just eats into the message size limit.
          { type: 'text', text: shortTitle(o.title, 70), size: 'sm', weight: 'bold', color: C.title, wrap: true, maxLines: 2 },
          { type: 'text', text: v.countdown, size: 'md', weight: 'bold', color: v.color },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            alignItems: 'center',
            contents: [
              { type: 'text', text: shortTitle(kindLine(o), 36), size: 'xxs', color: C.muted, flex: 1, wrap: false },
              chip('ลบ', postbackAction('ลบ', `action=opp_delete&id=${o.id}`, `ลบ ${shortTitle(o.title, 24)}`)),
            ],
          },
        ],
      },
    ],
  };
}

function sectionLabel(text) {
  return { type: 'text', text, size: 'xs', weight: 'bold', color: C.muted, margin: 'lg' };
}

const MAX_LIST_ROWS = 10;

/**
 * The deadline list: open items soonest first, then undated, applied and a
 * few just-closed ones. Each row has a date badge, the countdown and a delete
 * pill; tapping a row opens its details.
 */
export function opportunityListCard(list, { timeZone, now = new Date(), alerts } = {}) {
  const g = groupForList(list, timeZone, now);
  const contents = [heading('🎯 Deadline ทั้งหมด')];
  const open = g.upcoming.length + g.undated.length;
  if (list.length === 0) {
    contents.push(muted('ยังไม่มีรายการเลย ส่งโปสเตอร์หรือลิงก์รับสมัครมาได้เลย เดี๋ยวจดให้'));
  } else {
    contents.push(muted(`เปิดรับอยู่ ${open} รายการ · ${alertsPhrase(alerts)}`));
  }
  let shown = 0;
  const sections = [
    ['', g.upcoming], ['ยังไม่ระบุวันปิดรับ', g.undated], ['สมัครแล้ว', g.applied], ['หมดเขตแล้ว', g.past],
  ];
  for (const [label, items] of sections) {
    const room = MAX_LIST_ROWS - shown;
    if (items.length === 0 || room <= 0) continue;
    if (label) contents.push(sectionLabel(label));
    for (const o of items.slice(0, room)) contents.push(deadlineRow(o, { timeZone, now }));
    shown += Math.min(items.length, room);
  }
  const total = g.upcoming.length + g.undated.length + g.applied.length + g.past.length;
  const hidden = total - shown + g.hiddenPast;
  if (hidden > 0) contents.push({ ...muted(`และอีก ${hidden} รายการ (ดูทั้งหมดใน Opportunities.md)`), margin: 'md' });
  const footer = [button('ตั้งเวลาเตือน', postbackAction('ตั้งเวลาเตือน', 'action=alerts_menu', 'ตั้งเวลาเตือน deadline'), 'secondary')];
  return flexMessage(`Deadline ทั้งหมด ${list.length} รายการ`, bubble({ contents, footer, size: 'mega' }));
}

/**
 * Details of one deadline. `merged` adds "not the same? split" and
 * `suggestion` ({ id, title }) adds "same as this one? merge".
 */
export function opportunityBubble(o, { timeZone, now = new Date(), title = '🎯 บันทึกไว้แล้ว', alerts, merged = false, suggestion = null } = {}) {
  const v = deadlineView(o, timeZone, now);
  const when = o.deadline ? `หมดเขต ${thaiFullDate(o.deadline)}${o.deadline_note ? ' · ' + o.deadline_note : ''}` : 'ยังไม่รู้วันปิดรับ';
  const alertLine = o.deadline && o.status !== 'applied' && v.days >= 0 ? alertsPhrase(alertsFor(o, alerts)) : '';
  const contents = [heading(title)];
  if (o.thumbUrl) contents.push({ ...heroImage(o.thumbUrl), action: uriAction('เปิด', o.link || o.source?.webViewLink || o.thumbUrl) });
  contents.push({
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: 'lg',
    contents: [
      dateBadge(v, { big: true }),
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        justifyContent: 'center',
        spacing: 'xs',
        contents: [
          { type: 'text', text: v.countdown, size: 'xl', weight: 'bold', color: v.color, wrap: true },
          { type: 'text', text: when, size: 'xs', color: C.text, wrap: true },
          ...(alertLine ? [{ type: 'text', text: alertLine, size: 'xxs', color: C.muted, wrap: true }] : []),
        ],
      },
    ],
  });
  contents.push(body(o.title, { extra: { weight: 'bold', margin: 'lg' } }));
  contents.push(muted(kindLine(o)));
  const facts = [
    ['วันจัด', o.event_dates], ['ใครสมัครได้', o.eligibility], ['ค่าใช้จ่าย/รางวัล', o.cost], ['ติดต่อ', o.contact],
  ].filter(([, val]) => val);
  if (facts.length) contents.push({ type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', contents: facts.map(([k, val]) => fact(k, val)) });
  if (o.summary) contents.push({ ...muted(o.summary), margin: 'md' });

  const openUri = o.link || o.source?.webViewLink;
  const row = [];
  if (openUri) row.push(button(o.link ? 'เปิดลิงก์' : 'เปิดโปสเตอร์', uriAction('เปิด', openUri)));
  if (o.link && o.source?.webViewLink) row.push(button('โปสเตอร์', uriAction('โปสเตอร์', o.source.webViewLink), 'secondary'));
  const footer = [];
  if (row.length) footer.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: row });
  if (o.deadline && v.days !== null && v.days >= 0) {
    footer.push(o.status === 'applied'
      ? button('ยังไม่ได้สมัคร เตือนต่อ', postbackAction('เตือนต่อ', `action=opp_unapplied&id=${o.id}`, 'ยังไม่ได้สมัคร เตือนต่อด้วย'), 'secondary')
      : button('สมัครแล้ว หยุดเตือน', postbackAction('สมัครแล้ว', `action=opp_applied&id=${o.id}`, `สมัคร ${shortTitle(o.title)} แล้ว`), 'secondary'));
  }
  footer.push({
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    spacing: 'md',
    contents: [
      textLink('ดูทั้งหมด', postbackAction('ดูทั้งหมด', 'action=opp_list', 'ดู deadline ทั้งหมด'), { flex: 0 }),
      textLink('ตั้งเตือนอันนี้', postbackAction('ตั้งเตือน', `action=alerts_menu&id=${o.id}`, 'ตั้งเตือนรายการนี้'), { flex: 1, align: 'center' }),
      textLink('ลบ', postbackAction('ลบ', `action=opp_delete&id=${o.id}`, `ลบ ${shortTitle(o.title)}`), { flex: 0, align: 'end' }),
    ],
  });
  if (merged) {
    footer.push(textLink('ไม่ใช่งานเดียวกัน? แยกเป็นอันใหม่', postbackAction('แยก', `action=opp_split&id=${o.id}`, 'ไม่ใช่งานเดียวกัน แยกเป็นอันใหม่'), { margin: 'md', align: 'center', size: 'xs', wrap: true }));
  } else if (suggestion?.id) {
    footer.push(textLink(`เป็นงานเดียวกับ "${shortTitle(suggestion.title, 28)}"? รวมเลย`, postbackAction('รวม', `action=opp_merge&id=${suggestion.id}&src=${o.id}`, 'รวมเป็นรายการเดียวกัน'), { margin: 'md', align: 'center', size: 'xs', wrap: true }));
  }
  return bubble({ contents, footer });
}

export function opportunityCard(o, opts = {}) {
  const v = deadlineView(o, opts.timeZone, opts.now);
  return flexMessage(`${opts.title || '🎯'} ${o.title} · ${v.countdown}`, opportunityBubble(o, opts));
}

/** What an alert looks like when it fires: the deadline, big, with "applied" right there. */
export function deadlineAlertBubble(o, { timeZone, now = new Date() } = {}) {
  const v = deadlineView(o, timeZone, now);
  const openUri = o.link || o.source?.webViewLink;
  const footer = [];
  if (openUri) footer.push(button(o.link ? 'เปิดลิงก์สมัคร' : 'เปิดโปสเตอร์', uriAction('เปิด', openUri)));
  footer.push(button('สมัครแล้ว หยุดเตือน', postbackAction('สมัครแล้ว', `action=opp_applied&id=${o.id}`, `สมัคร ${shortTitle(o.title)} แล้ว`), 'secondary'));
  footer.push({
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    contents: [
      textLink('รายละเอียด', postbackAction('รายละเอียด', `action=opp_view&id=${o.id}`, `ดู ${shortTitle(o.title)}`), { flex: 1 }),
      textLink('ดูทั้งหมด', postbackAction('ดูทั้งหมด', 'action=opp_list', 'ดู deadline ทั้งหมด'), { flex: 1, align: 'end' }),
    ],
  });
  return bubble({
    contents: [
      heading('⏰ ใกล้หมดเขตแล้ว'),
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        margin: 'lg',
        contents: [
          dateBadge(v, { big: true }),
          {
            type: 'box',
            layout: 'vertical',
            flex: 1,
            justifyContent: 'center',
            spacing: 'xs',
            contents: [
              { type: 'text', text: v.countdown, size: 'xl', weight: 'bold', color: v.color, wrap: true },
              { type: 'text', text: o.deadline ? `หมดเขต ${thaiFullDate(o.deadline)}${o.deadline_note ? ' · ' + o.deadline_note : ''}` : '', size: 'xs', color: C.text, wrap: true },
            ].filter((c) => c.text),
          },
        ],
      },
      body(o.title, { extra: { weight: 'bold', margin: 'lg' } }),
      muted(kindLine(o)),
    ],
    footer,
  });
}

/** Alerts due together go out as one message (one push counts once against LINE's quota). */
export function deadlineAlertsMessage(opps, { timeZone, now = new Date() } = {}) {
  const bubbles = opps.slice(0, 12).map((o) => deadlineAlertBubble(o, { timeZone, now }));
  const alt = opps.map((o) => `${o.title} ${deadlineView(o, timeZone, now).countdown}`).join(' · ');
  return flexMessage(`⏰ ${alt}`, bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles });
}

const PRESET_LABEL = { std: 'ก่อน 7 · 3 · 1 วัน + วันสุดท้าย', early: 'ก่อน 14 · 7 · 3 · 1 วัน + วันสุดท้าย', light: 'ก่อน 3 · 1 วัน + วันสุดท้าย' };

/**
 * Pick when deadline alerts go out. For the whole chat (presets + time of
 * day), or for one item when `opp` is given (presets + back to default / off).
 */
export function alertSettingsCard(alerts, { opp = null } = {}) {
  const base = normalizeAlerts(alerts);
  const current = opp ? alertsFor(opp, base) : base;
  const same = (days) => days.length === current.days.length && days.every((d, i) => d === current.days[i]);
  const idPart = opp ? `&id=${opp.id}` : '';
  const contents = [
    heading(opp ? '⏰ เตือนรายการนี้' : '⏰ ตั้งเวลาเตือน deadline'),
    ...(opp ? [body(opp.title, { size: 'sm', extra: { weight: 'bold', margin: 'md' } })] : []),
    body(`ตอนนี้: ${describeAlerts(current)}`, { size: 'sm', extra: { margin: 'md' } }),
    muted(opp
      ? 'เลือกแบบด้านล่าง ใช้กับรายการนี้รายการเดียว'
      : 'เลือกแบบด้านล่าง หรือพิมพ์เอง เช่น "เตือน deadline ก่อน 10 5 2 1 วัน 20:00"'),
  ];
  const footer = ALERT_PRESETS.map((p) => button(
    PRESET_LABEL[p.key],
    postbackAction(PRESET_LABEL[p.key].slice(0, 20), `action=alerts_set&p=${p.key}${idPart}`, `เตือน ${PRESET_LABEL[p.key]}`),
    same(p.days) ? 'primary' : 'secondary',
  ));
  if (opp) {
    footer.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      contents: [
        textLink('ใช้แบบเดียวกับทั้งหมด', postbackAction('แบบปกติ', `action=alerts_reset${idPart}`, 'ใช้การเตือนแบบปกติ'), { flex: 1 }),
        textLink('ไม่ต้องเตือน', postbackAction('ไม่ต้องเตือน', `action=alerts_off${idPart}`, 'ไม่ต้องเตือนรายการนี้'), { flex: 0, align: 'end' }),
      ],
    });
  } else {
    footer.push({ type: 'text', text: 'เวลาที่เตือน', size: 'xs', weight: 'bold', color: C.muted, margin: 'lg' });
    footer.push({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: ALERT_TIMES.map((t) => button(t, postbackAction(t, `action=alerts_time&t=${t.replace(':', '')}`, `เตือนเวลา ${t}`), t === current.time ? 'primary' : 'secondary')),
    });
    footer.push(textLink(current.days.length ? 'ปิดการเตือน deadline' : 'เปิดการเตือนแบบปกติ',
      postbackAction('ปิด/เปิด', current.days.length ? 'action=alerts_off' : 'action=alerts_set&p=std', current.days.length ? 'ปิดการเตือน deadline' : 'เปิดการเตือน deadline'),
      { margin: 'md', align: 'center', size: 'xs' }));
  }
  return flexMessage(`ตั้งเวลาเตือน: ${describeAlerts(current)}`, bubble({ contents, footer }));
}

/** After "applied": confirmation with a way back. */
export function appliedCard(o) {
  return flexMessage(`สมัคร ${o.title} แล้ว หยุดเตือนให้แล้ว`, bubble({
    contents: [heading('✅ สมัครแล้ว'), body(o.title, { size: 'sm', extra: { weight: 'bold', margin: 'md' } }), muted('หยุดเตือนรายการนี้แล้ว เก่งมาก!')],
    footer: [button('ยังไม่ได้สมัคร เตือนต่อ', postbackAction('เตือนต่อ', `action=opp_unapplied&id=${o.id}`, 'ยังไม่ได้สมัคร เตือนต่อด้วย'), 'secondary')],
  }));
}

/** After a delete: what went, and undo. */
export function deletedCard(o) {
  return flexMessage(`ลบ ${o.title} แล้ว`, bubble({
    contents: [heading('🗑️ ลบแล้ว'), body(o.title, { size: 'sm', extra: { weight: 'bold', margin: 'md' } }), muted('ยกเลิกการเตือนและลบจากปฏิทินให้แล้ว')],
    footer: [button('เอาคืน', postbackAction('เอาคืน', `action=opp_restore&id=${o.id}`, `เอา ${shortTitle(o.title)} คืน`), 'secondary')],
  }));
}

export function scanOfferCard(fileId) {
  return flexMessage('อยากให้เช็ค deadline ในนี้ไหม', bubble({
    contents: [heading('🎯 ดูเหมือนโปสเตอร์รับสมัคร'), muted('ให้อ่านแล้วจด deadline กับรายละเอียดไว้ไหม (ใช้ AI 1 ครั้ง)')],
    footer: [button('อ่านและจดให้', postbackAction('อ่านและจดให้', `action=scan&file=${fileId}`, 'อ่านและจด deadline ให้หน่อย'))],
  }));
}

// ----------------------------------------------------------- calendar

export function eventCard(event, { timeZone } = {}) {
  const when = event.allDay
    ? `${event.start} (ทั้งวัน)`
    : `${describeWhen(event.start, timeZone)}${event.end ? ' - ' + timeOnly(event.end, timeZone) : ''}`;
  const contents = [heading('📅 ลงปฏิทินให้แล้ว'), body(event.title, { extra: { margin: 'md' } }), muted(when)];
  const footer = event.link ? [button('เปิดปฏิทิน', uriAction('เปิดปฏิทิน', event.link))] : [];
  return flexMessage(`ลงปฏิทิน: ${event.title} ${when}`, bubble({ contents, footer }));
}

// ------------------------------------------------------------ generic

export function infoCard(title, lines, { buttons = [] } = {}) {
  const contents = [heading(title), ...lines.map((l) => (typeof l === 'string' ? body(l, { size: 'sm' }) : l))];
  return flexMessage(`${title}: ${lines.filter((l) => typeof l === 'string').join(' ')}`.slice(0, 400), bubble({ contents, footer: buttons }));
}

export function linkButton(label, uri) {
  return button(label, uriAction(label, uri));
}

export function postbackButton(label, data, displayText) {
  return button(label, postbackAction(label, data, displayText));
}

// ------------------------------------------------------------- utils

function timeOnly(iso, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) + ' น.';
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
