import express from 'express';
import { middleware, messagingApi, HTTPFetchError, SignatureValidationFailed, JSONParseError } from '@line/bot-sdk';
import { config, requireConfig, resolveProvider, multiUserEnabled } from './config.js';
import { DriveArchive } from './drive.js';
import { Store } from './store.js';
import { isScopeError } from './calendar.js';
import { Brain } from './brain.js';
import { GeminiProvider } from './providers/gemini.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { isQuotaError, QUOTA_MESSAGE } from './providers/errors.js';
import { Usage, describeReset } from './providers/usage.js';
import { fireDueReminders, pendingReminders, describeWhen, describeRepeat } from './reminders.js';
import {
  textMessage, fileCard, filesCarousel, reminderCard, reminderListCard, dueReminderCard, eventCard,
  infoCard, linkButton, postbackButton, opportunityCard, opportunityListCard, scanOfferCard,
} from './flex.js';
import {
  extractFromMedia, extractFromText, fetchPageText, deadlineReminderTimes, sortOpportunities,
  renderMarkdown, describeDeadline, captionSlug,
} from './opportunities.js';
import { registerGalleryRoutes, galleryUrl, thumbUrl, setGalleryTimeZone } from './gallery.js';
import { setAssetBase } from './flex.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerOAuthRoutes, connectUrl, baseUrlOf } from './oauth.js';
import { Tenants } from './tenants.js';
import { Readable } from 'node:stream';

requireConfig();

// A rejected promise outside a request handler must not take the bot down.
process.on('unhandledRejection', (err) => console.error('unhandled rejection', err?.stack || err));

const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken: config.line.channelAccessToken });
const lineBlob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: config.line.channelAccessToken });
const tz = config.timeZone;
setGalleryTimeZone(tz);
let publicBase = config.publicUrl; // learned from the first request when unset
setAssetBase(publicBase);

// The owner's Drive holds the tenant registry (who connected which Drive).
const ownerDrive = new DriveArchive({
  clientId: config.google.clientId,
  clientSecret: config.google.clientSecret,
  refreshToken: config.google.refreshToken,
  rootFolderName: config.driveRootFolderName,
  timeZone: tz,
});
const ownerStore = new Store(ownerDrive);
const tenants = new Tenants({
  ownerStore,
  ownerIds: config.allowedUserIds,
  ownerToken: config.google.refreshToken,
  ownerName: config.userName,
  google: config.google,
  googleWeb: config.googleWeb,
  rootFolderName: config.driveRootFolderName,
  timeZone: tz,
});

// ---------------------------------------------------------------------------
// Tool handlers shared by the chat brain, postbacks and the keyword fallback.
// Every handler works on ctx.svc = { drive, store, calendar } of the sender's
// tenant and may push LINE messages to ctx.attachments.
// ---------------------------------------------------------------------------

const handlers = {
  async remember({ text }, ctx) {
    const entry = await ctx.svc.store.remember(text, { userId: ctx.userId });
    return { ok: true, id: entry.id, savedAt: thaiDate(entry.createdAt) };
  },

  async recall({ query }, ctx) {
    let hits = await ctx.svc.store.searchMemory(query, 10);
    let note = 'matched';
    if (hits.length === 0) {
      hits = (await ctx.svc.store.memories()).slice(-15).reverse();
      note = 'no keyword match; these are the most recent memories';
    }
    return { note, memories: hits.map((m) => ({ id: m.id, text: m.text, savedAt: thaiDate(m.createdAt) })) };
  },

  async forget({ id }, ctx) {
    const removed = await ctx.svc.store.forget(id);
    return removed ? { ok: true, text: removed.text } : { error: 'not found' };
  },

  async save_note({ text }, ctx) {
    const file = await ctx.svc.drive.appendNote(text, ctx.now);
    ctx.attachments.push(infoCard('📝 จดไว้แล้ว', [`${ctx.svc.drive.todayKey(ctx.now)}/notes.md`], {
      buttons: [linkButton('เปิดโน้ต', file.webViewLink)],
    }));
    return { ok: true, file: file.name, day: ctx.svc.drive.todayKey(ctx.now) };
  },

  async find_file({ query }, ctx) {
    const files = withThumbs(await searchFiles(query, 5, ctx), ctx);
    if (files.length === 0) return { found: 0, files: [] };
    ctx.attachments.push(filesCarousel(files, { title: files.length > 1 ? `📁 เจอ ${files.length} ไฟล์` : '📁 เจอแล้ว' }));
    return { found: files.length, files: files.map((f) => ({ name: f.name, day: f.day, caption: f.caption || '' })) };
  },

  async search({ query }, ctx) {
    const [files, memories, opps] = await Promise.all([
      searchFiles(query, 5, ctx),
      ctx.svc.store.searchMemory(query, 5),
      ctx.svc.store.opportunities(),
    ]);
    const q = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (v) => { const h = String(v || '').toLowerCase(); return q.some((t) => h.includes(t)); };
    const oppHits = sortOpportunities(opps.filter((o) => hit(o.title) || hit(o.organizer) || hit(o.summary) || hit(o.eligibility)), tz, ctx.now).slice(0, 5);
    if (files.length) ctx.attachments.push(filesCarousel(withThumbs(files, ctx), { title: `📁 ไฟล์ที่เกี่ยวกับ "${query}"` }));
    if (oppHits.length) ctx.attachments.push(opportunityListCard(oppHits, { timeZone: tz, now: ctx.now }));
    return {
      files: files.map((f) => ({ name: f.name, day: f.day, caption: f.caption || '' })),
      memories: memories.map((m) => ({ text: m.text, savedAt: thaiDate(m.createdAt) })),
      opportunities: oppHits.map((o) => ({ title: o.title, deadline: describeDeadline(o.deadline, tz, ctx.now) })),
    };
  },

  async gallery_link(_input, ctx) {
    if (!publicBase) return { error: 'gallery URL unknown yet' };
    ctx.attachments.push(galleryCard(ctx));
    return { ok: true };
  },

  async name_last_file({ label }, ctx) {
    const state = await ctx.svc.store.getUserState(ctx.userId);
    let target = state.lastFile;
    if (!target) [target] = await ctx.svc.drive.recentFiles(1);
    if (!target) return { error: 'no file has been sent yet' };
    const renamed = await ctx.svc.drive.renameFile(target.id, label);
    await ctx.svc.store.setUserState(ctx.userId, { lastFile: renamed });
    ctx.attachments.push(fileCard(withThumb(renamed, ctx), { title: '📁 เก็บไว้แล้ว' }));
    return { ok: true, name: renamed.name };
  },

  async set_reminder({ text, at, repeat }, ctx) {
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return { error: 'invalid datetime' };
    if (when < ctx.now && (!repeat || repeat === 'none')) return { error: 'time is in the past; ask the user for a new time' };
    const r = await ctx.svc.store.addReminder({ userId: ctx.userId, text, at: when.toISOString(), repeat: repeat || 'none' });
    ctx.attachments.push(reminderCard(r, { timeZone: tz, now: ctx.now }));
    return { ok: true, id: r.id, when: describeWhen(r.at, tz, ctx.now), repeat: describeRepeat(r.repeat) };
  },

  async list_reminders(_input, ctx) {
    const list = pendingReminders(await ctx.svc.store.reminders());
    ctx.attachments.push(reminderListCard(list, { timeZone: tz, now: ctx.now }));
    return { reminders: list.map((r) => ({ id: r.id, text: r.text, when: describeWhen(r.at, tz, ctx.now), repeat: r.repeat })) };
  },

  async cancel_reminder({ id }, ctx) {
    const removed = await ctx.svc.store.removeReminder(id);
    return removed ? { ok: true, text: removed.text } : { error: 'not found' };
  },

  async reschedule_reminder({ id, at }, ctx) {
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return { error: 'invalid datetime' };
    const r = await ctx.svc.store.updateReminder(id, { at: when.toISOString() });
    if (!r) return { error: 'not found' };
    ctx.attachments.push(reminderCard(r, { timeZone: tz, now: ctx.now, title: '⏰ เปลี่ยนเวลาให้แล้ว' }));
    return { ok: true, when: describeWhen(r.at, tz, ctx.now) };
  },

  async add_calendar_event({ title, start, end, description }, ctx) {
    try {
      const ev = await ctx.svc.calendar.createEvent({ title, start, end: end || undefined, description: description || undefined });
      ctx.attachments.push(eventCard(ev, { timeZone: tz }));
      return { ok: true, title: ev.title, start: ev.start, end: ev.end };
    } catch (err) {
      if (isScopeError(err)) return { error: 'Google Calendar is not connected for this account. Tell the user to reconnect Google (settings > เชื่อม Drive ใหม่).' };
      throw err;
    }
  },

  async save_opportunity(fields, ctx) {
    const opp = await registerOpportunity({ ...fields, is_opportunity: true, confidence: 1 }, { ctx, source: { kind: 'text' } });
    ctx.attachments.push(opportunityCard(opp, { timeZone: tz, now: ctx.now }));
    return { ok: true, id: opp.id, deadline: describeDeadline(opp.deadline, tz, ctx.now), reminders: opp.reminderIds?.length || 0, duplicate: Boolean(opp.duplicate) };
  },

  async list_opportunities(_input, ctx) {
    const list = sortOpportunities(await ctx.svc.store.opportunities(), tz, ctx.now);
    for (const o of list) if (o.source?.fileId) withThumb(o, ctx, { fileId: o.source.fileId, mimeType: o.source.kind === 'pdf' ? 'application/pdf' : 'image/jpeg' });
    ctx.attachments.push(opportunityListCard(list, { timeZone: tz, now: ctx.now }));
    return { opportunities: list.map((o) => ({ id: o.id, title: o.title, kind: o.kind, deadline: o.deadline, when: describeDeadline(o.deadline, tz, ctx.now), link: o.link || o.source?.webViewLink || '' })) };
  },

  async delete_opportunity({ id }, ctx) {
    const removed = await deleteOpportunity(id, ctx);
    return removed ? { ok: true, title: removed.title } : { error: 'not found' };
  },

  async list_calendar({ days }, ctx) {
    try {
      const events = await ctx.svc.calendar.listUpcoming({ days: Math.min(Math.max(days || 7, 1), 60) });
      return { events: events.map((e) => ({ title: e.title, when: e.allDay ? e.start : describeWhen(e.start, tz), link: e.link })) };
    } catch (err) {
      if (isScopeError(err)) return { error: 'Google Calendar is not connected for this account (settings > เชื่อม Drive ใหม่).' };
      throw err;
    }
  },
};

const aiUsage = new Usage({ store: ownerStore });
process.on('SIGTERM', () => { aiUsage.flush().finally(() => process.exit(0)); });

function makeProvider() {
  switch (resolveProvider()) {
    case 'gemini': return new GeminiProvider({ apiKey: config.geminiApiKey, model: config.geminiModel, usage: aiUsage });
    case 'anthropic': return new AnthropicProvider({ apiKey: config.anthropicApiKey, model: config.claudeModel, effort: config.claudeEffort, usage: aiUsage });
    default: return null;
  }
}
const provider = makeProvider();
const brains = new Map(); // tenant id -> Brain (persona knows the person's name)
function brainFor(tenant) {
  if (!provider) return null;
  const key = `${tenant.id}|${tenant.name || ''}`;
  if (!brains.has(key)) {
    brains.set(key, new Brain({ provider, botName: config.botName, userName: tenant.type === 'group' ? '' : (tenant.name || ''), timeZone: tz, handlers }));
  }
  return brains.get(key);
}
const brainLabel = provider ? provider.label : 'off';

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();

app.get('/', (_req, res) => res.status(200).send(`${config.botName} ok`));
// Hand-drawn icons used inside Flex cards (LINE fetches them by URL).
app.use('/static', express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'public'), { maxAge: '7d', immutable: true }));

// LINE middleware needs the raw body for signature verification - keep
// express.json() away from this route.
app.post('/webhook', middleware({ channelSecret: config.line.channelSecret }), async (req, res) => {
  if (!publicBase && req.get('host')) publicBase = baseUrlOf(req);
  setAssetBase(publicBase);
  const events = req.body.events ?? [];
  await Promise.all(events.map((event) => handleEvent(event).catch((err) => {
    console.error('event failed', { type: event.type, err: describeError(err) });
  })));
  res.status(200).end();
});

// Cloud Scheduler hits this every minute to deliver due reminders, per tenant.
app.all('/cron/reminders', async (req, res) => {
  if (!config.cronSecret || req.get('x-cron-secret') !== config.cronSecret) {
    return res.status(401).send('unauthorized');
  }
  const summary = { tenants: 0, fired: 0, errors: 0 };
  try {
    for (const tenant of await tenants.list()) {
      try {
        const svc = await tenants.services(tenant);
        if (!svc) continue;
        summary.tenants++;
        const r = await fireDueReminders(svc.store, async (rem) => {
          await lineClient.pushMessage({
            to: tenant.id,
            messages: [dueReminderCard(rem, { userName: tenant.type === 'group' ? '' : tenant.name, timeZone: tz, now: new Date() })],
          });
        });
        summary.fired += r.fired;
      } catch (err) {
        summary.errors++;
        console.error('cron tenant failed', tenant.id, describeError(err));
      }
    }
    res.json(summary);
  } catch (err) {
    console.error('cron failed', describeError(err));
    res.status(500).json({ error: 'cron failed' });
  }
});

registerGalleryRoutes(app, {
  resolve: (tenantId) => tenants.servicesFor(tenantId),
  secret: config.gallerySecret,
  timeZone: tz,
  botName: config.botName,
});

registerOAuthRoutes(app, {
  googleWeb: config.googleWeb,
  secret: config.gallerySecret,
  tenants,
  botName: config.botName,
  onConnected: async ({ userId, email }) => {
    let name = '';
    try { name = (await lineClient.getProfile(userId)).displayName || ''; } catch { /* optional */ }
    await tenants.upsert({ id: userId, name });
    await lineClient.pushMessage({
      to: userId,
      messages: [textMessage(`เชื่อม Google Drive ของ ${email || name || 'คุณ'} แล้ว 🎉 ต่อจากนี้ทุกอย่างที่ส่งมาจะเก็บในโฟลเดอร์ ${config.driveRootFolderName} ของคุณเอง`), textMessage(welcomeText())],
    }).catch((err) => console.warn('welcome push failed', err?.message || err));
  },
});

app.use((err, _req, res, _next) => {
  if (err instanceof SignatureValidationFailed) return res.status(401).send('invalid signature');
  if (err instanceof JSONParseError) return res.status(400).send('invalid JSON');
  console.error('unhandled error', describeError(err));
  res.status(500).end();
});

app.listen(config.port, () => {
  console.log(`${config.botName} listening on :${config.port} (tz=${tz}, brain=${brainLabel}, owners=${config.allowedUserIds.length}, multiUser=${multiUserEnabled()})`);
});

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

async function handleEvent(event) {
  const userId = event.source?.userId;
  const chatType = event.source?.type || 'user'; // user | group | room
  const chatId = chatType === 'group' ? event.source.groupId : chatType === 'room' ? event.source.roomId : userId;
  const replyToken = event.replyToken;
  if (!replyToken) return;
  const now = new Date(event.timestamp ?? Date.now());

  // Bot added to a group: explain how to pick a host.
  if (event.type === 'join') {
    await reply(replyToken, chatId, [textMessage(groupIntroText()), hostCard()]);
    return;
  }
  if (event.type === 'follow') {
    const tenant = await tenants.get(userId);
    if (tenant) await reply(replyToken, userId, [textMessage(welcomeText())]);
    else await reply(replyToken, userId, await onboardingMessages(userId, null));
    return;
  }
  if (event.type !== 'message' && event.type !== 'postback') return;

  // Legacy first-run helper: nobody configured yet, tell the sender their id.
  if (config.allowedUserIds.length === 0 && !multiUserEnabled()) {
    await reply(replyToken, chatId, [textMessage(`Your LINE user ID is:\n${userId}\n\nSet ALLOWED_USER_IDS to this value and redeploy to start using the bot.`)]);
    return;
  }

  const tenant = await tenants.get(chatId);
  const svc = tenant ? await tenants.services(tenant) : null;
  const ctx = { userId, chatId, chatType, tenantId: chatId, tenant, svc, now, attachments: [] };

  try {
    if (!svc) {
      await handleUnconnected(event, ctx);
      await reply(replyToken, chatId, ctx.attachments);
      return;
    }

    if (event.type === 'postback') {
      await handlePostback(event, ctx);
      await reply(replyToken, chatId, ctx.attachments);
      return;
    }

    const message = event.message;
    switch (message.type) {
      case 'text':
        if (chatType !== 'user' && !addressedToBot(message)) return; // stay quiet in group chatter
        await handleText(stripMention(message), ctx);
        break;
      case 'location': {
        const { title, address, latitude, longitude } = message;
        const maps = `https://www.google.com/maps?q=${latitude},${longitude}`;
        await ctx.svc.store.remember(['📍 ' + (title || 'ตำแหน่ง'), address, maps].filter(Boolean).join('\n'), { userId });
        ctx.attachments.push(textMessage('จำตำแหน่งนี้ไว้ให้แล้วนะ 📍 ถามหาเมื่อไหร่ก็ได้'));
        break;
      }
      case 'image':
      case 'video':
      case 'audio':
      case 'file': {
        const brain = brainFor(tenant);
        const keepBytes = message.type === 'image' || message.type === 'file';
        const { saved, buffer, mimeType } = await archiveBinary(message, now, { keepBytes }, ctx);
        let file = saved;
        let read = null;
        if (buffer && isScannable(mimeType, buffer.length) && brain && config.autoScan === 'always') {
          read = await readMedia(buffer, mimeType, saved, ctx);
          if (read?.file) file = read.file;
        }
        await ctx.svc.store.setUserState(userId, { lastFile: file });
        const what = read?.fields?.caption ? `${kindThai(message.type)} (${read.fields.caption})` : kindThai(message.type);
        if (chatType === 'user') ctx.attachments.push(textMessage(`เก็บ${what}ไว้ให้แล้ว ถ้าอยากตั้งชื่อเอง พิมพ์ "เก็บไฟล์ <ชื่อ>" ได้เลย`));
        withThumb(file, ctx, { mimeType });
        if (read?.fields?.caption) file.caption = read.fields.caption;
        ctx.attachments.push(fileCard(file, { title: chatType === 'user' ? '📁 เก็บไว้แล้ว' : '📁 เก็บไว้ในโฟลเดอร์กลุ่มแล้ว' }));
        if (ctx.aiLimited) ctx.attachments.push(textMessage('AI ติดลิมิตชั่วคราว เลยยังไม่ได้อ่านเนื้อหาไฟล์นี้ ถ้าเป็นประกาศรับสมัคร ส่งมาใหม่ทีหลังได้นะ'));
        if (read?.opp) ctx.attachments.push(textMessage(scanIntro(read.opp)), opportunityCard(read.opp, { timeZone: tz, now: ctx.now }));
        else if (buffer && isScannable(mimeType, buffer.length) && brain && config.autoScan === 'ask') ctx.attachments.push(scanOfferCard(saved.id));
        break;
      }
      case 'sticker':
        return;
      default:
        console.log('unhandled message type', message.type);
        return;
    }
    await reply(replyToken, chatId, ctx.attachments);
  } catch (err) {
    console.error('handling failed', describeError(err));
    const text = isQuotaError(err) ? QUOTA_MESSAGE : 'ขอโทษที มีอะไรพังนิดหน่อย ลองใหม่อีกทีนะ';
    await reply(replyToken, chatId, [textMessage(text)]).catch(() => {});
  }
}

// ---------------------------------------------------------------- onboarding

/** Messages for someone who has not connected a Drive yet. */
async function onboardingMessages(userId, text) {
  if (!multiUserEnabled()) {
    return [textMessage(`สวัสดี เราคือ ${config.botName} 👋 ตอนนี้บอทยังเปิดใช้เฉพาะเจ้าของอยู่ ถ้าอยากใช้ด้วย บอกเจ้าของบอทให้เปิดโหมดหลายผู้ใช้ได้เลย`)];
  }
  if (config.inviteCode) {
    const invites = await ownerStore.read('invites.json', {});
    if (!invites[userId]) {
      if (text && text.trim() === config.inviteCode) {
        await ownerStore.update('invites.json', {}, (inv) => { inv[userId] = { at: new Date().toISOString() }; });
      } else {
        return [textMessage(`สวัสดี เราคือ ${config.botName} 👋 บอทนี้ใช้ได้เฉพาะคนที่มีรหัสเชิญ พิมพ์รหัสมาได้เลย`)];
      }
    }
  }
  return [textMessage(`สวัสดี เราคือ ${config.botName} 👋 ผู้ช่วยที่เก็บทุกอย่างลง Google Drive ของคุณเอง จำของให้ เตือนให้ และจด deadline ให้`), connectCard(userId)];
}

function connectCard(userId) {
  const lines = ['กดปุ่มเพื่อเชื่อม Google Drive ของคุณ (ใช้บัญชี Google ของคุณเอง ไม่มีใครเห็นไฟล์ของคุณ)'];
  if (!publicBase) return infoCard('🔗 เชื่อม Google Drive', ['ยังสร้างลิงก์ไม่ได้ ลองพิมพ์ "เชื่อม Drive" อีกครั้งในอีกสักครู่']);
  return infoCard('🔗 เชื่อม Google Drive', lines, { buttons: [linkButton('เชื่อม Google Drive', connectUrl(publicBase, config.gallerySecret, userId))] });
}

function hostCard() {
  return infoCard('👥 ที่เก็บของกลุ่มนี้', ['ให้สมาชิกคนหนึ่งเป็นเจ้าของโฟลเดอร์ ไฟล์และรูปของกลุ่มจะเก็บที่ LineArchive/Groups/<ชื่อกลุ่ม> ใน Drive ของคนนั้น'], {
    buttons: [postbackButton('ใช้ Drive ของฉันเป็นที่เก็บของกลุ่ม', 'action=group_host', 'ใช้ Drive ของฉันเป็นที่เก็บของกลุ่ม')],
  });
}

async function handleUnconnected(event, ctx) {
  const text = event.type === 'message' && event.message?.type === 'text' ? event.message.text : null;
  const postback = event.type === 'postback' ? new URLSearchParams(event.postback?.data || '') : null;

  if (ctx.chatType === 'user') {
    if (postback) return void ctx.attachments.push(...(await onboardingMessages(ctx.userId, null)));
    ctx.attachments.push(...(await onboardingMessages(ctx.userId, text)));
    return;
  }

  // Group / room without a host yet.
  if (postback?.get('action') === 'group_host') {
    await becomeHost(ctx);
    return;
  }
  const isMedia = event.type === 'message' && ['image', 'video', 'audio', 'file'].includes(event.message?.type);
  const mentioned = event.type === 'message' && event.message?.type === 'text' && addressedToBot(event.message);
  if (isMedia || mentioned || postback) ctx.attachments.push(textMessage(groupIntroText()), hostCard());
}

async function becomeHost(ctx) {
  const host = await tenants.get(ctx.userId);
  const hostSvc = host ? await tenants.services(host) : null;
  if (!hostSvc) {
    ctx.attachments.push(textMessage('ต้องเชื่อม Google Drive ของคุณในแชทส่วนตัวกับบอทก่อน แล้วค่อยกลับมากดปุ่มนี้อีกครั้งนะ'));
    if (multiUserEnabled()) ctx.attachments.push(connectCard(ctx.userId));
    return;
  }
  let groupName = 'Group';
  try {
    if (ctx.chatType === 'group') groupName = (await lineClient.getGroupSummary(ctx.chatId)).groupName || groupName;
  } catch { /* rooms have no summary */ }
  const safe = groupName.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 60) || 'Group';
  await tenants.upsert({ id: ctx.chatId, type: 'group', name: safe, hostUserId: ctx.userId, subFolders: ['Groups', safe] });
  ctx.attachments.push(
    textMessage(`เรียบร้อย ${host.name || 'เจ้าของ'} เป็นคนดูแลที่เก็บของกลุ่มนี้แล้ว ไฟล์ รูป และลิงก์ที่ส่งในกลุ่มจะเก็บที่ ${config.driveRootFolderName}/Groups/${safe}`),
    infoCard('👥 พร้อมใช้แล้ว', ['ส่งรูปหรือไฟล์ในกลุ่มได้เลย พิมพ์ @' + config.botName + ' นำหน้าถ้าจะสั่งงานหรือถาม', 'เจ้าของโฟลเดอร์กดปุ่มด้านล่างเพื่อแชร์ลิงก์โฟลเดอร์ให้ทุกคนดูได้'], {
      buttons: [postbackButton('แชร์ลิงก์โฟลเดอร์ให้กลุ่ม', 'action=group_share', 'แชร์ลิงก์โฟลเดอร์ให้กลุ่ม')],
    }),
  );
}

function groupIntroText() {
  return `สวัสดีทุกคน เราคือ ${config.botName} 👋 เก็บรูป ไฟล์ ลิงก์ที่ส่งในกลุ่มนี้ลง Google Drive ให้ พร้อมจด deadline และตั้งเตือนในกลุ่มได้`;
}

/** In groups the bot answers text only when mentioned or addressed by name. */
function addressedToBot(message) {
  if (message.mention?.mentionees?.some((m) => m.isSelf)) return true;
  const t = (message.text || '').trim();
  return new RegExp(`^@?${escapeRegex(config.botName)}\\b`, 'i').test(t);
}

function stripMention(message) {
  let t = message.text || '';
  const mentions = (message.mention?.mentionees || []).filter((m) => m.isSelf).sort((a, b) => b.index - a.index);
  for (const m of mentions) t = t.slice(0, m.index) + t.slice(m.index + m.length);
  return t.replace(new RegExp(`^\\s*@?${escapeRegex(config.botName)}\\b[\\s,:]*`, 'i'), '').trim() || t.trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------------------------- text

async function handleText(text, ctx) {
  const trimmed = text.trim();
  const brain = brainFor(ctx.tenant);

  if (/^เชื่อม\s*(drive|google|ไดรฟ์)/i.test(trimmed)) {
    ctx.attachments.push(multiUserEnabled() ? connectCard(ctx.userId) : textMessage('บัญชีนี้เชื่อมผ่านการตั้งค่าของเจ้าของบอทอยู่แล้ว'));
    return;
  }

  // Bare links (or link + a few words) are archived straight to notes.md.
  const urls = trimmed.match(/https?:\/\/\S+/g) || [];
  const remainder = trimmed.replace(/https?:\/\/\S+/g, '').trim();
  if (urls.length > 0 && remainder.length < 15) {
    const file = await ctx.svc.drive.appendNote(trimmed, ctx.now);
    ctx.attachments.push(
      textMessage('จดลิงก์ไว้ให้แล้ว 🔗'),
      infoCard('📝 โน้ตวันนี้', [`${ctx.svc.drive.todayKey(ctx.now)}/notes.md`], { buttons: [linkButton('เปิดโน้ต', file.webViewLink)] }),
    );
    if (brain && config.autoScan !== 'off') await scanLink(urls[0], ctx);
    return;
  }

  // A pending "change time" flow from a card button.
  const state = await ctx.svc.store.getUserState(ctx.userId);
  let hint;
  if (state.pending?.type === 'reschedule') {
    hint = `ผู้ใช้กำลังเปลี่ยนเวลาเตือน id=${state.pending.id} ("${state.pending.text}") ข้อความนี้คือเวลาใหม่ ให้เรียก reschedule_reminder`;
    await ctx.svc.store.setUserState(ctx.userId, { pending: null });
  }

  if (brain) {
    const { text: answer, attachments } = await brain.chat({
      userId: ctx.userId, text: trimmed, hint,
      ctx: { svc: ctx.svc, tenant: ctx.tenant, tenantId: ctx.tenantId, chatId: ctx.chatId, chatType: ctx.chatType },
    });
    if (answer) ctx.attachments.push(textMessage(answer));
    ctx.attachments.push(...attachments);
    if (ctx.attachments.length === 0) ctx.attachments.push(textMessage('โอเค 👍'));
    return;
  }

  await fallbackText(trimmed, ctx);
}

/** Keyword-only mode when no AI key (GEMINI_API_KEY / ANTHROPIC_API_KEY) is configured. */
async function fallbackText(text, ctx) {
  let m;
  if ((m = /^(?:หา|ค้นหา|ค้น)\s+(.+?)\s*(?:หน่อย|ที|ให้หน่อย)?$/.exec(text)) && !/^(?:ไฟล์|รูป|วิดีโอ|คลิป)/.test(m[1])) {
    const r = await handlers.search({ query: m[1] }, ctx);
    const lines = [];
    if (r.files.length) lines.push(`ไฟล์ ${r.files.length} รายการ (ดูการ์ดด้านล่าง)`);
    if (r.opportunities.length) lines.push(`deadline ${r.opportunities.length} รายการ`);
    for (const x of r.memories) lines.push(`🧠 ${x.text} (บันทึก ${x.savedAt})`);
    ctx.attachments.unshift(textMessage(lines.length ? `เจอเกี่ยวกับ "${m[1]}":\n` + lines.join('\n') : `ไม่เจออะไรเกี่ยวกับ "${m[1]}" เลย ลองคำอื่นดูนะ`));
    return;
  }
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
    const r = await handlers.recall({ query: m[1] }, ctx);
    if (r.note === 'matched') {
      ctx.attachments.push(textMessage('เจอแล้ว\n\n' + r.memories.map((x) => `${x.text}\n(บันทึก ${x.savedAt})`).join('\n\n')));
      return;
    }
  }
  if (/เตือน|calendar|ปฏิทิน/i.test(text)) {
    ctx.attachments.push(textMessage('การเตือนและปฏิทินต้องเปิดโหมด AI ก่อน (ใส่ GEMINI_API_KEY) ตอนนี้จดข้อความไว้ให้แทนนะ'));
  }
  const file = await ctx.svc.drive.appendNote(text, ctx.now);
  ctx.attachments.push(infoCard('📝 จดไว้แล้ว', [`${ctx.svc.drive.todayKey(ctx.now)}/notes.md`], { buttons: [linkButton('เปิดโน้ต', file.webViewLink)] }));
}

// -------------------------------------------------------------- postbacks

async function handlePostback(event, ctx) {
  const params = new URLSearchParams(event.postback?.data || '');
  const action = params.get('action');
  const id = params.get('id');
  const { store, drive, calendar } = ctx.svc;
  const brain = brainFor(ctx.tenant);

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
      ctx.attachments.push(textMessage(`โอเค อีก ${label} เดี๋ยวเตือนอีกที`), reminderCard(r, { timeZone: tz, now: ctx.now, title: '⏰ เลื่อนให้แล้ว' }));
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
      ctx.attachments.push(textMessage(ctx.chatType === 'user' ? welcomeText() : groupIntroText()));
      return;
    case 'opp_list':
    case 'menu_deadlines':
      await handlers.list_opportunities({}, ctx);
      return;
    case 'opp_delete': {
      const removed = await deleteOpportunity(id, ctx);
      ctx.attachments.push(textMessage(removed ? `ลบ "${removed.title}" ออกแล้ว (เตือนที่เกี่ยวข้องก็ยกเลิกให้)` : 'รายการนี้ถูกลบไปแล้ว'));
      return;
    }
    case 'scan': {
      const fileId = params.get('file');
      if (!brain || !fileId) return void ctx.attachments.push(textMessage('ตอนนี้อ่านให้ไม่ได้ ลองใหม่อีกทีนะ'));
      const info = await drive.fileInfo(fileId);
      const buffer = await drive.download(fileId);
      const read = await readMedia(buffer, info.mimeType, info, ctx);
      if (read?.opp) ctx.attachments.push(textMessage(scanIntro(read.opp)), opportunityCard(read.opp, { timeZone: tz, now: ctx.now }));
      else ctx.attachments.push(textMessage(read?.fields?.caption ? `อ่านแล้ว เป็น${read.fields.caption} ไม่ใช่ประกาศรับสมัคร แต่จดคำค้นไว้ให้แล้ว` : 'อ่านแล้ว แต่ไม่เจอว่าเป็นประกาศรับสมัครนะ'));
      return;
    }
    case 'list_reminders':
    case 'menu_reminders':
      await handlers.list_reminders({}, ctx);
      return;
    case 'menu_files': {
      const files = withThumbs(await drive.recentFiles(5), ctx);
      if (files.length === 0) ctx.attachments.push(textMessage('ยังไม่มีไฟล์เลย ส่งรูปหรือไฟล์มาได้เลย เดี๋ยวเก็บให้'));
      else ctx.attachments.push(textMessage('ไฟล์ล่าสุดที่เก็บไว้ พิมพ์ "หา <คำค้น>" เพื่อค้นหาได้นะ'), filesCarousel(files, { title: '📁 ไฟล์ล่าสุด' }));
      if (publicBase) ctx.attachments.push(galleryCard(ctx));
      return;
    }
    case 'menu_notes': {
      const memories = await store.memories();
      const recent = memories.slice(-5).reverse();
      const lines = recent.length
        ? recent.map((m) => `• ${m.text.split('\n')[0].slice(0, 60)}`)
        : ['ยังไม่มีอะไรที่จำไว้เลย พิมพ์ "ช่วยจำ ..." ได้เลย'];
      ctx.attachments.push(infoCard(`🧠 จำไว้ ${memories.length} เรื่อง`, lines, {
        buttons: [linkButton('เปิดโฟลเดอร์ Drive', await drive.rootFolderLink())],
      }));
      return;
    }
    case 'group_host':
      await becomeHost(ctx);
      return;
    case 'group_share': {
      if (ctx.tenant.type !== 'group') return void ctx.attachments.push(textMessage('ปุ่มนี้ใช้ในกลุ่มเท่านั้น'));
      if (ctx.tenant.hostUserId !== ctx.userId) return void ctx.attachments.push(textMessage('เฉพาะเจ้าของโฟลเดอร์กลุ่มเท่านั้นที่แชร์ได้นะ'));
      const link = await drive.shareRootFolder();
      ctx.attachments.push(infoCard('📂 โฟลเดอร์ของกลุ่ม', ['ทุกคนที่มีลิงก์นี้เปิดดูได้', `${config.driveRootFolderName}/Groups/${ctx.tenant.name}`], { buttons: [linkButton('เปิดโฟลเดอร์', link)] }));
      return;
    }
    case 'disconnect': {
      if (ctx.chatType !== 'user') return void ctx.attachments.push(textMessage('ยกเลิกการเชื่อมได้ในแชทส่วนตัวกับบอทเท่านั้น'));
      if (tenants.isOwner(ctx.userId)) return void ctx.attachments.push(textMessage('บัญชีเจ้าของบอทเชื่อมผ่านการตั้งค่าเซิร์ฟเวอร์ ยกเลิกจากตรงนี้ไม่ได้'));
      const groups = await tenants.groupsHostedBy(ctx.userId);
      for (const g of groups) await tenants.remove(g.id);
      await tenants.remove(ctx.userId);
      ctx.attachments.push(textMessage(`ยกเลิกการเชื่อม Google Drive แล้ว ไฟล์ที่เก็บไว้ยังอยู่ใน Drive ของคุณตามเดิม${groups.length ? ` (กลุ่มที่คุณดูแล ${groups.length} กลุ่มต้องเลือกเจ้าของใหม่)` : ''}\nถ้าอยากใช้อีก พิมพ์ "เชื่อม Drive" ได้เลย`));
      return;
    }
    case 'menu_ai': {
      if (!provider) { ctx.attachments.push(textMessage('ยังไม่ได้เปิดโหมด AI')); return; }
      const snap = await aiUsage.snapshot(provider.models, ctx.now);
      const lines = snap.models.map((m) => {
        const cap = m.limit ? `/${m.limit}` : '';
        const state = m.exhausted ? 'หมดแล้ว ❌' : m.limit && m.used >= m.limit ? 'น่าจะหมดแล้ว' : 'ใช้ได้ ✅';
        return `• ${m.model}: ใช้ไป ${m.used}${cap} ครั้ง ${state}`;
      });
      lines.push(`รวมวันนี้ ${snap.total} ครั้ง · รีเซ็ต ${describeReset(snap.resetAt, tz, ctx.now)}`);
      lines.push('1 ครั้ง = แชท 1 ข้อความ หรืออ่านโปสเตอร์/ลิงก์ 1 ชิ้น ลิมิตของ Gemini แบบฟรีนับแยกตามโมเดล ตัวเลขลิมิตจะรู้เมื่อโมเดลนั้นเคยชนลิมิตแล้ว');
      ctx.attachments.push(infoCard('🤖 โควตา AI วันนี้', lines));
      return;
    }
    case 'menu_settings': {
      let cal = 'ยังไม่เชื่อม';
      try { await calendar.listUpcoming({ days: 1, max: 1 }); cal = 'เชื่อมแล้ว ✅'; } catch { /* keep default */ }
      const email = await drive.accountEmail();
      const lines = [
        `ชื่อบอท: ${config.botName}`,
        ctx.tenant.type === 'group'
          ? `ที่เก็บของกลุ่ม: ${config.driveRootFolderName}/Groups/${ctx.tenant.name} (Drive ของ ${email || 'เจ้าของโฟลเดอร์'})`
          : `Google Drive: ${email || 'บัญชีของคุณ'} → ${config.driveRootFolderName}/`,
        `Google Calendar: ${cal}`,
        `โหมด AI: ${brain ? brain.label : 'ปิด (ยังไม่ได้ใส่ GEMINI_API_KEY)'}`,
        ...(provider ? [await aiUsageLine()] : []),
        `อ่านโปสเตอร์/ลิงก์อัตโนมัติ: ${{ always: 'เปิด', ask: 'ถามก่อน', off: 'ปิด' }[config.autoScan] || config.autoScan}`,
        `เขตเวลา: ${tz}`,
        `LINE user ID: ${ctx.userId}`,
      ];
      const buttons = [
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          postbackButton('การเตือน', 'action=list_reminders', 'ดูการเตือนทั้งหมด'),
          postbackButton('สิ่งที่จำไว้', 'action=menu_notes', 'ดูสิ่งที่จำไว้'),
        ] },
      ];
      if (provider) buttons.push(postbackButton('โควตา AI วันนี้', 'action=menu_ai', 'ดูโควตา AI'));
      if (ctx.tenant.type === 'group' && ctx.tenant.hostUserId === ctx.userId) {
        buttons.push(postbackButton('แชร์ลิงก์โฟลเดอร์ให้กลุ่ม', 'action=group_share', 'แชร์ลิงก์โฟลเดอร์ให้กลุ่ม'));
      } else if (ctx.chatType === 'user' && !tenants.isOwner(ctx.userId) && multiUserEnabled()) {
        buttons.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          linkButton('เชื่อม Drive ใหม่', connectUrl(publicBase || '', config.gallerySecret, ctx.userId)),
          postbackButton('ยกเลิกการเชื่อม', 'action=disconnect', 'ยกเลิกการเชื่อม Google Drive'),
        ] });
      }
      ctx.attachments.push(infoCard('⚙️ ตั้งค่า', lines, { buttons }));
      return;
    }
    default:
      ctx.attachments.push(textMessage('ปุ่มนี้ยังไม่รู้จักเลย'));
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

async function archiveBinary(message, when, { keepBytes = false } = {}, ctx) {
  let body;
  let mimeType;
  if (message.contentProvider?.type === 'external' && message.contentProvider.originalContentUrl) {
    const resp = await fetch(message.contentProvider.originalContentUrl);
    if (!resp.ok) throw new Error(`external media fetch failed: ${resp.status}`);
    mimeType = resp.headers.get('content-type') || 'application/octet-stream';
    body = resp.body;
  } else {
    const r = await lineBlob.getMessageContentWithHttpInfo(message.id);
    mimeType = r.httpResponse.headers.get('content-type') || 'application/octet-stream';
    body = r.body;
  }
  const name = buildFileName(message, mimeType, when, ctx);
  if (!keepBytes) {
    const saved = await ctx.svc.drive.uploadStream({ name, mimeType, body, date: when });
    return { saved, buffer: null, mimeType };
  }
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const buffer = Buffer.concat(chunks);
  const saved = await ctx.svc.drive.uploadStream({ name, mimeType, body: Readable.from(buffer), date: when });
  return { saved, buffer, mimeType };
}

const SCAN_MAX_BYTES = 8 * 1024 * 1024;
function isScannable(mimeType, size) {
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();
  return size <= SCAN_MAX_BYTES && (base.startsWith('image/') || base === 'application/pdf');
}

/**
 * Read an image / PDF once: caption + tags go into the search index (and the
 * file is renamed after the caption when it still has a generic name); if it
 * announces something with a deadline, record that too.
 * Returns { fields, file, opp } or null on failure.
 */
async function readMedia(buffer, mimeType, file, ctx) {
  try {
    const { drive, store } = ctx.svc;
    const base = (mimeType || '').split(';')[0].trim().toLowerCase();
    const fields = await extractFromMedia(provider, { mimeType: base, base64: buffer.toString('base64') }, { now: ctx.now, timeZone: tz });
    if (!fields) return null;
    let current = file;
    if (fields.caption && /^\d{2}-\d{2}-\d{2}_(image|file|video|audio)_/.test(file.name)) {
      const slug = captionSlug(fields.caption);
      if (slug) {
        try { current = await drive.renameFile(file.id, `${file.name.slice(0, 8)}_${slug}`); } catch (err) { console.warn('rename failed', err?.message || err); }
      }
    }
    await store.indexFile(file.id, {
      name: current.name, day: current.day || file.day, mimeType: base, webViewLink: current.webViewLink,
      caption: fields.caption || '', tags: fields.tags || [],
    });
    let opp = null;
    if (fields.is_opportunity && fields.confidence >= 0.5) {
      opp = await registerOpportunity(fields, { ctx, source: { kind: base === 'application/pdf' ? 'pdf' : 'image', fileId: file.id, webViewLink: current.webViewLink } });
      withThumb(opp, ctx, { fileId: file.id, mimeType: base });
    }
    return { fields, file: current, opp };
  } catch (err) {
    console.error('read media failed', describeError(err));
    if (isQuotaError(err)) ctx.aiLimited = true;
    return null;
  }
}

/** Files by keyword: Drive name search plus the caption / tag index, deduplicated. */
async function searchFiles(query, limit, ctx) {
  const { drive, store } = ctx.svc;
  const [byName, byIndex] = await Promise.all([drive.findFiles(query, limit), store.searchFileIndex(query, limit)]);
  const seen = new Set();
  const out = [];
  for (const f of [...byIndex, ...byName]) {
    if (!f.id || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ id: f.id, name: f.name, day: f.day, mimeType: f.mimeType, webViewLink: f.webViewLink, size: f.size, caption: f.caption });
  }
  return out.slice(0, limit);
}

/** Give a file (or anything with a picture behind it) a card thumbnail URL. */
function withThumb(obj, ctx, { fileId = obj?.id, mimeType = obj?.mimeType } = {}) {
  if (!obj || !publicBase || !fileId) return obj;
  const m = (mimeType || '').toLowerCase();
  if (!(m.startsWith('image/') || m === 'application/pdf')) return obj;
  obj.thumbUrl = thumbUrl(publicBase, config.gallerySecret, ctx.tenantId, fileId);
  return obj;
}

function withThumbs(files, ctx) {
  for (const f of files) withThumb(f, ctx);
  return files;
}

function galleryCard(ctx) {
  return infoCard('🖼️ แกลเลอรี', ['ดูรูปและไฟล์ทั้งหมดเป็นปฏิทิน เลือกวัน ค้นหาได้ ลิงก์ใช้ได้ 24 ชั่วโมง'], {
    buttons: [linkButton('เปิดแกลเลอรี', galleryUrl(publicBase, config.gallerySecret, ctx.tenantId))],
  });
}

/** Fetch a link and read it like a poster. */
async function scanLink(url, ctx) {
  try {
    const text = await fetchPageText(url);
    if (text.length < 80) {
      if (config.autoScan === 'always') ctx.attachments.push(textMessage('เปิดหน้าเว็บนี้อ่านไม่ได้ ถ้าเป็นประกาศรับสมัคร ส่งรูปโปสเตอร์มาด้วยได้นะ เดี๋ยวจด deadline ให้'));
      return null;
    }
    const fields = await extractFromText(provider, text, { url, now: ctx.now, timeZone: tz });
    if (!fields?.is_opportunity || fields.confidence < 0.5) return null;
    if (!fields.link) fields.link = url;
    const opp = await registerOpportunity(fields, { ctx, source: { kind: 'link', url } });
    ctx.attachments.push(textMessage(scanIntro(opp)), opportunityCard(opp, { timeZone: tz, now: ctx.now }));
    return opp;
  } catch (err) {
    console.error('link scan failed', describeError(err));
    if (isQuotaError(err)) ctx.attachments.push(textMessage('AI ติดลิมิตชั่วคราว เลยยังไม่ได้อ่านลิงก์นี้ ส่งมาใหม่ทีหลังได้นะ'));
    return null;
  }
}

async function aiUsageLine() {
  try {
    const snap = await aiUsage.snapshot(provider.models);
    const dead = snap.models.filter((m) => m.exhausted).length;
    const note = dead === 0 ? '' : dead >= snap.models.length ? ' (หมดทุกโมเดลแล้ว)' : ` (หมดแล้ว ${dead}/${snap.models.length} โมเดล)`;
    return `AI วันนี้: ใช้ไป ${snap.total} ครั้ง${note} รีเซ็ต ${describeReset(snap.resetAt, tz)}`;
  } catch {
    return 'AI วันนี้: นับไม่ได้';
  }
}

function scanIntro(opp) {
  const n = opp.reminderIds?.length || 0;
  const dl = opp.deadline ? `หมดเขต ${describeDeadline(opp.deadline, tz)}` : 'ไม่เห็นวันหมดเขตในนี้';
  const kind = ({ competition: 'การแข่งขัน', application: 'ประกาศรับสมัคร', scholarship: 'ทุน', course: 'คอร์สอบรม', event: 'กิจกรรม' })[opp.kind] || 'ประกาศ';
  if (opp.duplicate) return `อันนี้จดไว้แล้วนะ (${kind}) ${dl} ไม่ได้จดซ้ำ`;
  return `อ่านแล้ว เป็น${kind} จดไว้ให้แล้ว 🎯 ${dl}${n ? ` ตั้งเตือนให้ ${n} ครั้งก่อนหมดเขต` : ''}`;
}

function normalizeTitle(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Save an opportunity, its deadline reminders, a calendar entry, and refresh
 * Opportunities.md. The same announcement sent twice (same deadline and a
 * matching title) updates the existing record instead of adding another.
 */
async function registerOpportunity(fields, { ctx, source }) {
  const { store, calendar } = ctx.svc;
  const title = fields.title || 'ไม่มีชื่อ';
  const deadline = fields.deadline || '';

  const existing = (await store.opportunities()).find((o) => {
    if ((o.deadline || '') !== deadline) return false;
    const a = normalizeTitle(o.title);
    const b = normalizeTitle(title);
    return a && b && (a === b || a.includes(b) || b.includes(a));
  });
  if (existing) {
    const patch = {};
    for (const k of ['organizer', 'summary', 'deadline_note', 'event_dates', 'eligibility', 'cost', 'link', 'contact']) {
      if (!existing[k] && fields[k]) patch[k] = fields[k];
    }
    if (Object.keys(patch).length) {
      await store.update('opportunities.json', [], (list) => { const o = list.find((x) => x.id === existing.id); if (o) Object.assign(o, patch); });
      await refreshOpportunitiesDoc(ctx);
    }
    return { ...existing, ...patch, duplicate: true };
  }

  const opp = await store.addOpportunity({
    title,
    kind: fields.kind || 'other',
    organizer: fields.organizer || '',
    summary: fields.summary || '',
    deadline,
    deadline_note: fields.deadline_note || '',
    event_dates: fields.event_dates || '',
    eligibility: fields.eligibility || '',
    cost: fields.cost || '',
    link: fields.link || '',
    contact: fields.contact || '',
    confidence: fields.confidence ?? 1,
    source,
    userId: ctx.userId,
    reminderIds: [],
  });

  if (opp.deadline) {
    const ids = [];
    for (const t of deadlineReminderTimes(opp.deadline, tz, ctx.now)) {
      const r = await store.addReminder({ userId: ctx.userId, text: `${t.label}: ${opp.title}`, at: t.at, repeat: 'none', oppId: opp.id });
      ids.push(r.id);
    }
    opp.reminderIds = ids;
    await store.update('opportunities.json', [], (list) => { const o = list.find((x) => x.id === opp.id); if (o) o.reminderIds = ids; });
    try {
      await calendar.createEvent({ title: `⏳ Deadline: ${opp.title}`, start: opp.deadline, allDay: true, description: [opp.summary, opp.link || opp.source?.webViewLink].filter(Boolean).join('\n') });
    } catch (err) {
      console.warn('calendar entry for deadline failed', err?.message || err);
    }
  }
  await refreshOpportunitiesDoc(ctx);
  return opp;
}

async function deleteOpportunity(id, ctx) {
  const { store } = ctx.svc;
  const removed = await store.removeOpportunity(id);
  if (!removed) return null;
  for (const r of await store.reminders()) if (r.oppId === id) await store.removeReminder(r.id);
  await refreshOpportunitiesDoc(ctx);
  return removed;
}

async function refreshOpportunitiesDoc(ctx) {
  try {
    await ctx.svc.drive.writeRootText('Opportunities.md', renderMarkdown(await ctx.svc.store.opportunities(), tz, ctx.now || new Date()));
  } catch (err) {
    console.warn('Opportunities.md refresh failed', err?.message || err);
  }
}

function buildFileName(message, mimeType, when, ctx) {
  const stamp = ctx.svc.drive.timeKey(when);
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
async function reply(replyToken, to, messages) {
  const batch = messages.filter(Boolean).slice(0, 5);
  if (batch.length === 0) return;
  try {
    await lineClient.replyMessage({ replyToken, messages: batch });
  } catch (err) {
    if (err instanceof HTTPFetchError && to) {
      console.warn('reply failed, pushing instead', err.status, err.body);
      await lineClient.pushMessage({ to, messages: batch });
    } else {
      throw err;
    }
  }
}

function welcomeText() {
  return `สวัสดี เราคือ ${config.botName} 👋
ส่งอะไรมาก็ได้ เดี๋ยวเก็บให้หมดใน Google Drive ของคุณ

• ส่งรูป/ไฟล์/ลิงก์ → เก็บให้ทันที
• "เก็บไฟล์ bookbank" → ตั้งชื่อไฟล์ล่าสุด
• "หา ใบเสร็จ" → ค้นทุกอย่างที่เก็บไว้
• "ช่วยจำ ที่จอดรถชั้น 3 B12" → จำไว้ให้
• "เตือนกินยา 19.00" → ตั้งเตือน
• "ลง calendar พรุ่งนี้ 10 โมง ประชุม" → ลงปฏิทิน
• ส่งโปสเตอร์/ลิงก์รับสมัคร → จด deadline + เตือนก่อนหมดเขต
• ถามอะไรก็ได้ คุยเล่นก็ได้`;
}

function thaiDate(iso) {
  return new Intl.DateTimeFormat('th-TH', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

function describeError(err) {
  if (err instanceof HTTPFetchError) return `${err.status} ${err.body}`;
  return err?.stack || String(err);
}
