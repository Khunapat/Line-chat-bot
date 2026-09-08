import express from 'express';
import { middleware, messagingApi, HTTPFetchError, SignatureValidationFailed, JSONParseError } from '@line/bot-sdk';
import { config, requireConfig, resolveProvider } from './config.js';
import { DriveArchive } from './drive.js';
import { Store } from './store.js';
import { Calendar, isScopeError } from './calendar.js';
import { Brain } from './brain.js';
import { GeminiProvider } from './providers/gemini.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { fireDueReminders, pendingReminders, describeWhen, describeRepeat } from './reminders.js';
import {
  textMessage, fileCard, filesCarousel, reminderCard, reminderListCard, dueReminderCard, eventCard,
  infoCard, linkButton, postbackButton,
} from './flex.js';

requireConfig();

const allowedUsers = new Set(config.allowedUserIds);
const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken: config.line.channelAccessToken });
const lineBlob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: config.line.channelAccessToken });

const drive = new DriveArchive({
  clientId: config.google.clientId,
  clientSecret: config.google.clientSecret,
  refreshToken: config.google.refreshToken,
  rootFolderName: config.driveRootFolderName,
  timeZone: config.timeZone,
});
const store = new Store(drive);
const calendar = new Calendar(drive.auth, { calendarId: config.google.calendarId, timeZone: config.timeZone });
const tz = config.timeZone;

// ---------------------------------------------------------------------------
// Tool handlers shared by the Claude brain and the keyword fallback.
// Each returns a JSON-able result and may push LINE messages to ctx.attachments.
// ---------------------------------------------------------------------------

const handlers = {
  async remember({ text }, ctx) {
    const entry = await store.remember(text, { userId: ctx.userId });
    return { ok: true, id: entry.id, savedAt: thaiDate(entry.createdAt) };
  },

  async recall({ query }) {
    let hits = await store.searchMemory(query, 10);
    let note = 'matched';
    if (hits.length === 0) {
      hits = (await store.memories()).slice(-15).reverse();
      note = 'no keyword match; these are the most recent memories';
    }
    return { note, memories: hits.map((m) => ({ id: m.id, text: m.text, savedAt: thaiDate(m.createdAt) })) };
  },

  async forget({ id }) {
    const removed = await store.forget(id);
    return removed ? { ok: true, text: removed.text } : { error: 'not found' };
  },

  async save_note({ text }, ctx) {
    const file = await drive.appendNote(text, ctx.now);
    ctx.attachments.push(infoCard('📝 จดไว้แล้ว', [`${drive.todayKey(ctx.now)}/notes.md`], {
      buttons: [linkButton('เปิดโน้ต', file.webViewLink)],
    }));
    return { ok: true, file: file.name, day: drive.todayKey(ctx.now) };
  },

  async find_file({ query }, ctx) {
    const files = await drive.findFiles(query, 5);
    if (files.length === 0) return { found: 0, files: [] };
    ctx.attachments.push(filesCarousel(files, { title: files.length > 1 ? `📁 เจอ ${files.length} ไฟล์` : '📁 เจอแล้ว' }));
    return { found: files.length, files: files.map((f) => ({ name: f.name, day: f.day })) };
  },

  async name_last_file({ label }, ctx) {
    const state = await store.getUserState(ctx.userId);
    let target = state.lastFile;
    if (!target) [target] = await drive.recentFiles(1);
    if (!target) return { error: 'no file has been sent yet' };
    const renamed = await drive.renameFile(target.id, label);
    await store.setUserState(ctx.userId, { lastFile: renamed });
    ctx.attachments.push(fileCard(renamed, { title: '📁 เก็บไว้แล้ว' }));
    return { ok: true, name: renamed.name };
  },

  async set_reminder({ text, at, repeat }, ctx) {
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return { error: 'invalid datetime' };
    if (when < ctx.now && (!repeat || repeat === 'none')) return { error: 'time is in the past; ask the user for a new time' };
    const r = await store.addReminder({ userId: ctx.userId, text, at: when.toISOString(), repeat: repeat || 'none' });
    ctx.attachments.push(reminderCard(r, { timeZone: tz, now: ctx.now }));
    return { ok: true, id: r.id, when: describeWhen(r.at, tz, ctx.now), repeat: describeRepeat(r.repeat) };
  },

  async list_reminders(_input, ctx) {
    const list = pendingReminders(await store.reminders(), ctx.userId);
    ctx.attachments.push(reminderListCard(list, { timeZone: tz, now: ctx.now }));
    return { reminders: list.map((r) => ({ id: r.id, text: r.text, when: describeWhen(r.at, tz, ctx.now), repeat: r.repeat })) };
  },

  async cancel_reminder({ id }) {
    const removed = await store.removeReminder(id);
    return removed ? { ok: true, text: removed.text } : { error: 'not found' };
  },

  async reschedule_reminder({ id, at }, ctx) {
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return { error: 'invalid datetime' };
    const r = await store.updateReminder(id, { at: when.toISOString() });
    if (!r) return { error: 'not found' };
    ctx.attachments.push(reminderCard(r, { timeZone: tz, now: ctx.now, title: '⏰ เปลี่ยนเวลาให้แล้ว' }));
    return { ok: true, when: describeWhen(r.at, tz, ctx.now) };
  },

  async add_calendar_event({ title, start, end, description }, ctx) {
    try {
      const ev = await calendar.createEvent({ title, start, end: end || undefined, description: description || undefined });
      ctx.attachments.push(eventCard(ev, { timeZone: tz }));
      return { ok: true, title: ev.title, start: ev.start, end: ev.end };
    } catch (err) {
      if (isScopeError(err)) return { error: 'Google Calendar is not connected: the refresh token lacks the calendar scope. Tell the user to re-run "npm run get-token" and redeploy.' };
      throw err;
    }
  },

  async list_calendar({ days }) {
    try {
      const events = await calendar.listUpcoming({ days: Math.min(Math.max(days || 7, 1), 60) });
      return { events: events.map((e) => ({ title: e.title, when: e.allDay ? e.start : describeWhen(e.start, tz), link: e.link })) };
    } catch (err) {
      if (isScopeError(err)) return { error: 'Google Calendar is not connected (missing calendar scope). Re-run "npm run get-token".' };
      throw err;
    }
  },
};

function makeProvider() {
  switch (resolveProvider()) {
    case 'gemini': return new GeminiProvider({ apiKey: config.geminiApiKey, model: config.geminiModel });
    case 'anthropic': return new AnthropicProvider({ apiKey: config.anthropicApiKey, model: config.claudeModel, effort: config.claudeEffort });
    default: return null;
  }
}
const provider = makeProvider();
const brain = provider
  ? new Brain({ provider, botName: config.botName, userName: config.userName, timeZone: tz, handlers })
  : null;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();

app.get('/', (_req, res) => res.status(200).send(`${config.botName} ok`));

// LINE middleware needs the raw body for signature verification - keep
// express.json() away from this route.
app.post('/webhook', middleware({ channelSecret: config.line.channelSecret }), async (req, res) => {
  const events = req.body.events ?? [];
  await Promise.all(events.map((event) => handleEvent(event).catch((err) => {
    console.error('event failed', { type: event.type, err: describeError(err) });
  })));
  res.status(200).end();
});

// Cloud Scheduler hits this every minute to deliver due reminders.
app.all('/cron/reminders', async (req, res) => {
  if (!config.cronSecret || req.get('x-cron-secret') !== config.cronSecret) {
    return res.status(401).send('unauthorized');
  }
  try {
    const result = await fireDueReminders(store, async (r) => {
      await lineClient.pushMessage({
        to: r.userId,
        messages: [dueReminderCard(r, { userName: config.userName, timeZone: tz, now: new Date() })],
      });
    });
    res.json(result);
  } catch (err) {
    console.error('cron failed', describeError(err));
    res.status(500).json({ error: 'cron failed' });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof SignatureValidationFailed) return res.status(401).send('invalid signature');
  if (err instanceof JSONParseError) return res.status(400).send('invalid JSON');
  console.error('unhandled error', describeError(err));
  res.status(500).end();
});

app.listen(config.port, () => {
  console.log(`${config.botName} listening on :${config.port} (tz=${tz}, brain=${brain ? brain.label : 'off'}, allowed=${allowedUsers.size})`);
});

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

async function handleEvent(event) {
  const userId = event.source?.userId;
  const replyToken = event.replyToken;
  if (!replyToken) return;

  if (event.type === 'follow') {
    await reply(replyToken, userId, [textMessage(welcomeText())]);
    return;
  }
  if (event.type !== 'message' && event.type !== 'postback') return;

  if (allowedUsers.size === 0) {
    await reply(replyToken, userId, [textMessage(
      `Your LINE user ID is:\n${userId}\n\nSet ALLOWED_USER_IDS to this value and redeploy to start using the bot.`)]);
    return;
  }
  if (!allowedUsers.has(userId)) {
    console.warn('ignoring event from non-allowed user', userId);
    return;
  }

  const now = new Date(event.timestamp ?? Date.now());
  const ctx = { userId, now, attachments: [] };

  try {
    if (event.type === 'postback') {
      await handlePostback(event, ctx);
      await reply(replyToken, userId, ctx.attachments);
      return;
    }

    const message = event.message;
    switch (message.type) {
      case 'text':
        await handleText(message.text, ctx);
        break;
      case 'location': {
        const { title, address, latitude, longitude } = message;
        const maps = `https://www.google.com/maps?q=${latitude},${longitude}`;
        await store.remember(['📍 ' + (title || 'ตำแหน่ง'), address, maps].filter(Boolean).join('\n'), { userId });
        ctx.attachments.push(textMessage('จำตำแหน่งนี้ไว้ให้แล้วนะ 📍 ถามหาเมื่อไหร่ก็ได้'));
        break;
      }
      case 'image':
      case 'video':
      case 'audio':
      case 'file': {
        const saved = await archiveBinary(message, now);
        await store.setUserState(userId, { lastFile: saved });
        const hint = message.type === 'file'
          ? 'เก็บไว้ให้แล้ว ถ้าอยากตั้งชื่อให้หาง่าย พิมพ์ "เก็บไฟล์ <ชื่อ>" ได้เลย'
          : `เก็บ${kindThai(message.type)}ไว้ให้แล้ว ถ้าอยากตั้งชื่อ พิมพ์ "เก็บไฟล์ <ชื่อ>" ได้เลย`;
        ctx.attachments.push(textMessage(hint), fileCard(saved, { title: '📁 เก็บไว้แล้ว' }));
        break;
      }
      case 'sticker':
        return;
      default:
        console.log('unhandled message type', message.type);
        return;
    }
    await reply(replyToken, userId, ctx.attachments);
  } catch (err) {
    console.error('handling failed', describeError(err));
    await reply(replyToken, userId, [textMessage('ขอโทษที มีอะไรพังนิดหน่อย ลองใหม่อีกทีนะ')]).catch(() => {});
  }
}

async function handleText(text, ctx) {
  const trimmed = text.trim();

  // Bare links (or link + a few words) are archived straight to notes.md.
  const urls = trimmed.match(/https?:\/\/\S+/g) || [];
  const remainder = trimmed.replace(/https?:\/\/\S+/g, '').trim();
  if (urls.length > 0 && remainder.length < 15) {
    const file = await drive.appendNote(trimmed, ctx.now);
    ctx.attachments.push(
      textMessage('จดลิงก์ไว้ให้แล้ว 🔗'),
      infoCard('📝 โน้ตวันนี้', [`${drive.todayKey(ctx.now)}/notes.md`], { buttons: [linkButton('เปิดโน้ต', file.webViewLink)] }),
    );
    return;
  }

  // A pending "change time" flow from a card button.
  const state = await store.getUserState(ctx.userId);
  let hint;
  if (state.pending?.type === 'reschedule') {
    hint = `ผู้ใช้กำลังเปลี่ยนเวลาเตือน id=${state.pending.id} ("${state.pending.text}") ข้อความนี้คือเวลาใหม่ ให้เรียก reschedule_reminder`;
    await store.setUserState(ctx.userId, { pending: null });
  }

  if (brain) {
    const { text: answer, attachments } = await brain.chat({ userId: ctx.userId, text: trimmed, hint });
    if (answer) ctx.attachments.push(textMessage(answer));
    ctx.attachments.push(...attachments);
    if (ctx.attachments.length === 0) ctx.attachments.push(textMessage('โอเค 👍'));
    return;
  }

  await fallbackText(trimmed, ctx, state);
}

/** Keyword-only mode when no AI key (GEMINI_API_KEY / ANTHROPIC_API_KEY) is configured. */
async function fallbackText(text, ctx) {
  let m;
  if ((m = /^(?:ขอ|หา|ค้นหา)\s*(?:ไฟล์|รูป|วิดีโอ|คลิป)\s*(.*?)\s*(?:หน่อย|ที|ให้หน่อย)?$/.exec(text))) {
    const r = await handlers.find_file({ query: m[1] }, ctx);
    if (r.found === 0) ctx.attachments.push(textMessage('หาไม่เจอเลย ลองพิมพ์ชื่อไฟล์ให้ชัดขึ้นอีกนิดได้ไหม'));
    else ctx.attachments.unshift(textMessage('เจอแล้ว กดปุ่มด้านล่างเพื่อเปิดได้เลย'));
    return;
  }
  if ((m = /^(?:เก็บไฟล์|ตั้งชื่อไฟล์(?:ว่า)?|ไฟล์นี้คือ)\s*(.+?)\s*(?:หน่อย|ให้หน่อย|ที)?$/.exec(text))) {
    const r = await handlers.name_last_file({ label: m[1] }, ctx);
    ctx.attachments.unshift(textMessage(r.error ? 'ยังไม่มีไฟล์ให้ตั้งชื่อเลย ส่งไฟล์มาก่อนนะ' : `บันทึกแล้วว่าไฟล์นี้ชื่อ ${r.name}`));
    return;
  }
  if ((m = /^(?:ช่วย)?(?:จำ|บันทึก)(?:ว่า|ไว้ว่า)?\s*(.+)$/s.exec(text))) {
    await handlers.remember({ text: m[1] }, ctx);
    ctx.attachments.push(textMessage('จำให้แล้ว ถามหาเมื่อไหร่ก็ได้ 👌'));
    return;
  }
  if ((m = /^(?:ขอ|มี|หา)\s*(.+?)\s*(?:หน่อย|ไหม|มั้ย|บ้าง|ที)?$/.exec(text))) {
    const r = await handlers.recall({ query: m[1] });
    if (r.note === 'matched') {
      ctx.attachments.push(textMessage('เจอแล้ว\n\n' + r.memories.map((x) => `${x.text}\n(บันทึก ${x.savedAt})`).join('\n\n')));
      return;
    }
  }
  if (/เตือน|calendar|ปฏิทิน/i.test(text)) {
    ctx.attachments.push(textMessage('การเตือนและปฏิทินต้องเปิดโหมด AI ก่อน (ใส่ GEMINI_API_KEY) ตอนนี้จดข้อความไว้ให้แทนนะ'));
  }
  const file = await drive.appendNote(text, ctx.now);
  ctx.attachments.push(infoCard('📝 จดไว้แล้ว', [`${drive.todayKey(ctx.now)}/notes.md`], { buttons: [linkButton('เปิดโน้ต', file.webViewLink)] }));
}

async function handlePostback(event, ctx) {
  const params = new URLSearchParams(event.postback?.data || '');
  const action = params.get('action');
  const id = params.get('id');

  switch (action) {
    case 'snooze': {
      const minutes = Math.min(Math.max(Number(params.get('min')) || 10, 1), 24 * 60);
      const original = (await store.reminders()).find((x) => x.id === id);
      if (!original) return void ctx.attachments.push(textMessage('หาการเตือนนี้ไม่เจอแล้ว ตั้งใหม่ได้เลยนะ'));
      const at = new Date(ctx.now.getTime() + minutes * 60_000).toISOString();
      const r = original.repeat && original.repeat !== 'none'
        ? await store.addReminder({ userId: ctx.userId, text: original.text, at, repeat: 'none' })
        : await store.updateReminder(id, { at, firedAt: null });
      const label = minutes >= 60 ? `${Math.round(minutes / 60)} ชั่วโมง` : `${minutes} นาที`;
      ctx.attachments.push(
        textMessage(`โอเค อีก ${label} เดี๋ยวเตือนอีกที`),
        reminderCard(r, { timeZone: tz, now: ctx.now, title: '⏰ เลื่อนให้แล้ว' }),
      );
      return;
    }
    case 'done': {
      const r = (await store.reminders()).find((x) => x.id === id);
      if (r && r.firedAt) await store.removeReminder(id);
      ctx.attachments.push(textMessage('เยี่ยม 👍 เรียบร้อยไปอีกเรื่อง'));
      return;
    }
    case 'cancel': {
      const removed = await store.removeReminder(id);
      ctx.attachments.push(textMessage(removed ? `ยกเลิกเตือน "${removed.text}" ให้แล้วนะ` : 'การเตือนนี้ถูกยกเลิกไปแล้ว'));
      return;
    }
    case 'reschedule': {
      const r = (await store.reminders()).find((x) => x.id === id);
      if (!r) return void ctx.attachments.push(textMessage('หาการเตือนนี้ไม่เจอแล้ว'));
      if (!brain) return void ctx.attachments.push(textMessage('การเปลี่ยนเวลาต้องเปิดโหมด AI ก่อน (GEMINI_API_KEY)'));
      await store.setUserState(ctx.userId, { pending: { type: 'reschedule', id: r.id, text: r.text } });
      ctx.attachments.push(textMessage(`จะเปลี่ยน "${r.text}" เป็นเวลาไหนดี พิมพ์บอกได้เลย เช่น "พรุ่งนี้ 9 โมง"`));
      return;
    }
    case 'menu_help':
      ctx.attachments.push(textMessage(welcomeText()));
      return;
    case 'list_reminders':
    case 'menu_reminders':
      await handlers.list_reminders({}, ctx);
      return;
    case 'menu_files': {
      const files = await drive.recentFiles(5);
      if (files.length === 0) ctx.attachments.push(textMessage('ยังไม่มีไฟล์เลย ส่งรูปหรือไฟล์มาได้เลย เดี๋ยวเก็บให้'));
      else ctx.attachments.push(textMessage('ไฟล์ล่าสุดที่เก็บไว้ พิมพ์ "ขอไฟล์ <ชื่อ>" เพื่อค้นหาได้นะ'), filesCarousel(files, { title: '📁 ไฟล์ล่าสุด' }));
      return;
    }
    case 'menu_notes': {
      const memories = await store.memories();
      const recent = memories.slice(-5).reverse();
      const lines = recent.length
        ? recent.map((m) => `• ${m.text.split('\n')[0].slice(0, 60)}`)
        : ['ยังไม่มีอะไรที่จำไว้เลย พิมพ์ "ช่วยจำ ..." ได้เลย'];
      const rootId = await drive.rootFolder();
      ctx.attachments.push(infoCard(`🧠 จำไว้ ${memories.length} เรื่อง`, lines, {
        buttons: [linkButton('เปิดโฟลเดอร์ Drive', `https://drive.google.com/drive/folders/${rootId}`)],
      }));
      return;
    }
    case 'menu_settings': {
      let cal = 'ยังไม่เชื่อม (รัน npm run get-token ใหม่)';
      try { await calendar.listUpcoming({ days: 1, max: 1 }); cal = 'เชื่อมแล้ว ✅'; } catch { /* keep default */ }
      ctx.attachments.push(infoCard('⚙️ ตั้งค่า', [
        `ชื่อบอท: ${config.botName}`,
        `โฟลเดอร์ Drive: ${config.driveRootFolderName}/`,
        `Google Calendar: ${cal}`,
        `โหมด AI: ${brain ? brain.label : 'ปิด (ยังไม่ได้ใส่ GEMINI_API_KEY)'}`,
        `เขตเวลา: ${tz}`,
        `LINE user ID: ${ctx.userId}`,
      ], { buttons: [postbackButton('ดูการเตือนทั้งหมด', 'action=list_reminders', 'ดูการเตือนทั้งหมด')] }));
      return;
    }
    default:
      ctx.attachments.push(textMessage('ปุ่มนี้ยังไม่รู้จักเลย'));
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

async function archiveBinary(message, when) {
  if (message.contentProvider?.type === 'external' && message.contentProvider.originalContentUrl) {
    const resp = await fetch(message.contentProvider.originalContentUrl);
    if (!resp.ok) throw new Error(`external media fetch failed: ${resp.status}`);
    const mimeType = resp.headers.get('content-type') || 'application/octet-stream';
    return drive.uploadStream({ name: buildFileName(message, mimeType, when), mimeType, body: resp.body, date: when });
  }
  const { httpResponse, body } = await lineBlob.getMessageContentWithHttpInfo(message.id);
  const mimeType = httpResponse.headers.get('content-type') || 'application/octet-stream';
  return drive.uploadStream({ name: buildFileName(message, mimeType, when), mimeType, body, date: when });
}

function buildFileName(message, mimeType, when) {
  const stamp = drive.timeKey(when);
  if (message.type === 'file' && message.fileName) return `${stamp}_${sanitize(message.fileName)}`;
  return `${stamp}_${message.type}_${message.id}${extensionFor(mimeType, message.type)}`;
}

function extensionFor(mimeType, type) {
  const table = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic',
    'video/mp4': '.mp4', 'video/quicktime': '.mov',
    'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/mpeg': '.mp3', 'audio/aac': '.aac',
    'application/pdf': '.pdf',
  };
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (table[base]) return table[base];
  return { image: '.jpg', video: '.mp4', audio: '.m4a', file: '' }[type] ?? '';
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 200);
}

function kindThai(type) {
  return { image: 'รูป', video: 'วิดีโอ', audio: 'เสียง', file: 'ไฟล์' }[type] || 'ไฟล์';
}

// ---------------------------------------------------------------------------
// LINE messaging helpers
// ---------------------------------------------------------------------------

/** Reply (free) while the token is valid; fall back to push after slow uploads. */
async function reply(replyToken, userId, messages) {
  const batch = messages.filter(Boolean).slice(0, 5);
  if (batch.length === 0) return;
  try {
    await lineClient.replyMessage({ replyToken, messages: batch });
  } catch (err) {
    if (err instanceof HTTPFetchError && userId) {
      console.warn('reply failed, pushing instead', err.status, err.body);
      await lineClient.pushMessage({ to: userId, messages: batch });
    } else {
      throw err;
    }
  }
}

function welcomeText() {
  return `สวัสดี เราคือ ${config.botName} 👋
ส่งอะไรมาก็ได้ เดี๋ยวเก็บให้หมดใน Google Drive

• ส่งรูป/ไฟล์/ลิงก์ → เก็บให้ทันที
• "เก็บไฟล์ bookbank" → ตั้งชื่อไฟล์ล่าสุด
• "ขอไฟล์ bookbank" → ดึงกลับมาให้
• "ช่วยจำ ที่จอดรถชั้น 3 B12" → จำไว้ให้
• "เตือนกินยา 19.00" → ตั้งเตือน
• "ลง calendar พรุ่งนี้ 10 โมง ประชุม" → ลงปฏิทิน
• ถามอะไรก็ได้ คุยเล่นก็ได้`;
}

function thaiDate(iso) {
  return new Intl.DateTimeFormat('th-TH', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

function describeError(err) {
  if (err instanceof HTTPFetchError) return `${err.status} ${err.body}`;
  return err?.stack || String(err);
}
