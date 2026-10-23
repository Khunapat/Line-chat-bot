/**
 * LINE Flex Message builders. Visual style: warm beige cards with olive
 * buttons, dark rounded text - a friendly "notebook" look.
 */
import { describeWhen, describeRepeat } from './reminders.js';
import { daysUntil, todayIso } from './opportunities.js';
import {
  ALERT_PRESETS, ALERT_TIMES, normalizeAlerts, alertsFor, describeAlerts, groupForList,
} from './deadlines.js';
import { L, currentLang } from './lang.js';
import { formatDay, formatTime, diffDays, zoned } from '../web/shared/dates.js';
import { formatMoney, formatPrice } from '../web/shared/money.js';
import { monthlyTotals } from './subscriptions.js';

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
  '🗑️': 'trash', '🗑': 'trash', '💳': 'card',
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
  return { ...heroImage(url), action: file.webViewLink ? uriAction(L('b_open'), file.webViewLink) : undefined };
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
  const open = file.isLink ? L('b_openLink') : L('b_openFile');
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
  const alt = `${title || L('b_files')}: ${files.map((f) => f.name).join(', ')}`;
  return flexMessage(alt, bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles });
}

// ---------------------------------------------------------- reminders

export function reminderCard(reminder, { timeZone, now, title = L('b_reminderSet') } = {}) {
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
        button(L('b_changeTime'), postbackAction(L('b_changeTime'), `action=reschedule&id=${reminder.id}`, L('b_changeTimeSaid'))),
        button(L('b_cancel'), postbackAction(L('b_cancel'), `action=cancel&id=${reminder.id}`, L('b_cancelSaid'))),
      ],
    },
    {
      type: 'text',
      text: L('b_seeAllRem'),
      size: 'sm',
      color: C.link,
      align: 'center',
      decoration: 'underline',
      margin: 'md',
      action: postbackAction(L('b_seeAllRemSaid').slice(0, 20), 'action=list_reminders', L('b_seeAllRemSaid')),
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
    ? [muted(L('b_noReminders'))]
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
            text: L('b_cancel'),
            size: 'xs',
            color: C.link,
            align: 'end',
            gravity: 'center',
            decoration: 'underline',
            flex: 2,
            action: postbackAction(L('b_cancel'), `action=cancel&id=${r.id}`, L('b_cancelNamed', { text: r.text }).slice(0, 300)),
          },
        ],
      };
    });
  const contents = [heading(L('b_allReminders')), ...rows];
  if (reminders.length > 12) contents.push(muted(L('b_andMore', { n: reminders.length - 12 })));
  if (deadlineAlerts > 0) {
    // Deadline alerts live with their deadline, not in this list.
    contents.push({
      type: 'text', text: L('b_dlAlertsMore', { n: deadlineAlerts }), size: 'xs', color: C.link,
      decoration: 'underline', wrap: true, margin: 'lg',
      action: postbackAction(L('b_seeDl'), 'action=opp_list', L('b_seeAllDlSaid')),
    });
  }
  return flexMessage(L('b_remCount', { n: reminders.length }), bubble({ contents, size: 'mega' }));
}

/** The message pushed when a reminder fires: snooze / done buttons. */
export function dueReminderCard(reminder, { userName, timeZone, now } = {}) {
  const line = userName ? L('b_dueNamed', { name: userName, text: reminder.text }) : L('b_duePlain', { text: reminder.text });
  const repeat = describeRepeat(reminder.repeat);
  const contents = [
    heading(L('b_due')),
    body(line, { extra: { margin: 'md' } }),
  ];
  if (repeat) contents.push(muted(L('b_nextTime', { repeat, when: describeWhen(reminder.at, timeZone, now) })));
  const data = (min) => `action=snooze&min=${min}&id=${reminder.id}`;
  const footer = [
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        button(L('b_snooze10'), postbackAction(L('b_snooze10'), data(10), L('b_snooze10'))),
        button(L('b_snooze60'), postbackAction(L('b_snooze60'), data(60), L('b_snooze60Said'))),
      ],
    },
    {
      type: 'text',
      text: L('b_doneCheck'),
      size: 'sm',
      color: C.link,
      align: 'center',
      decoration: 'underline',
      margin: 'md',
      action: postbackAction(L('b_done'), `action=done&id=${reminder.id}`, L('b_done')),
    },
  ];
  return flexMessage(`⏰ ${line}`, bubble({ contents, footer }));
}

// ------------------------------------------------------ opportunities

const TONE = {
  red: '#B5482F', orange: '#C98A2B', olive: '#6F7658', applied: '#8B9270', past: '#A39E90', none: '#8A8A8A',
};

/**
 * How a deadline reads at a glance: badge colour, big day number, month, and
 * the countdown line ("วันนี้วันสุดท้าย!", "อีก 3 วัน", "หมดเขตแล้ว").
 */
export function deadlineView(o, timeZone, now = new Date()) {
  if (!o.deadline) {
    return { color: o.status === 'applied' ? TONE.applied : TONE.none, day: '?', month: L('b_noDateMonth'), countdown: o.status === 'applied' ? L('b_applied') : L('b_noClosing'), days: null };
  }
  const [y, m, d] = o.deadline.split('-').map(Number);
  const days = daysUntil(o.deadline, timeZone, now);
  const thisYear = Number(todayIso(now, timeZone).slice(0, 4));
  const lang = currentLang();
  const month = formatDay(o.deadline, lang, 'mon') + (y !== thisYear ? ` ${String(lang === 'en' ? y : y + 543).slice(-2)}` : '');
  const view = { day: String(d), month, days };
  if (o.status === 'applied') return { ...view, color: TONE.applied, countdown: L('b_applied') };
  if (days < 0) return { ...view, color: TONE.past, countdown: L('b_closed') };
  if (days === 0) return { ...view, color: TONE.red, countdown: L('b_lastDayToday') };
  if (days === 1) return { ...view, color: TONE.red, countdown: L('b_lastDayTomorrow') };
  if (days <= 3) return { ...view, color: TONE.red, countdown: L('b_daysLeft', { n: days }) };
  if (days <= 7) return { ...view, color: TONE.orange, countdown: L('b_daysLeft', { n: days }) };
  return { ...view, color: TONE.olive, countdown: L('b_daysLeft', { n: days }) };
}

/** "อังคาร 7 ต.ค. 2569" / "Tuesday 7 Oct 2026" in the chat's language. */
export function thaiFullDate(dateIso) {
  if (!dateIso) return '';
  const lang = currentLang();
  return `${formatDay(dateIso, lang, 'dwFull').replace('พฤหัสบดี', 'พฤหัส')} ${formatDay(dateIso, lang, 'dm')} ${formatDay(dateIso, lang, 'my').split(' ').pop()}`;
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
  if (a.days.length === 0) return L('b_noAlerts');
  const desc = describeAlerts(a);
  if (currentLang() === 'th') return /^ก่อน /.test(desc) ? L('b_alertsPhrase', { desc: desc.replace(/^ก่อน /, '') }) : `เตือน${desc}`;
  return L('b_alertsPhrase', { desc });
}

const shortTitle = (t, n = 40) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));
const kindLine = (o) => [L(`kind_${o.kind || 'other'}`), o.organizer].filter(Boolean).join(' · ');

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
    action: postbackAction(L('b_view'), `action=opp_view&id=${o.id}`, L('b_viewNamed', { title: shortTitle(o.title, 24) })),
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
              chip(L('b_delete'), postbackAction(L('b_delete'), `action=opp_delete&id=${o.id}`, L('b_deleteNamed', { title: shortTitle(o.title, 24) }))),
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
  const contents = [heading(L('b_allDl'))];
  const open = g.upcoming.length + g.undated.length;
  if (list.length === 0) {
    contents.push(muted(L('b_noDl')));
  } else {
    contents.push(muted(L('b_openCount', { n: open, alerts: alertsPhrase(alerts) })));
  }
  let shown = 0;
  const sections = [
    ['', g.upcoming], [L('b_secUndated'), g.undated], [L('b_secApplied'), g.applied], [L('b_secPast'), g.past],
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
  if (hidden > 0) contents.push({ ...muted(L('b_moreInDoc', { n: hidden })), margin: 'md' });
  const footer = [button(L('b_alertSettings'), postbackAction(L('b_alertSettings'), 'action=alerts_menu', L('b_alertSettingsSaid')), 'secondary')];
  return flexMessage(L('b_dlCount', { n: list.length }), bubble({ contents, footer, size: 'mega' }));
}

/**
 * Details of one deadline. `merged` adds "not the same? split" and
 * `suggestion` ({ id, title }) adds "same as this one? merge".
 */
export function opportunityBubble(o, { timeZone, now = new Date(), title = L('b_saved'), alerts, merged = false, suggestion = null } = {}) {
  const v = deadlineView(o, timeZone, now);
  const when = o.deadline ? `${L('b_closesOn', { date: thaiFullDate(o.deadline) })}${o.deadline_note ? ' · ' + o.deadline_note : ''}` : L('b_unknownClosing');
  const alertLine = o.deadline && o.status !== 'applied' && v.days >= 0 ? alertsPhrase(alertsFor(o, alerts)) : '';
  const contents = [heading(title)];
  if (o.thumbUrl) contents.push({ ...heroImage(o.thumbUrl), action: uriAction(L('b_open'), o.link || o.source?.webViewLink || o.thumbUrl) });
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
    [L('b_fEvent'), o.event_dates], [L('b_fElig'), o.eligibility], [L('b_fCost'), o.cost], [L('b_fContact'), o.contact],
  ].filter(([, val]) => val);
  if (facts.length) contents.push({ type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', contents: facts.map(([k, val]) => fact(k, val)) });
  if (o.summary) contents.push({ ...muted(o.summary), margin: 'md' });

  const openUri = o.link || o.source?.webViewLink;
  const row = [];
  if (openUri) row.push(button(o.link ? L('b_openLink') : L('b_openPoster'), uriAction(L('b_open'), openUri)));
  if (o.link && o.source?.webViewLink) row.push(button(L('b_poster'), uriAction(L('b_poster'), o.source.webViewLink), 'secondary'));
  const footer = [];
  if (row.length) footer.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: row });
  if (o.deadline && v.days !== null && v.days >= 0) {
    footer.push(o.status === 'applied'
      ? button(L('b_resumeLong'), postbackAction(L('b_resume'), `action=opp_unapplied&id=${o.id}`, L('b_resumeSaid')), 'secondary')
      : button(L('b_appliedStop'), postbackAction(L('b_appliedShort'), `action=opp_applied&id=${o.id}`, L('b_appliedSaid', { title: shortTitle(o.title) })), 'secondary'));
  }
  footer.push({
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    spacing: 'md',
    contents: [
      textLink(L('b_seeAll'), postbackAction(L('b_seeAll'), 'action=opp_list', L('b_seeAllDlSaid')), { flex: 0 }),
      textLink(L('b_alertThis'), postbackAction(L('b_alertThisShort'), `action=alerts_menu&id=${o.id}`, L('b_alertThisSaid')), { flex: 1, align: 'center' }),
      textLink(L('b_delete'), postbackAction(L('b_delete'), `action=opp_delete&id=${o.id}`, L('b_deleteNamed', { title: shortTitle(o.title) })), { flex: 0, align: 'end' }),
    ],
  });
  if (merged) {
    footer.push(textLink(L('b_splitLink'), postbackAction(L('b_split'), `action=opp_split&id=${o.id}`, L('b_splitSaid')), { margin: 'md', align: 'center', size: 'xs', wrap: true }));
  } else if (suggestion?.id) {
    footer.push(textLink(L('b_mergeLink', { title: shortTitle(suggestion.title, 28) }), postbackAction(L('b_merge'), `action=opp_merge&id=${suggestion.id}&src=${o.id}`, L('b_mergeSaid')), { margin: 'md', align: 'center', size: 'xs', wrap: true }));
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
  if (openUri) footer.push(button(o.link ? L('b_openApply') : L('b_openPoster'), uriAction(L('b_open'), openUri)));
  footer.push(button(L('b_appliedStop'), postbackAction(L('b_appliedShort'), `action=opp_applied&id=${o.id}`, L('b_appliedSaid', { title: shortTitle(o.title) })), 'secondary'));
  footer.push({
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    contents: [
      textLink(L('b_details'), postbackAction(L('b_details'), `action=opp_view&id=${o.id}`, L('b_viewNamed', { title: shortTitle(o.title) })), { flex: 1 }),
      textLink(L('b_seeAll'), postbackAction(L('b_seeAll'), 'action=opp_list', L('b_seeAllDlSaid')), { flex: 1, align: 'end' }),
    ],
  });
  return bubble({
    contents: [
      heading(L('b_closingSoon')),
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
              { type: 'text', text: o.deadline ? `${L('b_closesOn', { date: thaiFullDate(o.deadline) })}${o.deadline_note ? ' · ' + o.deadline_note : ''}` : '', size: 'xs', color: C.text, wrap: true },
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

const presetLabel = (key) => L(`b_preset_${key}`);

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
    heading(opp ? L('b_alertsThis') : L('b_alertsAll')),
    ...(opp ? [body(opp.title, { size: 'sm', extra: { weight: 'bold', margin: 'md' } })] : []),
    body(L('b_now', { desc: describeAlerts(current) }), { size: 'sm', extra: { margin: 'md' } }),
    muted(opp ? L('b_pickItem') : L('b_pickAll')),
  ];
  const footer = ALERT_PRESETS.map((p) => button(
    presetLabel(p.key),
    postbackAction(presetLabel(p.key).slice(0, 20), `action=alerts_set&p=${p.key}${idPart}`, L('b_alertPresetSaid', { label: presetLabel(p.key) })),
    same(p.days) ? 'primary' : 'secondary',
  ));
  if (opp) {
    footer.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      contents: [
        textLink(L('b_useDefault'), postbackAction(L('b_useDefaultShort'), `action=alerts_reset${idPart}`, L('b_useDefaultSaid')), { flex: 1 }),
        textLink(L('b_noAlertThis'), postbackAction(L('b_noAlertThis'), `action=alerts_off${idPart}`, L('b_noAlertThisSaid')), { flex: 0, align: 'end' }),
      ],
    });
  } else {
    footer.push({ type: 'text', text: L('b_alertTime'), size: 'xs', weight: 'bold', color: C.muted, margin: 'lg' });
    footer.push({
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: ALERT_TIMES.map((t) => button(t, postbackAction(t, `action=alerts_time&t=${t.replace(':', '')}`, L('b_alertAtSaid', { t })), t === current.time ? 'primary' : 'secondary')),
    });
    footer.push(textLink(current.days.length ? L('b_alertsOffLink') : L('b_alertsOnLink'),
      postbackAction(L('b_onOff'), current.days.length ? 'action=alerts_off' : 'action=alerts_set&p=std', current.days.length ? L('b_alertsOffLink') : L('b_alertsOnSaid')),
      { margin: 'md', align: 'center', size: 'xs' }));
  }
  return flexMessage(L('b_alertSettingsAlt', { desc: describeAlerts(current) }), bubble({ contents, footer }));
}

/** After "applied": confirmation with a way back. */
export function appliedCard(o) {
  return flexMessage(L('b_appliedAlt', { title: o.title }), bubble({
    contents: [heading(L('b_appliedTitle')), body(o.title, { size: 'sm', extra: { weight: 'bold', margin: 'md' } }), muted(L('b_appliedBody'))],
    footer: [button(L('b_resumeLong'), postbackAction(L('b_resume'), `action=opp_unapplied&id=${o.id}`, L('b_resumeSaid')), 'secondary')],
  }));
}

/** After a delete: what went, and undo. */
export function deletedCard(o) {
  return flexMessage(L('b_deletedAlt', { title: o.title }), bubble({
    contents: [heading(L('b_deletedTitle')), body(o.title, { size: 'sm', extra: { weight: 'bold', margin: 'md' } }), muted(L('b_deletedBody'))],
    footer: [button(L('b_undo'), postbackAction(L('b_undo'), `action=opp_restore&id=${o.id}`, L('b_undoSaid', { title: shortTitle(o.title) })), 'secondary')],
  }));
}

export function scanOfferCard(fileId) {
  return flexMessage(L('b_scanAlt'), bubble({
    contents: [heading(L('b_scanTitle')), muted(L('b_scanBody'))],
    footer: [button(L('b_scanBtn'), postbackAction(L('b_scanBtn'), `action=scan&file=${fileId}`, L('b_scanSaid')))],
  }));
}

// ------------------------------------------------------- subscriptions

const label20 = (s) => String(s).slice(0, 20);
const money = (amount, currency) => formatMoney(amount, currency, currentLang());
const priceOf = (s) => formatPrice(s.amount, s.currency, s.cycle, currentLang());
const dayMonth = (k) => (k ? formatDay(k, currentLang(), 'dm') : '');
const cycleWord = (c) => L(`b_sub_cycle_${['monthly', 'yearly', 'weekly'].includes(c) ? c : 'unknown'}`);
const subTone = (days) => (days === null || days === undefined ? TONE.none : days <= 1 ? TONE.red : days <= 3 ? TONE.orange : TONE.olive);
const subOn = (s) => (s.status === 'cancelled' ? '' : (s.status === 'trial' ? s.trialEndsOn : s.nextChargeOn) || '');

function subBadge(on, today, { big = false } = {}) {
  if (!on) return dateBadge({ color: TONE.none, day: '?', month: L('b_sub_noDate') }, { big });
  return dateBadge({ color: subTone(diffDays(today, on)), day: String(Number(on.slice(8))), month: formatDay(on, currentLang(), 'mon') }, { big });
}

/** "หมดพรุ่งนี้" / "Charges in 5 days" / "ยกเลิกเมื่อ 3 ต.ค." for a subscription. */
export function subCountdown(sub, today, timeZone) {
  if (sub.status === 'cancelled') return sub.cancelledAt ? L('b_sub_cancelledOn', { date: dayMonth(zoned(sub.cancelledAt, timeZone).key) }) : L('b_sub_secCancelled');
  const on = subOn(sub);
  if (!on) return sub.status === 'trial' ? L('b_sub_secTrials') : cycleWord(sub.cycle);
  const n = diffDays(today, on);
  if (sub.status === 'trial') {
    if (n < 0) return L('b_sub_trialOver');
    if (n === 0) return L('b_sub_endsToday');
    if (n === 1) return L('b_sub_endsTomorrow');
    return L('b_sub_endsIn', { n });
  }
  if (n <= 0) return L('b_sub_chargesToday');
  if (n === 1) return L('b_sub_chargesTomorrow');
  return L('b_sub_chargesIn', { n });
}

function hrow(...items) {
  return { type: 'box', layout: 'horizontal', spacing: 'sm', contents: items.filter(Boolean) };
}

/** A charge JaiJa has not seen before: amount, where, and "is this a subscription?". */
export function chargeQuestionCard(pending) {
  const c = pending.charge;
  const amount = money(c.amount, c.currency);
  const name = c.service || c.merchant;
  const short = shortTitle(name, 24);
  const facts = [
    c.on ? `${dayMonth(c.on)}${c.time ? ` · ${formatTime(c.time, currentLang())}` : ''}` : '',
    c.cardLast4 ? L('b_sub_card', { d: c.cardLast4 }) : '',
  ].filter(Boolean).join(' · ');
  const reason = L(`b_sub_reason_${pending.reason || 'asked'}`, { date: dayMonth(c.on) });
  const p = `p=${pending.id}`;
  const contents = [
    heading(L('b_sub_newTitle')),
    { type: 'text', text: amount || '–', size: 'xxl', weight: 'bold', color: C.title, margin: 'md' },
    body(shortTitle(name, 60), { size: 'sm', extra: { weight: 'bold' } }),
    ...(facts ? [muted(facts)] : []),
    ...(reason && !reason.startsWith('b_sub_') ? [muted(reason)] : []),
    body(L('b_sub_question'), { size: 'sm', extra: { margin: 'lg' } }),
  ];
  const footer = [
    button(L('b_sub_btnMonthly'), postbackAction(label20(L('b_sub_btnMonthly')), `action=sub_track&${p}&c=monthly`, L('b_sub_trackSaid', { name: short, cycle: cycleWord('monthly') }))),
    hrow(
      button(L('b_sub_btnYearly'), postbackAction(label20(L('b_sub_btnYearly')), `action=sub_track&${p}&c=yearly`, L('b_sub_trackSaid', { name: short, cycle: cycleWord('yearly') })), 'secondary'),
      button(L('b_sub_btnOnce'), postbackAction(label20(L('b_sub_btnOnce')), `action=sub_once&${p}`, L('b_sub_onceSaid', { name: short })), 'secondary'),
    ),
    textLink(L('b_sub_btnUnknown'), postbackAction(label20(L('b_sub_btnUnknown')), `action=sub_unknown&${p}`, L('b_sub_unknownSaid', { name: short })), { align: 'center', margin: 'md' }),
  ];
  return flexMessage(L('b_sub_altNew', { price: amount, merchant: name }), bubble({ contents, footer }));
}

/** A saved subscription or trial: price, the next date, what JaiJa will remind, and quick changes. */
export function subscriptionCard(sub, { title, timeZone, now = new Date(), alertTime = '09:00' } = {}) {
  const today = todayIso(now, timeZone);
  const trial = sub.status === 'trial';
  const cancelled = sub.status === 'cancelled';
  const time = formatTime(alertTime, currentLang());
  const on = subOn(sub);
  let dateLine = '';
  if (trial) dateLine = sub.trialEndsOn ? L('b_sub_trialEnds', { date: thaiFullDate(sub.trialEndsOn) }) : L('b_sub_trialNoDate', { name: sub.name });
  else if (!cancelled) dateLine = sub.nextChargeOn ? L('b_sub_nextCharge', { date: thaiFullDate(sub.nextChargeOn) }) : L('b_sub_noNextDate', { name: sub.name });
  let remindLine = '';
  if (!cancelled) {
    if (!sub.remind) remindLine = L('b_sub_remindOff');
    else if (trial) remindLine = L('b_sub_remindTrial', { time });
    else remindLine = L(sub.cycle === 'yearly' ? 'b_sub_remindYearly' : 'b_sub_remindMonthly', { time });
  }
  const contents = [
    heading(title || (trial ? L('b_sub_savedTrial') : L('b_sub_saved'))),
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      margin: 'lg',
      contents: [
        subBadge(on, today),
        {
          type: 'box',
          layout: 'vertical',
          flex: 1,
          spacing: 'xs',
          justifyContent: 'center',
          contents: [
            { type: 'text', text: shortTitle(sub.name, 50), size: 'md', weight: 'bold', color: C.title, wrap: true, maxLines: 2 },
            { type: 'text', text: priceOf(sub) || cycleWord(sub.cycle), size: 'sm', color: C.text },
            { type: 'text', text: subCountdown(sub, today, timeZone), size: 'sm', weight: 'bold', color: subTone(on ? diffDays(today, on) : null), wrap: true },
          ],
        },
      ],
    },
    ...(dateLine ? [body(dateLine, { size: 'sm', extra: { margin: 'lg' } })] : []),
    ...(remindLine ? [muted(remindLine)] : []),
  ];
  const id = `id=${sub.id}`;
  const short = shortTitle(sub.name, 24);
  const footer = [];
  if (!cancelled) {
    const remind = sub.remind
      ? button(L('b_sub_btnRemindOff'), postbackAction(label20(L('b_sub_btnRemindOff')), `action=sub_remind&${id}&on=0`, L('b_sub_remindOffSaid', { name: short })), 'secondary')
      : button(L('b_sub_btnRemindOn'), postbackAction(label20(L('b_sub_btnRemindOn')), `action=sub_remind&${id}&on=1`, L('b_sub_remindOnSaid', { name: short })), 'secondary');
    footer.push(hrow(
      button(L('b_sub_btnCancelled'), postbackAction(label20(L('b_sub_btnCancelled')), `action=sub_cancelled&${id}`, L('b_sub_cancelledSaid', { name: short })), 'secondary'),
      remind,
    ));
  } else {
    footer.push(button(L('b_sub_btnStillUsing'), postbackAction(label20(L('b_sub_btnStillUsing')), `action=sub_keep&${id}`, L('b_sub_stillUsingSaid', { name: short })), 'secondary'));
  }
  footer.push(textLink(L('b_sub_seeAll'), postbackAction(label20(L('b_sub_seeAll')), 'action=sub_list', L('b_sub_seeAllSaid')), { align: 'center', margin: 'md' }));
  return flexMessage(L('b_sub_altSaved', { name: sub.name }), bubble({ contents, footer }));
}

/** When an alert fires: the trial end or charge date, big, with "cancelled" right there. */
export function subscriptionAlertBubble({ sub, on, kind, daysLeft }, { timeZone, now = new Date() } = {}) {
  const today = todayIso(now, timeZone);
  const trial = kind === 'trial';
  const n = daysLeft ?? diffDays(today, on);
  const countdown = trial
    ? (n <= 0 ? L('b_sub_endsToday') : n === 1 ? L('b_sub_endsTomorrow') : L('b_sub_endsIn', { n }))
    : (n <= 0 ? L('b_sub_chargesToday') : n === 1 ? L('b_sub_chargesTomorrow') : L('b_sub_chargesIn', { n }));
  const p = sub.amount ? priceOf(sub) : '';
  const text = trial
    ? (p ? L('b_sub_alertTrialBody', { name: sub.name, price: p }) : L('b_sub_alertTrialBodyNoPrice', { name: sub.name }))
    : (p ? L('b_sub_alertRenewalBody', { price: p }) : L('b_sub_alertRenewalBodyNoPrice'));
  const id = `id=${sub.id}`;
  const short = shortTitle(sub.name, 24);
  const footer = [
    button(L('b_sub_btnCancelled'), postbackAction(label20(L('b_sub_btnCancelled')), `action=sub_cancelled&${id}`, L('b_sub_cancelledSaid', { name: short }))),
    trial
      ? button(L('b_sub_btnKeep'), postbackAction(label20(L('b_sub_btnKeep')), `action=sub_keep&${id}`, L('b_sub_keepSaid', { name: short })), 'secondary')
      : button(L('b_sub_btnRemindOff'), postbackAction(label20(L('b_sub_btnRemindOff')), `action=sub_remind&${id}&on=0`, L('b_sub_remindOffSaid', { name: short })), 'secondary'),
    textLink(L('b_sub_seeAll'), postbackAction(label20(L('b_sub_seeAll')), 'action=sub_list', L('b_sub_seeAllSaid')), { align: 'center', margin: 'md' }),
  ];
  return bubble({
    contents: [
      heading(trial ? L('b_sub_alertTrial') : L('b_sub_alertRenewal')),
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        margin: 'lg',
        contents: [
          subBadge(on, today, { big: true }),
          {
            type: 'box',
            layout: 'vertical',
            flex: 1,
            justifyContent: 'center',
            spacing: 'xs',
            contents: [
              { type: 'text', text: countdown, size: 'xl', weight: 'bold', color: subTone(n), wrap: true },
              { type: 'text', text: thaiFullDate(on), size: 'xs', color: C.text, wrap: true },
            ],
          },
        ],
      },
      body(sub.name, { extra: { weight: 'bold', margin: 'lg' } }),
      muted(text),
    ],
    footer,
  });
}

/** Subscription alerts due together go out as one message. */
export function subscriptionAlertsMessage(entries, { timeZone, now = new Date() } = {}) {
  const bubbles = entries.slice(0, 12).map((e) => subscriptionAlertBubble(e, { timeZone, now }));
  const alt = entries.map((e) => `${e.sub.name} ${e.kind === 'trial' ? L('b_sub_trialEnds', { date: dayMonth(e.on) }) : L('b_sub_nextCharge', { date: dayMonth(e.on) })}`).join(' · ');
  return flexMessage(`⏰ ${alt}`, bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles });
}

/** Charges worth telling about: a trial that started charging, a charge after cancelling, a renewal after cancelling, a new price. */
export function chargeNoticeCard(r, { timeZone, now = new Date() } = {}) {
  const s = r.sub;
  const c = r.charge;
  const name = s?.name || c.service || c.merchant;
  const amount = money(c.amount, c.currency);
  const short = shortTitle(name, 24);
  const id = s ? `id=${s.id}` : '';
  const seeAll = textLink(L('b_sub_seeAll'), postbackAction(label20(L('b_sub_seeAll')), 'action=sub_list', L('b_sub_seeAllSaid')), { align: 'center', margin: 'md' });
  const cancelledBtn = (style) => button(L('b_sub_btnCancelled'), postbackAction(label20(L('b_sub_btnCancelled')), `action=sub_cancelled&${id}`, L('b_sub_cancelledSaid', { name: short })), style);
  const stillUsing = button(L('b_sub_btnStillUsing'), postbackAction(label20(L('b_sub_btnStillUsing')), `action=sub_keep&${id}`, L('b_sub_stillUsingSaid', { name: short })), 'secondary');
  let title;
  let contents;
  let footer;
  switch (r.outcome) {
    case 'trial_converted':
      title = L('b_sub_convertedTitle');
      contents = [
        body(L('b_sub_convertedBody', { name, price: amount, date: dayMonth(c.on) }), { size: 'sm', extra: { weight: 'bold', margin: 'md' } }),
        ...(s?.nextChargeOn ? [muted(L('b_sub_nextCharge', { date: thaiFullDate(s.nextChargeOn) }))] : []),
        body(L('b_sub_convertedAsk'), { size: 'sm', extra: { margin: 'md' } }),
      ];
      footer = [hrow(button(L('b_sub_btnKeep'), postbackAction(label20(L('b_sub_btnKeep')), `action=sub_keep&${id}`, L('b_sub_keepSaid', { name: short })), 'secondary'), cancelledBtn('primary')), seeAll];
      break;
    case 'charged_after_cancel':
      title = L('b_sub_afterCancelTitle');
      contents = [
        { type: 'text', text: amount || '–', size: 'xxl', weight: 'bold', color: TONE.red, margin: 'md' },
        body(L('b_sub_afterCancelBody', { name, price: amount, date: dayMonth(c.on) }), { size: 'sm', extra: { weight: 'bold' } }),
        muted(L('b_sub_afterCancelTips', { name })),
      ];
      footer = [stillUsing, textLink(L('b_sub_btnUnknown'), postbackAction(label20(L('b_sub_btnUnknown')), `action=sub_help&${id}`, L('b_sub_unknownSaid', { name: short })), { align: 'center', margin: 'md' })];
      break;
    case 'renewal_after_cancel':
      title = L('b_sub_renewAfterCancelTitle');
      contents = [
        body(L('b_sub_renewAfterCancelBody', { name, date: thaiFullDate(c.on) }), { size: 'sm', extra: { weight: 'bold', margin: 'md' } }),
        muted(L('b_sub_afterCancelTips', { name })),
      ];
      footer = [stillUsing, seeAll];
      break;
    default: // price_change
      title = L('b_sub_priceTitle');
      contents = [
        body(L('b_sub_priceBody', { name, old: money(r.previousAmount, s?.currency || c.currency), new: amount }), { extra: { weight: 'bold', margin: 'md' } }),
        ...(s?.nextChargeOn ? [muted(L('b_sub_nextCharge', { date: thaiFullDate(s.nextChargeOn) }))] : []),
      ];
      footer = [cancelledBtn('secondary'), seeAll];
  }
  return flexMessage(`${title} ${name} ${amount}`.slice(0, 400), bubble({ contents: [heading(title), ...contents], footer }));
}

/** One subscription in the list: date badge | name, price, countdown. Tap opens it. */
function subscriptionRow(sub, today, timeZone) {
  const on = subOn(sub);
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
    action: postbackAction(L('b_view'), `action=sub_view&id=${sub.id}`, L('b_viewNamed', { title: shortTitle(sub.name, 24) })),
    contents: [
      subBadge(on, today),
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        spacing: 'xs',
        justifyContent: 'center',
        contents: [
          { type: 'text', text: shortTitle(sub.name, 60), size: 'sm', weight: 'bold', color: C.title, wrap: true, maxLines: 2 },
          { type: 'text', text: subCountdown(sub, today, timeZone), size: 'md', weight: 'bold', color: sub.status === 'cancelled' ? TONE.past : subTone(on ? diffDays(today, on) : null), wrap: true },
          { type: 'text', text: priceOf(sub) || cycleWord(sub.cycle), size: 'xxs', color: C.muted },
        ],
      },
    ],
  };
}

/** Trials first (soonest end), then paid plans by next charge, a few cancelled ones, the monthly total and open questions. */
export function subscriptionListCard(subs, { pendingCount = 0, timeZone, now = new Date(), appUrl = '' } = {}) {
  const today = todayIso(now, timeZone);
  const contents = [heading(L('b_sub_listTitle'))];
  const trials = subs.filter((s) => s.status === 'trial');
  const active = subs.filter((s) => s.status === 'active');
  const cancelled = subs.filter((s) => s.status === 'cancelled').slice(0, 3);
  let rows = 0;
  const section = (label, list) => {
    if (!list.length || rows >= MAX_LIST_ROWS) return;
    contents.push(sectionLabel(label));
    for (const s of list) {
      if (rows >= MAX_LIST_ROWS) break;
      contents.push(subscriptionRow(s, today, timeZone));
      rows++;
    }
  };
  if (!subs.length) contents.push(muted(L('b_sub_listEmpty')));
  section(L('b_sub_secTrials'), trials);
  section(L('b_sub_secActive'), active);
  section(L('b_sub_secCancelled'), cancelled);
  const shown = trials.length + active.length + cancelled.length;
  if (shown > rows) contents.push(muted(L('b_andMore', { n: shown - rows })));
  const totals = Object.entries(monthlyTotals(subs));
  if (totals.length) contents.push(body(L('b_sub_total', { list: totals.map(([cur, v]) => formatPrice(v, cur, 'monthly', currentLang())).join(' + ') }), { size: 'sm', extra: { weight: 'bold', margin: 'lg' } }));
  const footer = [];
  if (pendingCount) {
    contents.push(muted(L('b_sub_pendingN', { n: pendingCount })));
    footer.push(button(L('b_sub_btnPending'), postbackAction(label20(L('b_sub_btnPending')), 'action=sub_pending', L('b_sub_pendingSaid'))));
  }
  footer.push(hrow(
    appUrl ? button(L('b_sub_btnApp'), uriAction(label20(L('b_sub_btnApp')), appUrl), 'secondary') : null,
    button(L('b_sub_btnConnect'), postbackAction(label20(L('b_sub_btnConnect')), 'action=sub_connect', L('b_sub_btnConnect')), 'secondary'),
  ));
  return flexMessage(L('b_sub_altList', { n: subs.length }), bubble({ contents, footer }));
}

// ----------------------------------------------------------- calendar

export function eventCard(event, { timeZone } = {}) {
  const when = event.allDay
    ? `${event.start} ${L('b_allDayParen')}`
    : `${describeWhen(event.start, timeZone)}${event.end ? ' - ' + timeOnly(event.end, timeZone) : ''}`;
  const contents = [heading(L('b_eventAdded')), body(event.title, { extra: { margin: 'md' } }), muted(when)];
  const footer = event.link ? [button(L('b_openCalendar'), uriAction(L('b_openCalendar'), event.link))] : [];
  return flexMessage(L('b_eventAlt', { title: event.title, when }), bubble({ contents, footer }));
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
  return formatTime(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)), currentLang());
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
