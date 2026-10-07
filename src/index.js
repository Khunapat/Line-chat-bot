import express from 'express';
import { middleware, messagingApi, HTTPFetchError, SignatureValidationFailed, JSONParseError } from '@line/bot-sdk';
import { config, requireConfig, resolveProvider, multiUserEnabled } from './config.js';
import { DriveArchive } from './drive.js';
import { Store } from './store.js';
import { isScopeError } from './calendar.js';
import { Brain } from './brain.js';
import { GeminiProvider } from './providers/gemini.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { isQuotaError } from './providers/errors.js';
import { Usage } from './providers/usage.js';
import { fireDueReminders, pendingReminders, describeWhen, describeRepeat } from './reminders.js';
import {
  textMessage, fileCard, filesCarousel, reminderCard, reminderListCard, dueReminderCard, eventCard,
  infoCard, linkButton, postbackButton, opportunityCard, opportunityListCard, scanOfferCard,
  deadlineAlertsMessage, alertSettingsCard, appliedCard, deletedCard,
} from './flex.js';
import {
  extractFromMedia, extractFromText, fetchPageText, sortOpportunities,
  describeDeadline, captionSlug, daysUntil, THAI_MONTHS,
  fetchPageMeta,
} from './opportunities.js';
import {
  oppCandidates, parseAlertCommand, describeAlerts, normalizeTime, normalizeDays, alertsFor, ALERT_PRESETS,
} from './deadlines.js';
import * as deadlines from './deadlineService.js';
import { withLock } from './lock.js';
import { registerGalleryRoutes, galleryUrl, thumbUrl, setGalleryTimeZone } from './gallery.js';
import { setAssetBase, linkAsFile } from './flex.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerOAuthRoutes, connectUrl, baseUrlOf } from './oauth.js';
import { Tenants } from './tenants.js';
import { Readable } from 'node:stream';
import { L, withLang, currentLang } from './lang.js';
import { Prefs } from './prefs.js';
import { registerAppRoutes } from './appApi.js';
import { registerWebApp } from './webApp.js';
import { verifyLineIdToken } from './appAuth.js';
import { formatTime, formatDay, zoned } from '../web/shared/dates.js';

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
const prefs = new Prefs(ownerStore);
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
    ctx.attachments.push(infoCard(L('b_noteSaved'), [`${ctx.svc.drive.todayKey(ctx.now)}/notes.md`], {
      buttons: [linkButton(L('b_openNote'), file.webViewLink)],
    }));
    return { ok: true, file: file.name, day: ctx.svc.drive.todayKey(ctx.now) };
  },

  async find_file({ query }, ctx) {
    const files = withThumbs(await searchFiles(query, 5, ctx), ctx);
    if (files.length === 0) return { found: 0, files: [] };
    ctx.attachments.push(filesCarousel(files, { title: files.length > 1 ? L('b_foundN', { n: files.length }) : L('b_foundOne') }));
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
    if (files.length) ctx.attachments.push(filesCarousel(withThumbs(files, ctx), { title: L('b_filesAbout', { q: query }) }));
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
    ctx.attachments.push(fileCard(withThumb(renamed, ctx), { title: L('b_savedCard') }));
    return { ok: true, name: renamed.name };
  },

  async set_reminder({ text, at, repeat }, ctx) {
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return { error: 'invalid datetime' };
    if (when < ctx.now && (!repeat || repeat === 'none')) return { error: 'time is in the past; ask the user for a new time' };
    // Monthly / yearly repeats remember their day, so the 31st stays the 31st after a short month.
    const anchorDay = repeat === 'monthly' || repeat === 'yearly' ? Number(zoned(when, tz).key.slice(8)) : undefined;
    const r = await ctx.svc.store.addReminder({ userId: ctx.userId, text, at: when.toISOString(), repeat: repeat || 'none', ...(anchorDay ? { anchorDay } : {}) });
    ctx.attachments.push(reminderCard(r, { timeZone: tz, now: ctx.now }));
    return { ok: true, id: r.id, when: describeWhen(r.at, tz, ctx.now), repeat: describeRepeat(r.repeat) };
  },

  async list_reminders(_input, ctx) {
    const all = pendingReminders(await ctx.svc.store.reminders());
    // Deadline alerts belong to their deadline (menu Deadline), not this list.
    const list = all.filter((r) => !r.oppId);
    const deadlineAlerts = all.length - list.length;
    ctx.attachments.push(reminderListCard(list, { timeZone: tz, now: ctx.now, deadlineAlerts }));
    return {
      reminders: list.map((r) => ({ id: r.id, text: r.text, when: describeWhen(r.at, tz, ctx.now), repeat: r.repeat })),
      deadline_alerts_pending: deadlineAlerts,
    };
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
    ctx.attachments.push(reminderCard(r, { timeZone: tz, now: ctx.now, title: L('b_rescheduled') }));
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
    // The model saw the recently saved items (in its hint) and chose same_as or not.
    const r = await deadlines.registerOpportunity(ctx.svc, { ...fields, is_opportunity: true, confidence: 1, ai_checked: Boolean(ctx.oppHintGiven) }, {
      source: { kind: 'text' }, userId: ctx.userId, timeZone: tz, now: ctx.now,
    });
    await rememberMerge(r, ctx);
    ctx.attachments.push(await oppCardFor(r, ctx));
    return {
      ok: true, id: r.opp.id, merged_into_existing: r.merged, added_details: r.added,
      deadline: describeDeadline(r.opp.deadline, tz, ctx.now), alerts: r.opp.reminderIds?.length || 0,
    };
  },

  async list_opportunities(_input, ctx) {
    const list = await ctx.svc.store.opportunities();
    const alerts = await deadlines.alertSettings(ctx.svc);
    ctx.attachments.push(opportunityListCard(list, { timeZone: tz, now: ctx.now, alerts }));
    return {
      alert_schedule: describeAlerts(alerts),
      opportunities: sortOpportunities(list, tz, ctx.now).map((o) => ({
        id: o.id, title: o.title, kind: o.kind, deadline: o.deadline, when: describeDeadline(o.deadline, tz, ctx.now),
        status: o.status === 'applied' ? 'applied' : 'open', link: o.link || o.source?.webViewLink || '',
      })),
    };
  },

  async delete_opportunity({ id }, ctx) {
    const removed = await removeOpportunityWithUndo(id, ctx);
    return removed ? { ok: true, title: removed.title } : { error: 'not found' };
  },

  async mark_opportunity_applied({ id, applied }, ctx) {
    const opp = await deadlines.setApplied(ctx.svc, id, applied, { timeZone: tz, now: ctx.now });
    if (!opp) return { error: 'not found' };
    ctx.attachments.push(applied ? appliedCard(opp) : await detailCard(opp, ctx));
    return { ok: true, title: opp.title, applied, alerts: opp.reminderIds?.length || 0 };
  },

  async set_deadline_alerts({ days, time, id, off }, ctx) {
    const t = time ? normalizeTime(time) : null;
    if (time && !t) return { error: 'time must be HH:MM, e.g. 20:00' };
    const d = normalizeDays(days);
    if (Array.isArray(days) && days.length > 0 && d.length === 0) return { error: 'days must be whole numbers from 0 to 60' };
    if (!off && d.length === 0 && !t) return { error: 'nothing to change: give days, time or off' };
    if (id && (off || d.length)) {
      // Days (or off) for this one item; the time of day is shared by every deadline.
      const r = await deadlines.setAlertSettings(ctx.svc, { off: Boolean(off), days: d.length ? d : undefined, oppId: id }, { timeZone: tz, now: ctx.now });
      if (!r) return { error: 'not found' };
      if (t) await deadlines.setAlertSettings(ctx.svc, { time: t }, { timeZone: tz, now: ctx.now });
      const base = await deadlines.alertSettings(ctx.svc);
      ctx.attachments.push(alertSettingsCard(base, { opp: r.opp }));
      return { ok: true, scope: 'item', schedule: describeAlerts(alertsFor(r.opp, base)), time_changed_for_all: t || undefined };
    }
    const r = await deadlines.setAlertSettings(ctx.svc, { off: Boolean(off), days: d.length ? d : undefined, time: t || undefined }, { timeZone: tz, now: ctx.now });
    ctx.attachments.push(alertSettingsCard(r.alerts));
    return { ok: true, scope: 'all', schedule: describeAlerts(r.alerts), note: id ? 'only a time was given, and the time applies to every deadline' : undefined };
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
      // Pushes use the person's language; a group uses its host's.
      const lang = await prefs.langFor(tenant.type === 'group' ? tenant.hostUserId : tenant.id).catch(() => 'th');
      await withLang(lang, async () => {
        try {
          const svc = await tenants.services(tenant);
          if (!svc) return;
          summary.tenants++;
          const now = new Date();
          try {
            if (await deadlines.ensureAlertsUpToDate(svc, { timeZone: tz, now })) console.log('deadline alerts re-planned for', tenant.id);
          } catch (err) {
            console.warn('re-planning deadline alerts failed', tenant.id, describeError(err));
          }
          const r = await fireDueReminders(svc.store, async (due) => {
            const messages = await dueMessages(due, svc, tenant, now);
            // One push carries up to 5 messages and counts once against LINE's monthly quota.
            for (let i = 0; i < messages.length; i += 5) {
              await lineClient.pushMessage({ to: tenant.id, messages: messages.slice(i, i + 5) });
            }
          }, now, { batch: true, timeZone: tz });
          summary.fired += r.fired;
        } catch (err) {
          summary.errors++;
          console.error('cron tenant failed', tenant.id, describeError(err));
        }
      });
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

// Web app (LIFF): static page + JSON API. Data routes need a LINE-verified session.
registerWebApp(app);
registerAppRoutes(app, {
  tenants,
  lineClient,
  sessionSecret: config.appSessionSecret,
  prefs,
  timeZone: tz,
  verifyIdToken: (idToken) => verifyLineIdToken(idToken, { channelId: config.lineLoginChannelId }),
  aiUsage: async (now) => (provider ? aiUsage.snapshot(provider.models, now) : null),
  thumbUrlFor: (req, tenantId, fileId) => thumbUrl(publicBase || baseUrlOf(req), config.gallerySecret, tenantId, fileId),
  connectUrlFor: (req, userId) => connectUrl(publicBase || baseUrlOf(req), config.gallerySecret, userId),
  onLangChanged: linkRichMenuFor,
  settings: { liffId: config.liffId, rootFolderName: config.driveRootFolderName, botName: config.botName, multiUser: multiUserEnabled(), preview: false },
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
      messages: await withLang(await prefs.langFor(userId), () => [textMessage(L('b_connected', { who: email || name || L('b_you'), root: config.driveRootFolderName })), textMessage(welcomeText())]),
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

/** Every event runs in the sender's language (their choice in the web app; Thai by default). */
async function handleEvent(event) {
  const lang = await prefs.langFor(event.source?.userId).catch(() => 'th');
  return withLang(lang, () => handleEventIn(event));
}

async function handleEventIn(event) {
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
    await reply(replyToken, chatId, [textMessage(L('b_firstId', { id: userId }))]);
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
        await ctx.svc.store.remember(['📍 ' + (title || L('b_location')), address, maps].filter(Boolean).join('\n'), { userId });
        ctx.attachments.push(textMessage(L('b_locationSaved')));
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
          showLoading(ctx);
          read = await readMedia(buffer, mimeType, saved, ctx);
          if (read?.file) file = read.file;
        }
        await ctx.svc.store.setUserState(userId, { lastFile: file });
        const what = read?.fields?.caption ? `${kindThai(message.type)} (${read.fields.caption})` : kindThai(message.type);
        if (chatType === 'user') ctx.attachments.push(textMessage(L('b_mediaSaved', { what })));
        withThumb(file, ctx, { mimeType });
        if (read?.fields?.caption) file.caption = read.fields.caption;
        ctx.attachments.push(fileCard(file, { title: chatType === 'user' ? L('b_savedCard') : L('b_savedGroupCard') }));
        if (ctx.aiLimited) ctx.attachments.push(textMessage(L('b_aiLimitedFile')));
        if (read?.reg) ctx.attachments.push(textMessage(scanIntro(read.reg)), await oppCardFor(read.reg, ctx));
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
    const text = isQuotaError(err) ? L('b_quota') : L('b_error');
    await reply(replyToken, chatId, [textMessage(text)]).catch(() => {});
  }
}

// ---------------------------------------------------------------- onboarding

/** Messages for someone who has not connected a Drive yet. */
async function onboardingMessages(userId, text) {
  if (!multiUserEnabled()) {
    return [textMessage(L('b_ownerOnly', { bot: config.botName }))];
  }
  if (config.inviteCode) {
    const invites = await ownerStore.read('invites.json', {});
    if (!invites[userId]) {
      if (text && text.trim() === config.inviteCode) {
        await ownerStore.update('invites.json', {}, (inv) => { inv[userId] = { at: new Date().toISOString() }; });
      } else {
        return [textMessage(L('b_inviteAsk', { bot: config.botName }))];
      }
    }
  }
  return [textMessage(L('b_hello', { bot: config.botName })), connectCard(userId)];
}

function connectCard(userId) {
  const lines = [L('b_connectBody')];
  if (!publicBase) return infoCard(L('b_connectTitle'), [L('b_connectLater')]);
  return infoCard(L('b_connectTitle'), lines, { buttons: [linkButton(L('b_connectBtn'), connectUrl(publicBase, config.gallerySecret, userId))] });
}

function hostCard() {
  return infoCard(L('b_hostTitle'), [L('b_hostBody', { root: config.driveRootFolderName })], {
    buttons: [postbackButton(L('b_hostBtn'), 'action=group_host', L('b_hostBtn'))],
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
    ctx.attachments.push(textMessage(L('b_hostNeedsDrive')));
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
    textMessage(L('b_hostDone', { host: host.name || L('b_hostDefault'), path: `${config.driveRootFolderName}/Groups/${safe}` })),
    infoCard(L('b_groupReady'), [L('b_groupReady1', { bot: config.botName }), L('b_groupReady2')], {
      buttons: [postbackButton(L('b_shareFolder'), 'action=group_share', L('b_shareFolder'))],
    }),
  );
}

function groupIntroText() {
  return L('b_groupIntro', { bot: config.botName });
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

  if (/^(?:เชื่อม|connect)\s*(drive|google|ไดรฟ์)/i.test(trimmed)) {
    ctx.attachments.push(multiUserEnabled() ? connectCard(ctx.userId) : textMessage(L('b_ownerConnected')));
    return;
  }

  // "เตือน deadline ก่อน 10 5 2 1 วัน 20:00" works without AI.
  const alertCmd = parseAlertCommand(trimmed);
  if (alertCmd) {
    const r = await deadlines.setAlertSettings(ctx.svc, alertCmd.off ? { off: true } : { days: alertCmd.days, time: alertCmd.time }, { timeZone: tz, now: ctx.now });
    ctx.attachments.push(
      textMessage(alertCmd.off
        ? L('b_alertsOffDone')
        : L('b_alertsSetDone', { desc: describeAlerts(r.alerts) })),
      alertSettingsCard(r.alerts),
    );
    return;
  }

  // Bare links (or link + a few words) are archived straight to notes.md.
  const urls = trimmed.match(/https?:\/\/\S+/g) || [];
  const remainder = trimmed.replace(/https?:\/\/\S+/g, '').trim();
  if (urls.length > 0 && remainder.length < 15) {
    const url = urls[0];
    const [, page] = await Promise.all([ctx.svc.drive.appendNote(trimmed, ctx.now), fetchPageMeta(url)]);
    const link = await ctx.svc.store.addLink({
      url, title: page.title || remainder, day: ctx.svc.drive.todayKey(ctx.now), at: ctx.now.toISOString(), userId: ctx.userId,
    });
    await ctx.svc.store.setUserState(ctx.userId, { lastFile: linkAsFile(link) });
    ctx.attachments.push(
      textMessage(L('b_linkSaved')),
      fileCard(linkAsFile(link), { title: L('b_linkCard') }),
    );
    if (brain && config.autoScan !== 'off') await scanLink(url, ctx, { text: page.text, linkId: link.id });
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
    showLoading(ctx);
    // One AI step at a time per chat: a poster sent with this message is read
    // and saved first, so the model below can see it and merge instead of
    // saving the same activity twice.
    await inAiTurn(ctx, async () => {
      const recent = await deadlines.recentOpportunities(ctx.svc, { userId: ctx.userId, now: ctx.now });
      const oppHint = recent.length
        ? `deadline ที่เพิ่งบันทึกในแชทนี้: ${recent.map((o) => `[id=${o.id}] ${o.title} (หมดเขต ${o.deadline || 'ไม่ระบุ'})`).join('; ')} ถ้าข้อความนี้เป็นงานเดียวกัน ให้เรียก save_opportunity พร้อม same_as=id นั้น เพื่อเพิ่มรายละเอียดเข้ารายการเดิม`
        : '';
      const { text: answer, attachments } = await brain.chat({
        userId: ctx.userId, text: trimmed, hint: [hint, oppHint, await styleHint(ctx)].filter(Boolean).join('\n') || undefined,
        ctx: { svc: ctx.svc, tenant: ctx.tenant, tenantId: ctx.tenantId, chatId: ctx.chatId, chatType: ctx.chatType, oppHintGiven: recent.length > 0 },
      });
      if (answer) ctx.attachments.push(textMessage(answer));
      ctx.attachments.push(...attachments);
    });
    if (ctx.attachments.length === 0) ctx.attachments.push(textMessage(L('b_ok')));
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
    if (r.files.length) lines.push(L('b_foundFiles', { n: r.files.length }));
    if (r.opportunities.length) lines.push(L('b_foundDl', { n: r.opportunities.length }));
    for (const x of r.memories) lines.push(`🧠 ${x.text} ${L('b_savedAtLine', { when: x.savedAt })}`);
    ctx.attachments.unshift(textMessage(lines.length ? L('b_found', { q: m[1], lines: lines.join('\n') }) : L('b_notFound', { q: m[1] })));
    return;
  }
  if ((m = /^(?:ขอ|หา|ค้นหา)\s*(?:ไฟล์|รูป|วิดีโอ|คลิป)\s*(.*?)\s*(?:หน่อย|ที|ให้หน่อย)?$/.exec(text))) {
    const r = await handlers.find_file({ query: m[1] }, ctx);
    if (r.found === 0) ctx.attachments.push(textMessage(L('b_noFileFound')));
    else ctx.attachments.unshift(textMessage(L('b_fileFound')));
    return;
  }
  if ((m = /^(?:เก็บไฟล์|ตั้งชื่อไฟล์(?:ว่า)?|ไฟล์นี้คือ)\s*(.+?)\s*(?:หน่อย|ให้หน่อย|ที)?$/.exec(text))) {
    const r = await handlers.name_last_file({ label: m[1] }, ctx);
    ctx.attachments.unshift(textMessage(r.error ? L('b_noFileToName') : L('b_named', { name: r.name })));
    return;
  }
  if ((m = /^(?:ช่วย)?(?:จำ|บันทึก)(?:ว่า|ไว้ว่า)?\s*(.+)$/s.exec(text))) {
    await handlers.remember({ text: m[1] }, ctx);
    ctx.attachments.push(textMessage(L('b_remembered')));
    return;
  }
  if ((m = /^(?:ขอ|มี|หา)\s*(.+?)\s*(?:หน่อย|ไหม|มั้ย|บ้าง|ที)?$/.exec(text))) {
    const r = await handlers.recall({ query: m[1] }, ctx);
    if (r.note === 'matched') {
      ctx.attachments.push(textMessage(L('b_foundMem', { list: r.memories.map((x) => `${x.text}\n${L('b_savedAtLine', { when: x.savedAt })}`).join('\n\n') })));
      return;
    }
  }
  if (/เตือน|calendar|ปฏิทิน/i.test(text)) {
    ctx.attachments.push(textMessage(L('b_needAi')));
  }
  const file = await ctx.svc.drive.appendNote(text, ctx.now);
  ctx.attachments.push(infoCard(L('b_noteSaved'), [`${ctx.svc.drive.todayKey(ctx.now)}/notes.md`], { buttons: [linkButton(L('b_openNote'), file.webViewLink)] }));
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
      if (!original) return void ctx.attachments.push(textMessage(L('b_reminderGoneSet')));
      const at = new Date(ctx.now.getTime() + minutes * 60_000).toISOString();
      const r = original.repeat && original.repeat !== 'none'
        ? await store.addReminder({ userId: ctx.userId, text: original.text, at, repeat: 'none' })
        : await store.updateReminder(id, { at, firedAt: null });
      const label = minutes >= 60 ? L('b_hours', { n: Math.round(minutes / 60) }) : L('b_minutes', { n: minutes });
      ctx.attachments.push(textMessage(L('b_snoozeOk', { label })), reminderCard(r, { timeZone: tz, now: ctx.now, title: L('b_snoozedTitle') }));
      return;
    }
    case 'done': {
      const r = (await store.reminders()).find((x) => x.id === id);
      if (r && r.firedAt) await store.removeReminder(id);
      ctx.attachments.push(textMessage(L('b_doneOk')));
      return;
    }
    case 'cancel': {
      const removed = await store.removeReminder(id);
      ctx.attachments.push(textMessage(removed ? L('b_cancelled', { text: removed.text }) : L('b_alreadyCancelled')));
      return;
    }
    case 'reschedule': {
      const r = (await store.reminders()).find((x) => x.id === id);
      if (!r) return void ctx.attachments.push(textMessage(L('b_reminderGone')));
      if (!brain) return void ctx.attachments.push(textMessage(L('b_needAiReschedule')));
      await store.setUserState(ctx.userId, { pending: { type: 'reschedule', id: r.id, text: r.text } });
      ctx.attachments.push(textMessage(L('b_askNewTime', { text: r.text })));
      return;
    }
    case 'menu_new_reminder':
      // The rich-menu hero opens the keyboard; this is the nudge above it.
      ctx.attachments.push(textMessage(L('b_newReminderHint')));
      return;
    case 'menu_help':
      ctx.attachments.push(textMessage(ctx.chatType === 'user' ? welcomeText() : groupIntroText()));
      return;
    case 'opp_list':
    case 'menu_deadlines':
      await handlers.list_opportunities({}, ctx);
      return;
    case 'opp_view': {
      const o = await deadlines.getOpportunity(ctx.svc, id);
      ctx.attachments.push(o ? await detailCard(o, ctx, { title: L('b_detail') }) : textMessage(goneText()));
      return;
    }
    case 'opp_delete': {
      const removed = await removeOpportunityWithUndo(id, ctx);
      if (!removed) ctx.attachments.push(textMessage(goneText()));
      return;
    }
    case 'opp_restore': {
      const state = await store.getUserState(ctx.chatId);
      const stack = state.deleted || [];
      const snap = stack.find((x) => x.opp?.id === id)?.opp;
      if (!snap) return void ctx.attachments.push(textMessage(L('b_restoreExpired')));
      const back = await deadlines.restoreOpportunity(ctx.svc, snap, { timeZone: tz, now: ctx.now });
      await store.setUserState(ctx.chatId, { deleted: stack.filter((x) => x.opp?.id !== id) });
      if (!back) return void ctx.attachments.push(textMessage(L('b_alreadyBack')));
      ctx.attachments.push(textMessage(L('b_restored', { title: back.title })), await detailCard(back, ctx, { title: L('b_restoredTitle') }));
      return;
    }
    case 'opp_applied':
    case 'opp_unapplied': {
      const applied = action === 'opp_applied';
      const o = await deadlines.setApplied(ctx.svc, id, applied, { timeZone: tz, now: ctx.now });
      if (!o) return void ctx.attachments.push(textMessage(goneText()));
      if (applied) ctx.attachments.push(appliedCard(o));
      else ctx.attachments.push(textMessage(L('b_resumedOk')), await detailCard(o, ctx));
      return;
    }
    case 'opp_split': {
      const state = await store.getUserState(ctx.chatId);
      const lm = state.lastMerge;
      if (!lm || lm.before?.id !== id) return void ctx.attachments.push(textMessage(L('b_splitUnavailable')));
      const r = await deadlines.splitMerge(ctx.svc, lm, { userId: ctx.userId, timeZone: tz, now: ctx.now });
      await store.setUserState(ctx.chatId, { lastMerge: null });
      if (!r) return void ctx.attachments.push(textMessage(L('b_splitFailed')));
      ctx.attachments.push(textMessage(L('b_splitDone')));
      if (r.restored) ctx.attachments.push(await detailCard(r.restored, ctx, { title: L('b_origItem') }));
      ctx.attachments.push(await detailCard(r.created, ctx, { title: L('b_newItem') }));
      return;
    }
    case 'opp_merge': {
      const r = await deadlines.mergeInto(ctx.svc, id, params.get('src'), { timeZone: tz, now: ctx.now });
      if (!r) return void ctx.attachments.push(textMessage(L('b_mergeFailed')));
      await rememberMerge(r, ctx);
      ctx.attachments.push(textMessage(scanIntro(r)), await oppCardFor(r, ctx));
      return;
    }
    case 'alerts_menu': {
      const base = await deadlines.alertSettings(ctx.svc);
      const o = id ? await deadlines.getOpportunity(ctx.svc, id) : null;
      if (id && !o) return void ctx.attachments.push(textMessage(goneText()));
      ctx.attachments.push(alertSettingsCard(base, { opp: o }));
      return;
    }
    case 'alerts_set':
    case 'alerts_time':
    case 'alerts_off':
    case 'alerts_reset': {
      let change;
      if (action === 'alerts_set') {
        const preset = ALERT_PRESETS.find((x) => x.key === params.get('p'));
        if (!preset) return void ctx.attachments.push(textMessage(L('b_unknownPreset')));
        change = { days: preset.days };
      } else if (action === 'alerts_time') {
        const raw = String(params.get('t') || '');
        const t = normalizeTime(`${raw.slice(0, 2)}:${raw.slice(2)}`);
        if (!t) return void ctx.attachments.push(textMessage(L('b_badTime')));
        change = { time: t };
      } else if (action === 'alerts_off') {
        change = { off: true };
      } else {
        change = { reset: true };
      }
      const r = await deadlines.setAlertSettings(ctx.svc, { ...change, oppId: id || undefined }, { timeZone: tz, now: ctx.now });
      if (!r) return void ctx.attachments.push(textMessage(goneText()));
      const base = await deadlines.alertSettings(ctx.svc);
      const what = r.alerts.days.length ? L('b_alertsWhat', { desc: describeAlerts(r.alerts) }) : L('b_noAlerts');
      ctx.attachments.push(
        textMessage(r.scope === 'item' ? L('b_alertsItemDone', { title: r.opp.title, what }) : L('b_alertsAllDone', { what })),
        alertSettingsCard(base, { opp: r.scope === 'item' ? r.opp : null }),
      );
      return;
    }
    case 'scan': {
      const fileId = params.get('file');
      if (!brain || !fileId) return void ctx.attachments.push(textMessage(L('b_scanUnavailable')));
      const info = await drive.fileInfo(fileId);
      const buffer = await drive.download(fileId);
      const read = await readMedia(buffer, info.mimeType, info, ctx);
      if (read?.reg) ctx.attachments.push(textMessage(scanIntro(read.reg)), await oppCardFor(read.reg, ctx));
      else ctx.attachments.push(textMessage(read?.fields?.caption ? L('b_scanNotOpp', { caption: read.fields.caption }) : L('b_scanNothing')));
      return;
    }
    case 'list_reminders':
    case 'menu_reminders':
      await handlers.list_reminders({}, ctx);
      return;
    case 'menu_files': {
      const files = withThumbs(await recentItems(5, ctx), ctx);
      if (files.length === 0) ctx.attachments.push(textMessage(L('b_noFiles')));
      else ctx.attachments.push(textMessage(L('b_recentFiles')), filesCarousel(files, { title: L('b_recentFilesTitle') }));
      if (publicBase) ctx.attachments.push(galleryCard(ctx));
      return;
    }
    case 'menu_notes': {
      const memories = await store.memories();
      const recent = memories.slice(-5).reverse();
      const lines = recent.length
        ? recent.map((m) => `• ${m.text.split('\n')[0].slice(0, 60)}`)
        : [L('b_noMemories')];
      ctx.attachments.push(infoCard(L('b_memCount', { n: memories.length }), lines, {
        buttons: [linkButton(L('b_openDriveFolder'), await drive.rootFolderLink())],
      }));
      return;
    }
    case 'group_host':
      await becomeHost(ctx);
      return;
    case 'group_share': {
      if (ctx.tenant.type !== 'group') return void ctx.attachments.push(textMessage(L('b_groupOnly')));
      if (ctx.tenant.hostUserId !== ctx.userId) return void ctx.attachments.push(textMessage(L('b_hostOnly')));
      const link = await drive.shareRootFolder();
      ctx.attachments.push(infoCard(L('b_groupFolder'), [L('b_anyoneLink'), `${config.driveRootFolderName}/Groups/${ctx.tenant.name}`], { buttons: [linkButton(L('b_openFolder'), link)] }));
      return;
    }
    case 'disconnect': {
      if (ctx.chatType !== 'user') return void ctx.attachments.push(textMessage(L('b_privateOnly')));
      if (tenants.isOwner(ctx.userId)) return void ctx.attachments.push(textMessage(L('b_ownerNoDisconnect')));
      const groups = await tenants.groupsHostedBy(ctx.userId);
      for (const g of groups) await tenants.remove(g.id);
      await tenants.remove(ctx.userId);
      ctx.attachments.push(textMessage(L('b_disconnected', { groups: groups.length ? L('b_disconnectedGroups', { n: groups.length }) : '' })));
      return;
    }
    case 'menu_gallery': {
      if (publicBase) ctx.attachments.push(galleryCard(ctx));
      else ctx.attachments.push(textMessage(L('b_galleryLater')));
      return;
    }
    case 'menu_ai': {
      if (!provider) { ctx.attachments.push(textMessage(L('b_aiOff'))); return; }
      const snap = await aiUsage.snapshot(provider.models, ctx.now);
      const lines = snap.models.map((m) => {
        const cap = m.limit ? `/${m.limit}` : '';
        const state = m.exhausted ? L('b_aiDead') : m.limit && m.used >= m.limit ? L('b_aiProbablyDead') : L('b_aiOk');
        return L('b_aiModel', { model: m.model, used: m.used, cap, state });
      });
      lines.push(L('b_aiTotal', { n: snap.total, when: resetWhen(snap.resetAt, ctx.now) }));
      lines.push(L('b_aiExplain'));
      ctx.attachments.push(infoCard(L('b_aiTitle'), lines));
      return;
    }
    case 'menu_settings': {
      let cal = L('b_calNo');
      try { await calendar.listUpcoming({ days: 1, max: 1 }); cal = L('b_calOk'); } catch { /* keep default */ }
      const email = await drive.accountEmail();
      const lines = [
        L('b_botName', { name: config.botName }),
        ctx.tenant.type === 'group'
          ? L('b_groupStore', { root: config.driveRootFolderName, name: ctx.tenant.name, who: email || L('b_groupHostWord') })
          : L('b_driveLine', { email: email || L('b_yourAccount'), root: config.driveRootFolderName }),
        L('b_calLine', { state: cal }),
        L('b_aiMode', { state: brain ? brain.label : L('b_aiModeOff') }),
        ...(provider ? [await aiUsageLine()] : []),
        L('b_autoScan', { state: { always: L('b_scanAlways'), ask: L('b_scanAsk'), off: L('b_scanOff') }[config.autoScan] || config.autoScan }),
        L('b_dlAlertLine', { desc: describeAlerts(await deadlines.alertSettings(ctx.svc)) }),
        L('b_tzLine', { tz }),
        L('b_langLine'),
        L('b_userIdLine', { id: ctx.userId }),
      ];
      const buttons = [
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          postbackButton(L('b_btnReminders'), 'action=list_reminders', L('b_seeAllRemSaid')),
          postbackButton(L('b_btnMemory'), 'action=menu_notes', L('b_btnMemorySaid')),
        ] },
      ];
      buttons.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        postbackButton(L('b_btnDlAlerts'), 'action=alerts_menu', L('b_alertSettingsSaid')),
        ...(provider ? [postbackButton(L('b_btnAi'), 'action=menu_ai', L('b_btnAiSaid'))] : []),
      ] });
      if (ctx.tenant.type === 'group' && ctx.tenant.hostUserId === ctx.userId) {
        buttons.push(postbackButton(L('b_shareFolder'), 'action=group_share', L('b_shareFolder')));
      } else if (ctx.chatType === 'user' && !tenants.isOwner(ctx.userId) && multiUserEnabled()) {
        buttons.push({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
          linkButton(L('b_reconnect'), connectUrl(publicBase || '', config.gallerySecret, ctx.userId)),
          postbackButton(L('b_disconnect'), 'action=disconnect', L('b_disconnectSaid')),
        ] });
      }
      if (config.liffId) buttons.unshift(linkButton(L('b_openApp'), liffUrl('/me')));
      ctx.attachments.push(infoCard(L('b_settings'), lines, { buttons }));
      return;
    }
    default:
      ctx.attachments.push(textMessage(L('b_unknownButton')));
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
 * announces something with a deadline, record that too (or fold it into the
 * saved item it repeats). Runs one at a time per chat, see inAiTurn.
 * Returns { fields, file, opp, reg } or null on failure; `reg` is the
 * registration result from deadlineService.registerOpportunity.
 */
async function readMedia(buffer, mimeType, file, ctx) {
  return inAiTurn(ctx, () => readMediaNow(buffer, mimeType, file, ctx));
}

async function readMediaNow(buffer, mimeType, file, ctx) {
  try {
    const { drive, store } = ctx.svc;
    const base = (mimeType || '').split(';')[0].trim().toLowerCase();
    // The saved list lets the model say "this poster is item X" (same call, other words).
    const candidates = oppCandidates(await store.opportunities(), tz, ctx.now);
    const fields = await extractFromMedia(provider, { mimeType: base, base64: buffer.toString('base64') }, { now: ctx.now, timeZone: tz, candidates });
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
    let reg = null;
    if (fields.is_opportunity && fields.confidence >= 0.5) {
      reg = await deadlines.registerOpportunity(ctx.svc, fields, {
        source: { kind: base === 'application/pdf' ? 'pdf' : 'image', fileId: file.id, webViewLink: current.webViewLink },
        userId: ctx.userId, timeZone: tz, now: ctx.now,
      });
      await rememberMerge(reg, ctx);
    }
    return { fields, file: current, opp: reg?.opp || null, reg };
  } catch (err) {
    console.error('read media failed', describeError(err));
    if (isQuotaError(err)) ctx.aiLimited = true;
    return null;
  }
}

/** Newest files and saved links together, newest first. */
async function recentItems(limit, ctx) {
  const { drive, store } = ctx.svc;
  const [files, links] = await Promise.all([drive.recentFiles(limit), store.recentLinks(limit)]);
  const stamp = (x) => x.at || x.createdTime || x.modifiedTime || '';
  return [...files, ...links.map(linkAsFile)].sort((a, b) => (stamp(a) < stamp(b) ? 1 : -1)).slice(0, limit);
}

/** Files and links by keyword: Drive name search, the caption / tag index and saved links, deduplicated. */
async function searchFiles(query, limit, ctx) {
  const { drive, store } = ctx.svc;
  const [byName, byIndex, links] = await Promise.all([drive.findFiles(query, limit), store.searchFileIndex(query, limit), store.searchLinks(query, limit)]);
  const seen = new Set();
  const out = [];
  for (const f of [...byIndex, ...byName]) {
    if (!f.id || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ id: f.id, name: f.name, day: f.day, mimeType: f.mimeType, webViewLink: f.webViewLink, size: f.size, caption: f.caption });
  }
  const stamp = (x) => x.at || x.day || '';
  return [...out, ...links.map(linkAsFile)].sort((a, b) => (stamp(a) < stamp(b) ? 1 : -1)).slice(0, limit);
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
  return infoCard(L('b_galleryTitle'), [L('b_galleryBody')], {
    buttons: [linkButton(L('b_openGallery'), galleryUrl(publicBase, config.gallerySecret, ctx.tenantId))],
  });
}

/** Fetch a link and read it like a poster. */
async function scanLink(url, ctx, opts = {}) {
  return inAiTurn(ctx, () => scanLinkNow(url, ctx, opts));
}

async function scanLinkNow(url, ctx, { text: given, linkId } = {}) {
  try {
    const text = given ?? await fetchPageText(url);
    if (text.length < 80) {
      if (config.autoScan === 'always') ctx.attachments.push(textMessage(L('b_linkUnreadable')));
      return null;
    }
    const candidates = oppCandidates(await ctx.svc.store.opportunities(), tz, ctx.now);
    const fields = await extractFromText(provider, text, { url, now: ctx.now, timeZone: tz, candidates });
    // Caption and tags make the link findable by keyword even when it is not an opportunity.
    if (linkId && (fields?.caption || fields?.tags?.length)) {
      await ctx.svc.store.updateLink(linkId, { caption: fields.caption || '', tags: fields.tags || [] });
    }
    if (!fields?.is_opportunity || fields.confidence < 0.5) return null;
    if (!fields.link) fields.link = url;
    const reg = await deadlines.registerOpportunity(ctx.svc, fields, { source: { kind: 'link', url }, userId: ctx.userId, timeZone: tz, now: ctx.now });
    await rememberMerge(reg, ctx);
    ctx.attachments.push(textMessage(scanIntro(reg)), await oppCardFor(reg, ctx));
    return reg.opp;
  } catch (err) {
    console.error('link scan failed', describeError(err));
    if (isQuotaError(err)) ctx.attachments.push(textMessage(L('b_aiLimitedLink')));
    return null;
  }
}

async function aiUsageLine() {
  try {
    const snap = await aiUsage.snapshot(provider.models);
    const dead = snap.models.filter((m) => m.exhausted).length;
    const note = dead === 0 ? '' : dead >= snap.models.length ? L('b_aiAllDead') : L('b_aiSomeDead', { d: dead, n: snap.models.length });
    return L('b_aiLine', { n: snap.total, note, when: resetWhen(snap.resetAt) });
  } catch {
    return L('b_aiUncounted');
  }
}

const goneText = () => L('b_gone');

// One AI step at a time per chat (see handleText); a stuck call is skipped after 45 s.
const aiLocks = new Map();
function inAiTurn(ctx, fn) {
  return withLock(aiLocks, `ai:${ctx.chatId}`, fn, { maxWaitMs: 45_000 });
}

const shortDate = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${THAI_MONTHS[m - 1]}`;
};

/** The line sent above a deadline card after a poster / link / message was read. */
function scanIntro(r) {
  const o = r.opp;
  const kind = ['competition', 'application', 'scholarship', 'course', 'event'].includes(o.kind) ? L(`b_kindAnn_${o.kind}`) : L('b_kindAnnouncement');
  if (r.merged) {
    const what = r.added?.length ? L('b_mergedAdded', { list: r.added.join(', ') }) : L('b_mergedNothing');
    const dates = r.otherDeadline && o.deadline
      ? L('b_twoDates', { a: shortDate(o.deadline), b: shortDate(r.otherDeadline) })
      : '';
    return L('b_mergedIntro', { what, dates });
  }
  const n = o.reminderIds?.length || 0;
  const dl = o.deadline ? L('b_scannedDl', { when: currentLang() === 'en' ? `${shortDate(o.deadline)}` : describeDeadline(o.deadline, tz) }) : L('b_scannedNoDl');
  return L('b_scanned', { kind, dl, n: n ? L('b_scannedAlerts', { n }) : '' });
}

/** Picture for a deadline card: its own poster, wherever it came from. */
function oppThumb(o, ctx) {
  if (o?.source?.fileId) withThumb(o, ctx, { fileId: o.source.fileId, mimeType: o.source.kind === 'pdf' ? 'application/pdf' : 'image/jpeg' });
  return o;
}

async function detailCard(o, ctx, opts = {}) {
  const alerts = await deadlines.alertSettings(ctx.svc);
  return opportunityCard(oppThumb({ ...o }, ctx), { timeZone: tz, now: ctx.now, alerts, ...opts });
}

/** Card for a freshly saved / merged deadline, with split or merge offers. */
async function oppCardFor(r, ctx) {
  return detailCard(r.opp, ctx, {
    title: r.merged ? L('b_updated') : L('b_saved'),
    merged: r.merged,
    suggestion: r.suggestion,
  });
}

/** Keep the last merge per chat so "not the same? split" can undo it. */
async function rememberMerge(r, ctx) {
  if (!r?.merged) return;
  await ctx.svc.store.setUserState(ctx.chatId, { lastMerge: { before: r.before, incoming: r.incoming, at: ctx.now.toISOString() } });
}

/** Delete a deadline, keep it (last 5 per chat) for "เอาคืน", and show the undo card. */
async function removeOpportunityWithUndo(id, ctx) {
  const removed = await deadlines.deleteOpportunity(ctx.svc, id, { timeZone: tz, now: ctx.now });
  if (!removed) return null;
  const state = await ctx.svc.store.getUserState(ctx.chatId);
  const deleted = [{ opp: removed, at: ctx.now.toISOString() }, ...(state.deleted || [])].slice(0, 5);
  await ctx.svc.store.setUserState(ctx.chatId, { deleted });
  ctx.attachments.push(deletedCard(removed));
  return removed;
}

/**
 * Messages for everything due in one cron run: deadline alerts become one
 * card per deadline (several together = one carousel), other reminders keep
 * their snooze card. Alerts for deadlines that already closed are dropped.
 */
async function dueMessages(due, svc, tenant, now) {
  const regular = due.filter((r) => !r.oppId);
  const alertFor = new Set(due.filter((r) => r.oppId).map((r) => r.oppId));
  const opps = alertFor.size
    ? (await svc.store.opportunities()).filter((o) => alertFor.has(o.id) && o.status !== 'applied' && o.deadline && daysUntil(o.deadline, tz, now) >= 0)
    : [];
  const messages = regular.map((r) => dueReminderCard(r, { userName: tenant.type === 'group' ? '' : tenant.name, timeZone: tz, now }));
  if (opps.length) {
    opps.sort((a, b) => a.deadline.localeCompare(b.deadline));
    for (let i = 0; i < opps.length; i += 12) messages.push(deadlineAlertsMessage(opps.slice(i, i + 12), { timeZone: tz, now }));
  }
  return messages;
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
  return L(`b_kind_${['image', 'video', 'audio'].includes(type) ? type : 'file'}`);
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
  return L('b_welcome', { bot: config.botName });
}

function thaiDate(iso) {
  return new Intl.DateTimeFormat('th-TH', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

/**
 * LINE's own three-dot "typing" indicator while the AI works. Only in 1:1
 * chats (LINE does not support it in groups); it clears itself when the
 * reply arrives. Failing to show it never blocks the reply.
 */
function showLoading(ctx) {
  if (ctx.chatType !== 'user' || !ctx.userId) return;
  lineClient.showLoadingAnimation({ chatId: ctx.userId, loadingSeconds: 20 }).catch((err) => console.warn('loading animation failed', err?.status || err?.message || err));
}

/** Language and tone for the AI's reply; facts, names and amounts stay as they are. */
async function styleHint(ctx) {
  const p = await prefs.get(ctx.userId).catch(() => ({ lang: 'th', tone: 'polite' }));
  const parts = [];
  if (currentLang() === 'en') parts.push('Reply in natural, concise English. Keep file names, saved facts, titles, amounts and times exactly as stored (do not translate them).');
  if (p.tone === 'friend' && ctx.chatType === 'user') parts.push('ผู้ใช้เลือกโทน "เพื่อนสนิท": คุยแบบเพื่อนสนิท สั้น กันเอง ใช้คำอย่าง ลุย จัด อ่ออ ได้บ้าง แต่ข้อมูลวัน เวลา ตัวเลข ต้องเป๊ะ');
  return parts.join('\n');
}

/** "today 14:00" / "tomorrow 15:00" for the AI quota reset, in the chat's language. */
function resetWhen(resetAt, now = new Date()) {
  const lang = currentLang();
  const r = zoned(resetAt, tz);
  const n = zoned(now, tz);
  const time = formatTime(r.hm, lang);
  if (r.key === n.key) return time;
  return `${formatDay(r.key, lang, 'dm')} ${time}`;
}

function liffUrl(path = '') {
  return `https://liff.line.me/${config.liffId}${path ? `#${path}` : ''}`;
}

/** Link the rich menu that matches the person's language (aliases from setup-rich-menu). */
async function linkRichMenuFor(userId, lang) {
  try {
    const alias = await lineClient.getRichMenuAlias(config.richMenuAlias[lang === 'en' ? 'en' : 'th']);
    if (!alias?.richMenuId) return { menuSwitched: false };
    await lineClient.linkRichMenuIdToUser(userId, alias.richMenuId);
    return { menuSwitched: true };
  } catch (err) {
    console.warn('rich menu link failed', err?.status || err?.message || err);
    return { menuSwitched: false };
  }
}

function describeError(err) {
  if (err instanceof HTTPFetchError) return `${err.status} ${err.body}`;
  return err?.stack || String(err);
}
