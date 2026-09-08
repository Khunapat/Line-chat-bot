/**
 * LINE Flex Message builders. Visual style: warm beige cards with olive
 * buttons, dark rounded text - a friendly "notebook" look.
 */
import { describeWhen, describeRepeat } from './reminders.js';

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

export function textMessage(text) {
  return { type: 'text', text: String(text).slice(0, 5000) };
}

export function flexMessage(altText, contents) {
  return { type: 'flex', altText: String(altText).slice(0, 400), contents };
}

// ------------------------------------------------------------- pieces

function heading(text) {
  return { type: 'text', text, weight: 'bold', size: 'md', color: C.title, wrap: true };
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
function bubble({ contents, footer, size = 'kilo' }) {
  const inner = [...contents];
  if (footer?.length) {
    inner.push({ type: 'box', layout: 'vertical', spacing: 'sm', margin: 'lg', contents: footer });
  }
  return {
    type: 'bubble',
    size,
    styles: { body: { backgroundColor: C.stroke } },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '3px',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
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

function fileSubtitle(file) {
  const bits = [];
  if (file.day) bits.push(file.day);
  if (file.size) bits.push(humanSize(file.size));
  return bits.join(' · ');
}

export function fileBubble(file, { title } = {}) {
  const contents = [];
  if (title) contents.push(heading(title));
  contents.push(body(file.name, { extra: { weight: 'bold' } }));
  const sub = fileSubtitle(file);
  if (sub) contents.push(muted(sub));
  return bubble({
    contents,
    footer: [button('เปิดไฟล์', uriAction('เปิดไฟล์', file.webViewLink))],
  });
}

export function fileCard(file, opts) {
  return flexMessage(`${opts?.title ? opts.title + ' ' : ''}${file.name}`, fileBubble(file, opts));
}

export function filesCarousel(files, { title } = {}) {
  const bubbles = files.slice(0, 10).map((f, i) => fileBubble(f, { title: i === 0 ? title : undefined }));
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

export function reminderListCard(reminders, { timeZone, now } = {}) {
  const rows = reminders.length === 0
    ? [muted('ยังไม่มีการเตือนเลย บอกได้เลยว่าให้เตือนอะไรตอนไหน')]
    : reminders.map((r) => ({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      margin: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          flex: 5,
          contents: [
            body(r.text, { size: 'sm', extra: { weight: 'bold' } }),
            muted(`${describeRepeat(r.repeat)} ${describeWhen(r.at, timeZone, now)}`.trim()),
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
    }));
  const contents = [heading('⏰ การเตือนทั้งหมด'), ...rows];
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
