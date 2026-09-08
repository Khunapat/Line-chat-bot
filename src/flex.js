/**
 * LINE Flex Message builders. Visual style: warm beige cards with olive
 * buttons, dark rounded text - a friendly "notebook" look.
 */
import { describeWhen, describeRepeat } from './reminders.js';
import { describeDeadline, daysUntil, KIND_THAI } from './opportunities.js';

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

export function reminderListCard(reminders, { timeZone, now = new Date() } = {}) {
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

function deadlineColor(o, timeZone, now) {
  if (!o.deadline) return C.muted;
  const d = daysUntil(o.deadline, timeZone, now);
  if (d < 0) return C.muted;
  if (d <= 3) return '#B5482F';
  if (d <= 7) return '#C98A2B';
  return '#6F7658';
}

export function opportunityBubble(o, { timeZone, now, title = '🎯 บันทึกไว้แล้ว' } = {}) {
  const contents = [
    heading(title),
    ...(o.thumbUrl ? [{ ...heroImage(o.thumbUrl), action: uriAction('เปิด', o.link || o.source?.webViewLink || o.thumbUrl) }] : []),
    body(`${o.thumbUrl ? '' : (o.source?.kind === 'link' ? '🔗 ' : '')}${o.title}`, { extra: { weight: 'bold', margin: 'md' } }),
    muted(`${KIND_THAI[o.kind] || 'อื่น ๆ'}${o.organizer ? ' · ' + o.organizer : ''}`),
    {
      type: 'text',
      text: `⏳ หมดเขต ${describeDeadline(o.deadline, timeZone, now)}${o.deadline_note ? ' ' + o.deadline_note : ''}`,
      size: 'sm',
      weight: 'bold',
      color: deadlineColor(o, timeZone, now),
      wrap: true,
      margin: 'md',
    },
  ];
  const facts = [
    o.event_dates && `📅 ${o.event_dates}`,
    o.eligibility && `👤 ${o.eligibility}`,
    o.cost && `💸 ${o.cost}`,
    o.contact && `📞 ${o.contact}`,
  ].filter(Boolean);
  for (const f of facts) contents.push(body(f, { size: 'sm' }));
  if (o.summary) contents.push(muted(o.summary));

  const openUri = o.link || o.source?.webViewLink;
  const row = [];
  if (openUri) row.push(button(o.link ? 'เปิดลิงก์' : 'เปิดโปสเตอร์', uriAction('เปิด', openUri)));
  if (o.link && o.source?.webViewLink) row.push(button('โปสเตอร์', uriAction('โปสเตอร์', o.source.webViewLink), 'secondary'));
  const footer = [];
  if (row.length) footer.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: row });
  footer.push({
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    contents: [
      { type: 'text', text: 'ดู deadline ทั้งหมด', size: 'sm', color: C.link, decoration: 'underline', flex: 3, action: postbackAction('ดูทั้งหมด', 'action=opp_list', 'ดู deadline ทั้งหมด') },
      { type: 'text', text: 'ไม่ใช่ ลบ', size: 'sm', color: C.link, align: 'end', decoration: 'underline', flex: 2, action: postbackAction('ลบ', `action=opp_delete&id=${o.id}`, `ลบ: ${o.title}`.slice(0, 300)) },
    ],
  });
  return bubble({ contents, footer });
}

export function opportunityCard(o, opts) {
  return flexMessage(`${opts?.title || '🎯'} ${o.title} · หมดเขต ${describeDeadline(o.deadline, opts?.timeZone, opts?.now)}`, opportunityBubble(o, opts));
}

export function opportunityListCard(list, { timeZone, now } = {}) {
  const rows = list.length === 0
    ? [muted('ยังไม่มีรายการเลย ส่งโปสเตอร์หรือลิงก์รับสมัครมาได้เลย เดี๋ยวจดให้')]
    : list.slice(0, 10).map((o) => {
      const color = deadlineColor(o, timeZone, now);
      const link = o.link || o.source?.webViewLink;
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
        action: link ? uriAction('เปิด', link) : undefined,
        contents: [
          { type: 'box', layout: 'vertical', width: '6px', backgroundColor: color, cornerRadius: '3px', contents: [{ type: 'filler' }] },
          {
            type: 'box',
            layout: 'vertical',
            flex: 1,
            contents: [
              body(o.title, { size: 'sm', extra: { weight: 'bold' } }),
              { type: 'text', text: `${describeDeadline(o.deadline, timeZone, now)} · ${KIND_THAI[o.kind] || ''}`, size: 'xs', color, wrap: true },
            ],
          },
        ],
      };
    });
  const contents = [heading('🎯 Deadline ทั้งหมด'), ...rows];
  if (list.length > 10) contents.push(muted(`และอีก ${list.length - 10} รายการใน Opportunities.md`));
  return flexMessage(`Deadline ทั้งหมด ${list.length} รายการ`, bubble({ contents, size: 'mega' }));
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
