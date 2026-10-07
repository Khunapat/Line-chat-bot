/**
 * JSON API behind the web app (/app, opened as a LIFF app inside LINE).
 *
 *   GET  /api/app/config                  public: LIFF id, preview flag
 *   POST /api/app/session                 LIFF ID token -> session token
 *   GET  /api/app/me                      account, connection, counts, AI usage
 *   PUT  /api/app/prefs                   language / tone (per verified user)
 *   GET  /api/app/planner                 reminders, deadlines, events, saved items
 *   GET  /api/app/reminders               reminder list
 *   POST /api/app/reminders               create (idempotent by `key`)
 *   PATCH/DELETE /api/app/reminders/:id   edit time/text/repeat, cancel
 *   POST /api/app/reminders/:id/snooze|done
 *   GET  /api/app/deadlines[/:id]         list, detail with alert schedule
 *   POST /api/app/deadlines/:id/applied|restore|split
 *   DELETE /api/app/deadlines/:id         delete (undo with /restore)
 *   PUT  /api/app/deadlines/:id/alerts    one item's alert days
 *   GET/PUT /api/app/deadline-alerts      chat-wide alert schedule
 *   GET  /api/app/library, /files/:id     files, links, remembered facts
 *   DELETE /api/app/memories/:id          forget a fact
 *   POST /api/app/disconnect              stop using Drive (confirm: true)
 *
 * Every data route needs `Authorization: Bearer <session>` issued by
 * /session after LINE verified the ID token. `ctx=me` (default) is the
 * person's own Drive; `ctx=<groupId>` is a group library, allowed only for
 * the group's host or a current member (checked with LINE, not trusted from
 * the client). A failed read is an error response, never an empty list.
 */
import express from 'express';
import { AuthError, signSession, verifySession, bearer } from './appAuth.js';
import { normalizeLang, normalizeTone } from '../web/shared/i18n.js';
import { zoned, zonedToUtc, isDayKey, validTime, addDays, diffDays, parseKey } from '../web/shared/dates.js';
import { REPEATS } from '../web/shared/recurrence.js';
import * as deadlines from './deadlineService.js';
import { ALERT_PRESETS, alertTimes, alertsFor, normalizeDays, normalizeTime } from './deadlines.js';
import { daysUntil } from './opportunities.js';
import { isScopeError } from './calendar.js';
import { withLock } from './lock.js';
import { shortId } from './store.js';

const GROUP_ID = /^[CR][0-9a-f]{32}$/;
const MEMBER_TTL_MS = 10 * 60 * 1000;
const PROFILE_TTL_MS = 10 * 60 * 1000;
const MAX_RANGE_DAYS = 62;
const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const bad = (fields) => new HttpError(400, 'invalid', { fields });

/** j***@gmail.com */
export function maskEmail(email) {
  if (!email || !email.includes('@')) return '';
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

function isDriveAuthError(err) {
  const msg = `${err?.message || ''} ${err?.response?.data?.error || ''}`;
  return /invalid_grant|unauthorized_client|Token has been expired or revoked/i.test(msg);
}

/**
 * @param deps.tenants       Tenants registry
 * @param deps.lineClient    LINE Messaging API client (getProfile, getGroupMemberProfile, getRoomMemberProfile)
 * @param deps.verifyIdToken async (idToken) => { userId, name, picture }
 * @param deps.sessionSecret HMAC secret for session tokens
 * @param deps.prefs         Prefs store
 * @param deps.timeZone      tenant time zone (Asia/Bangkok)
 * @param deps.aiUsage       async (now) => usage snapshot, or null when AI is off
 * @param deps.thumbUrlFor   (req, tenantId, fileId) => signed thumbnail URL
 * @param deps.connectUrlFor (req, userId) => signed Drive connect URL, or ''
 * @param deps.onLangChanged async (userId, lang) => { menuSwitched }
 * @param deps.settings      { liffId, rootFolderName, botName, multiUser, preview }
 * @param deps.now           () => Date (tests)
 */
export function registerAppRoutes(app, deps) {
  const router = express.Router();
  const {
    tenants, lineClient, verifyIdToken, sessionSecret, prefs, timeZone = 'Asia/Bangkok',
    aiUsage = async () => null, thumbUrlFor = () => '', connectUrlFor = () => '', onLangChanged = async () => ({ menuSwitched: false }),
    settings = {}, now: clock = () => new Date(),
  } = deps;
  const root = settings.rootFolderName || 'LineArchive';
  const memberCache = new Map(); // `${groupId}|${userId}` -> { ok, at }
  const profileCache = new Map(); // userId -> { name, picture, at }
  const locks = new Map();

  router.use(express.json({ limit: '32kb' }));
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // ------------------------------------------------------------ helpers

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };

  const authed = (fn) => handle(async (req, res) => {
    const token = bearer(req);
    if (!token) throw new AuthError('unauthenticated');
    req.uid = verifySession(sessionSecret, token, { now: clock().getTime() }).userId;
    await fn(req, res);
  });

  function sendError(res, err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, ...err.extra });
    if (err instanceof AuthError) {
      if (err.code === 'not_configured') return res.status(503).json({ error: 'not_configured' });
      if (err.code === 'verify_unavailable') return res.status(503).json({ error: 'verify_unavailable' });
      return res.status(401).json({ error: err.code === 'session_expired' ? 'session_expired' : 'unauthenticated' });
    }
    if (isDriveAuthError(err)) return res.status(409).json({ error: 'drive_disconnected' });
    console.error('app api failed', err?.stack || err);
    return res.status(502).json({ error: 'upstream_failed' });
  }

  async function profileOf(userId) {
    const hit = profileCache.get(userId);
    if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit;
    let p = { name: '', picture: '' };
    try {
      const r = await lineClient.getProfile(userId);
      p = { name: r.displayName || '', picture: r.pictureUrl || '' };
    } catch { /* the user may have blocked the bot; fall back to the tenant name */ }
    const v = { ...p, at: Date.now() };
    profileCache.set(userId, v);
    return v;
  }

  /** Host or current member of the group / room, as LINE says now. */
  async function canAccessGroup(userId, tenant) {
    if (tenant.hostUserId === userId) return true;
    const key = `${tenant.id}|${userId}`;
    const hit = memberCache.get(key);
    if (hit && Date.now() - hit.at < MEMBER_TTL_MS) return hit.ok;
    let ok;
    try {
      if (tenant.id.startsWith('R')) await lineClient.getRoomMemberProfile(tenant.id, userId);
      else await lineClient.getGroupMemberProfile(tenant.id, userId);
      ok = true;
    } catch (err) {
      const status = err?.status ?? err?.statusCode ?? err?.response?.status;
      if (status === 404 || status === 403) ok = false;
      else throw new HttpError(503, 'membership_unavailable');
    }
    memberCache.set(key, { ok, at: Date.now() });
    return ok;
  }

  async function groupContexts(userId) {
    const out = [];
    for (const t of await tenants.list()) {
      if (t.type !== 'group' || !GROUP_ID.test(t.id || '')) continue;
      try {
        if (await canAccessGroup(userId, t)) {
          const host = t.hostUserId ? await tenants.get(t.hostUserId) : null;
          out.push({ id: t.id, type: 'group', name: t.name || 'Group', hostName: host?.name || '', isHost: t.hostUserId === userId });
        }
      } catch { /* skip groups LINE cannot answer for right now */ }
      if (out.length >= 30) break;
    }
    return out;
  }

  /** { tenant, svc, kind } for ?ctx=, enforcing personal / group separation. */
  async function resolve(req, { personalOnly = false } = {}) {
    const raw = String(req.query.ctx || req.body?.ctx || 'me');
    if (raw === 'me') {
      const tenant = await tenants.get(req.uid);
      if (!tenant) throw new HttpError(409, 'not_connected');
      const svc = await tenants.services(tenant);
      if (!svc) throw new HttpError(409, 'drive_disconnected');
      return { tenant, svc, kind: 'user' };
    }
    if (personalOnly) throw new HttpError(403, 'forbidden');
    if (!GROUP_ID.test(raw)) throw new HttpError(400, 'invalid_ctx');
    const tenant = await tenants.get(raw);
    // Same answer for "no such group" and "not yours", so ids cannot be probed.
    if (!tenant || tenant.type !== 'group' || !(await canAccessGroup(req.uid, tenant))) throw new HttpError(403, 'forbidden');
    const svc = await tenants.services(tenant);
    if (!svc) throw new HttpError(409, 'drive_disconnected');
    return { tenant, svc, kind: 'group' };
  }

  const tenantLock = (tenant, fn) => withLock(locks, `app:${tenant.id}`, fn);

  // ------------------------------------------------------------- views

  function reminderView(r) {
    return {
      id: r.id, text: r.text, at: r.at, repeat: r.repeat || 'none',
      anchorDay: r.anchorDay ?? null, firedAt: r.firedAt || null, createdAt: r.createdAt || null,
    };
  }

  function oppView(o, req, tenant, now) {
    const src = o.source || {};
    return {
      id: o.id, title: o.title, kind: o.kind || 'other', organizer: o.organizer || '', summary: o.summary || '',
      deadline: o.deadline || '', deadlineNote: o.deadline_note || '', eventDates: o.event_dates || '',
      eligibility: o.eligibility || '', cost: o.cost || '', contact: o.contact || '',
      link: o.link || '', links: o.links || (o.link ? [o.link] : []),
      source: { kind: src.kind || 'text', webViewLink: src.webViewLink || '', name: src.name || '' },
      sourceCount: (o.sources || (o.source ? [o.source] : [])).length,
      mergeCount: o.mergeCount || 0,
      status: o.status === 'applied' ? 'applied' : 'open', appliedAt: o.appliedAt || null,
      alertDays: Array.isArray(o.alertDays) ? o.alertDays : null,
      daysLeft: o.deadline ? daysUntil(o.deadline, timeZone, now) : null,
      createdAt: o.createdAt || null, updatedAt: o.updatedAt || o.createdAt || null,
      thumb: src.fileId && (src.kind === 'image' || src.kind === 'pdf') ? thumbUrlFor(req, tenant.id, src.fileId) : '',
    };
  }

  function fileKind(mimeType = '', name = '') {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (/spreadsheet|excel|csv/.test(mimeType)) return 'sheet';
    if (/word|document|text\//.test(mimeType) || /\.(docx?|txt|md)$/i.test(name)) return 'doc';
    return 'file';
  }

  const isArchiveFile = (f) => f && f.name !== 'notes.md' && f.name !== 'Opportunities.md' && !/\.json$/i.test(f.name || '');

  function fileView(f, idx, req, tenant) {
    const info = idx[f.id] || {};
    return {
      id: f.id, name: f.name, day: f.day || '', mimeType: f.mimeType || '', kind: fileKind(f.mimeType, f.name),
      caption: info.caption || f.caption || '', tags: info.tags || [], webViewLink: f.webViewLink || '',
      modifiedTime: f.modifiedTime || '', size: f.size ? Number(f.size) : null,
      thumb: f.hasThumb ? thumbUrlFor(req, tenant.id, f.id) : '',
    };
  }

  const matches = (q, ...fields) => {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const hay = fields.flat().filter(Boolean).join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  };

  async function tryCount(fn) {
    try { return await fn(); } catch (err) { console.warn('app count failed', err?.message || err); return null; }
  }

  // ---------------------------------------------------------- public

  router.get('/config', (_req, res) => {
    res.json({ liffId: settings.liffId || '', preview: Boolean(settings.preview), botName: settings.botName || 'JaiJa', timeZone });
  });

  router.post('/session', handle(async (req, res) => {
    const ident = await verifyIdToken(req.body?.idToken);
    const now = clock();
    const { token, expiresAt } = signSession(sessionSecret, ident.userId, { now: now.getTime() });
    const [p, tenant, profile] = await Promise.all([prefs.get(ident.userId), tenants.get(ident.userId), profileOf(ident.userId)]);
    let contexts = [];
    try { contexts = await groupContexts(ident.userId); } catch { /* personal only */ }
    res.json({
      token, expiresAt,
      user: { name: profile.name || ident.name || tenant?.name || '', picture: profile.picture || ident.picture || '' },
      prefs: p, connected: Boolean(tenant), owner: tenants.isOwner(ident.userId), timeZone, now: now.toISOString(),
      contexts: [{ id: 'me', type: 'user' }, ...contexts],
    });
  }));

  // -------------------------------------------------------------- me

  router.get('/me', authed(async (req, res) => {
    const now = clock();
    const uid = req.uid;
    const [p, tenant, profile] = await Promise.all([prefs.get(uid), tenants.get(uid), profileOf(uid)]);
    const owner = tenants.isOwner(uid);
    const base = {
      user: { name: profile.name || tenant?.name || '', picture: profile.picture || '' },
      prefs: p, owner, connected: Boolean(tenant), timeZone, root,
      canDisconnect: Boolean(tenant) && !owner && Boolean(settings.multiUser),
      connectUrl: !owner && settings.multiUser ? connectUrlFor(req, uid) : '',
    };
    let ai;
    try {
      const snap = await aiUsage(now);
      ai = snap ? { enabled: true, estimated: true, total: snap.total, resetAt: snap.resetAt, models: snap.models.map((m) => ({ model: m.model, used: m.used, limit: m.limit ?? null, exhausted: Boolean(m.exhausted) })) } : { enabled: false };
    } catch {
      ai = { enabled: true, error: true };
    }
    if (!tenant) return res.json({ ...base, ai, drive: { status: 'not_connected' } });
    const svc = await tenants.services(tenant);
    if (!svc) return res.json({ ...base, ai, drive: { status: 'disconnected' } });

    let drive;
    try {
      drive = { status: 'ok', email: maskEmail(await svc.drive.accountEmail()) };
    } catch (err) {
      drive = { status: isDriveAuthError(err) ? 'disconnected' : 'error' };
    }
    let calendar = 'error';
    try { await svc.calendar.listUpcoming({ days: 1, max: 1 }); calendar = 'ok'; } catch (err) { calendar = isScopeError(err) ? 'no_scope' : 'error'; }

    const [files, links, memories, reminders, opps, alerts, hosted] = await Promise.all([
      tryCount(async () => (await svc.drive.allFiles()).filter(isArchiveFile).length),
      tryCount(async () => (await svc.store.links()).length),
      tryCount(async () => (await svc.store.memories()).length),
      tryCount(async () => (await svc.store.reminders()).filter((r) => !r.oppId && !r.firedAt).length),
      tryCount(async () => svc.store.opportunities()),
      tryCount(async () => deadlines.alertSettings(svc)),
      tryCount(async () => (await tenants.groupsHostedBy(uid)).length),
    ]);
    let dl = null;
    if (opps) {
      dl = { open: 0, applied: 0, closed: 0 };
      for (const o of opps) {
        if (o.status === 'applied') dl.applied++;
        else if (o.deadline && daysUntil(o.deadline, timeZone, now) < 0) dl.closed++;
        else dl.open++;
      }
    }
    res.json({ ...base, ai, drive, calendar, alerts, groupsHosted: hosted ?? 0, counts: { files, links, memories, reminders, deadlines: dl } });
  }));

  router.put('/prefs', authed(async (req, res) => {
    const { lang, tone } = req.body || {};
    const fields = {};
    if (lang !== undefined && !['th', 'en'].includes(lang)) fields.lang = 'invalid';
    if (tone !== undefined && !['polite', 'friend'].includes(tone)) fields.tone = 'invalid';
    if (lang === undefined && tone === undefined) fields.lang = 'required';
    if (Object.keys(fields).length) throw bad(fields);
    const before = await prefs.get(req.uid);
    const next = await prefs.set(req.uid, { lang: lang === undefined ? undefined : normalizeLang(lang), tone: tone === undefined ? undefined : normalizeTone(tone) });
    let menu = { menuSwitched: false };
    if (lang !== undefined && (lang !== before.lang || !before.chosen)) {
      try { menu = await onLangChanged(req.uid, next.lang); } catch (err) { console.warn('rich menu switch failed', err?.message || err); }
    }
    res.json({ prefs: next, menu });
  }));

  // ---------------------------------------------------------- planner

  router.get('/planner', authed(async (req, res) => {
    const { tenant, svc, kind } = await resolve(req);
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!isDayKey(from) || !isDayKey(to) || diffDays(from, to) < 0 || diffDays(from, to) > MAX_RANGE_DAYS) throw bad({ range: 'invalid' });
    const now = clock();
    const [reminders, opps] = await Promise.all([svc.store.reminders(), svc.store.opportunities()]);
    const cutoff = now.getTime() - DONE_WINDOW_MS;

    // Calendar belongs to the Google account; a group library uses the host's
    // account, so its calendar is never shown to group members.
    let events = { status: 'not_applicable', items: [] };
    if (kind === 'user') {
      try {
        const items = await svc.calendar.listRange({ timeMin: zonedToUtc(from, '00:00', timeZone), timeMax: zonedToUtc(addDays(to, 1), '00:00', timeZone) });
        events = { status: 'ok', items: items.filter((e) => !String(e.title || '').startsWith('⏳ Deadline:')).map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, link: e.link || '' })) };
      } catch (err) {
        events = { status: isScopeError(err) ? 'no_scope' : 'error', items: [] };
      }
    }

    let saved = { status: 'ok', items: [] };
    try {
      const [files, links, mems] = await Promise.all([svc.drive.allFiles(), svc.store.links(), svc.store.memories()]);
      const inRange = (k) => k && k >= from && k <= to;
      for (const f of files.filter(isArchiveFile)) if (inRange(f.day)) saved.items.push({ type: 'file', id: f.id, day: f.day, name: f.name, kind: fileKind(f.mimeType, f.name) });
      for (const l of links) if (inRange(l.day)) saved.items.push({ type: 'link', id: l.id, day: l.day, name: l.title || l.url, host: l.host || '' });
      for (const m of mems) {
        const day = m.createdAt ? zoned(m.createdAt, timeZone).key : '';
        if (inRange(day)) saved.items.push({ type: 'memory', id: m.id, day, name: m.text });
      }
    } catch (err) {
      console.warn('planner saved items failed', err?.message || err);
      saved = { status: 'error', items: [] };
    }

    res.json({
      today: zoned(now, timeZone).key, now: now.toISOString(), timeZone, from, to,
      reminders: reminders.filter((r) => !r.oppId && (!r.firedAt || Date.parse(r.firedAt) >= cutoff)).map(reminderView),
      deadlines: opps.map((o) => oppView(o, req, tenant, now)),
      events, saved,
    });
  }));

  // -------------------------------------------------------- reminders

  router.get('/reminders', authed(async (req, res) => {
    const { svc } = await resolve(req);
    const now = clock();
    const list = await svc.store.reminders();
    const cutoff = now.getTime() - DONE_WINDOW_MS;
    res.json({
      now: now.toISOString(), timeZone,
      items: list.filter((r) => !r.oppId && (!r.firedAt || Date.parse(r.firedAt) >= cutoff)).map(reminderView),
      deadlineAlerts: list.filter((r) => r.oppId && !r.firedAt).length,
    });
  }));

  function readWhen(body, now, { required = true } = {}) {
    const fields = {};
    const has = body.date !== undefined || body.time !== undefined;
    if (!has && !required) return { at: null, fields };
    if (!isDayKey(String(body.date || ''))) fields.date = 'invalid';
    if (!validTime(String(body.time || ''))) fields.time = 'invalid';
    if (Object.keys(fields).length) return { fields };
    const at = zonedToUtc(body.date, body.time, timeZone);
    if (new Date(at) <= now) fields.when = 'past';
    return { at, fields };
  }

  const anchorFor = (repeat, date) => (repeat === 'monthly' || repeat === 'yearly' ? parseKey(date).d : undefined);

  router.post('/reminders', authed(async (req, res) => {
    const { tenant, svc } = await resolve(req);
    const body = req.body || {};
    const now = clock();
    const fields = {};
    const text = String(body.text ?? '').trim();
    if (!text) fields.text = 'required';
    else if (text.length > 300) fields.text = 'too_long';
    const repeat = body.repeat ?? 'none';
    if (!REPEATS.includes(repeat)) fields.repeat = 'invalid';
    const key = String(body.key || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) fields.key = 'invalid';
    const when = readWhen(body, now);
    Object.assign(fields, when.fields);
    if (Object.keys(fields).length) throw bad(fields);

    const anchorDay = anchorFor(repeat, body.date);
    const result = await svc.store.update('reminders.json', [], (list) => {
      // A retry after a lost response must not set the same reminder twice.
      const existing = list.find((r) => r.clientKey === key && r.userId === req.uid);
      if (existing) return { reminder: { ...existing }, duplicate: true };
      const entry = {
        id: shortId(), createdAt: now.toISOString(), userId: req.uid,
        text, at: when.at, repeat, clientKey: key, via: 'app', ...(anchorDay ? { anchorDay } : {}),
      };
      list.push(entry);
      return { reminder: { ...entry }, duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json({ reminder: reminderView(result.reminder), duplicate: result.duplicate, destination: tenant.type === 'group' ? 'group' : 'private' });
  }));

  async function findReminder(svc, id) {
    const r = (await svc.store.reminders()).find((x) => x.id === id);
    if (!r) throw new HttpError(404, 'not_found');
    if (r.oppId) throw new HttpError(409, 'deadline_alert');
    return r;
  }

  router.patch('/reminders/:id', authed(async (req, res) => {
    const { svc } = await resolve(req);
    const body = req.body || {};
    const now = clock();
    const current = await findReminder(svc, req.params.id);
    // The client sends the time it was looking at; a change made meanwhile
    // (snoozed in chat, fired by the cron) is reported instead of overwritten.
    if (body.expectAt && body.expectAt !== current.at) throw new HttpError(409, 'changed', { reminder: reminderView(current) });
    const fields = {};
    const patch = {};
    if (body.text !== undefined) {
      const text = String(body.text).trim();
      if (!text) fields.text = 'required';
      else if (text.length > 300) fields.text = 'too_long';
      else patch.text = text;
    }
    if (body.repeat !== undefined && !REPEATS.includes(body.repeat)) fields.repeat = 'invalid';
    const when = readWhen(body, now, { required: false });
    Object.assign(fields, when.fields);
    if (Object.keys(fields).length) throw bad(fields);
    if (when.at) { patch.at = when.at; patch.firedAt = null; }
    const repeat = body.repeat ?? current.repeat ?? 'none';
    if (body.repeat !== undefined) patch.repeat = repeat;
    if (when.at || body.repeat !== undefined) {
      const date = when.at ? body.date : zoned(current.at, timeZone).key;
      const a = anchorFor(repeat, date);
      patch.anchorDay = a ?? undefined;
    }
    if (Object.keys(patch).length === 0) throw bad({ patch: 'empty' });
    const r = await svc.store.update('reminders.json', [], (list) => {
      const x = list.find((y) => y.id === current.id);
      if (!x) return null;
      for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === null) delete x[k]; else x[k] = v; }
      return { ...x };
    });
    if (!r) throw new HttpError(404, 'not_found');
    res.json({ reminder: reminderView(r) });
  }));

  router.post('/reminders/:id/snooze', authed(async (req, res) => {
    const { svc } = await resolve(req);
    const minutes = Number(req.body?.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw bad({ minutes: 'invalid' });
    const original = await findReminder(svc, req.params.id);
    const now = clock();
    const at = new Date(now.getTime() + minutes * 60_000).toISOString();
    // Same as the chat button: a repeating reminder keeps its schedule and a
    // one-off copy is added; a one-off reminder moves.
    const r = original.repeat && original.repeat !== 'none'
      ? await svc.store.addReminder({ userId: req.uid, text: original.text, at, repeat: 'none' })
      : await svc.store.updateReminder(original.id, { at, firedAt: null });
    if (!r) throw new HttpError(404, 'not_found');
    res.json({ reminder: reminderView(r) });
  }));

  router.post('/reminders/:id/done', authed(async (req, res) => {
    const { svc } = await resolve(req);
    const r = await findReminder(svc, req.params.id);
    if (!r.firedAt) throw new HttpError(409, 'not_due');
    await svc.store.removeReminder(r.id);
    res.json({ ok: true });
  }));

  router.delete('/reminders/:id', authed(async (req, res) => {
    const { svc } = await resolve(req);
    const r = await findReminder(svc, req.params.id);
    const removed = await svc.store.removeReminder(r.id);
    if (!removed) throw new HttpError(404, 'not_found');
    res.json({ ok: true, removed: reminderView(removed) });
  }));

  // -------------------------------------------------------- deadlines

  async function ownCount(svc) {
    return (await svc.store.opportunities()).filter((o) => Array.isArray(o.alertDays)).length;
  }

  router.get('/deadlines', authed(async (req, res) => {
    const { tenant, svc } = await resolve(req);
    const now = clock();
    const [list, alerts] = await Promise.all([svc.store.opportunities(), deadlines.alertSettings(svc)]);
    res.json({
      now: now.toISOString(), today: zoned(now, timeZone).key, timeZone, alerts,
      ownCount: list.filter((o) => Array.isArray(o.alertDays)).length,
      items: list.map((o) => oppView(o, req, tenant, now)),
    });
  }));

  async function detail(req, tenant, svc, id) {
    const now = clock();
    const o = await deadlines.getOpportunity(svc, id);
    if (!o) throw new HttpError(404, 'not_found');
    const [settingsNow, state, reminders] = await Promise.all([deadlines.alertSettings(svc), svc.store.getUserState(tenant.id), svc.store.reminders()]);
    const plan = alertsFor(o, settingsNow);
    const sent = new Set(reminders.filter((r) => r.oppId === o.id && r.firedAt).map((r) => r.offset));
    const schedule = o.deadline && o.status !== 'applied'
      ? alertTimes(o.deadline, plan, timeZone, new Date(0)).map((t) => ({ at: t.at, offset: t.offset, past: new Date(t.at) <= now, sent: sent.has(t.offset) }))
        .sort((a, b) => a.at.localeCompare(b.at))
      : [];
    const mode = o.status === 'applied' ? 'stopped' : Array.isArray(o.alertDays) ? (o.alertDays.length ? 'own' : 'off') : 'default';
    return {
      item: oppView(o, req, tenant, now),
      alerts: { mode, days: plan.days, time: plan.time, schedule },
      canSplit: state.lastMerge?.before?.id === o.id,
      canRestore: false,
    };
  }

  router.get('/deadlines/:id', authed(async (req, res) => {
    const { tenant, svc } = await resolve(req);
    res.json(await detail(req, tenant, svc, req.params.id));
  }));

  router.post('/deadlines/:id/applied', authed(async (req, res) => {
    const { tenant, svc } = await resolve(req);
    if (typeof req.body?.applied !== 'boolean') throw bad({ applied: 'invalid' });
    const o = await deadlines.setApplied(svc, req.params.id, req.body.applied, { timeZone, now: clock() });
    if (!o) throw new HttpError(404, 'not_found');
    res.json(await detail(req, tenant, svc, o.id));
  }));

  router.delete('/deadlines/:id', authed(async (req, res) => {
    const { tenant, svc } = await resolve(req);
    const now = clock();
    const removed = await tenantLock(tenant, async () => {
      const r = await deadlines.deleteOpportunity(svc, req.params.id, { timeZone, now });
      if (!r) return null;
      // Same undo stack as the chat's "เอาคืน" button (last 5 per chat).
      const state = await svc.store.getUserState(tenant.id);
      const stack = [{ opp: r, at: now.toISOString() }, ...(state.deleted || [])].slice(0, 5);
      await svc.store.setUserState(tenant.id, { deleted: stack });
      return r;
    });
    if (!removed) throw new HttpError(404, 'not_found');
    res.json({ deleted: { id: removed.id, title: removed.title }, undo: true });
  }));

  router.post('/deadlines/:id/restore', authed(async (req, res) => {
    const { tenant, svc } = await resolve(req);
    const id = req.params.id;
    const back = await tenantLock(tenant, async () => {
      const state = await svc.store.getUserState(tenant.id);
      const stack = state.deleted || [];
      const snap = stack.find((x) => x.opp?.id === id)?.opp;
      // A second tap after a successful restore finds the item already back.
      if (!snap) return (await deadlines.getOpportunity(svc, id)) ? { restored: null } : { gone: true };
      const restored = await deadlines.restoreOpportunity(svc, snap, { timeZone, now: clock() });
      await svc.store.setUserState(tenant.id, { deleted: stack.filter((x) => x.opp?.id !== id) });
      return { restored };
    });
    if (back.gone) throw new HttpError(410, 'restore_expired');
    if (!back.restored) {
      // Already back (a second tap): report the item as it is.
      return res.json(await detail(req, tenant, svc, id));
    }
    res.json(await detail(req, tenant, svc, back.restored.id));
  }));

  router.post('/deadlines/:id/split', authed(async (req, res) => {
    const { tenant, svc } = await resolve(req);
    const r = await tenantLock(tenant, async () => {
      const state = await svc.store.getUserState(tenant.id);
      const lm = state.lastMerge;
      if (!lm || lm.before?.id !== req.params.id) return null;
      const out = await deadlines.splitMerge(svc, lm, { userId: req.uid, timeZone, now: clock() });
      if (out) await svc.store.setUserState(tenant.id, { lastMerge: null });
      return out;
    });
    if (!r) throw new HttpError(409, 'split_unavailable');
    const now = clock();
    res.json({ restored: r.restored ? oppView(r.restored, req, tenant, now) : null, created: oppView(r.created, req, tenant, now) });
  }));

  router.put('/deadlines/:id/alerts', authed(async (req, res) => {
    const { tenant, svc } = await resolve(req);
    const preset = req.body?.preset;
    let change;
    if (preset === 'default') change = { reset: true };
    else if (preset === 'off') change = { off: true };
    else {
      const p = ALERT_PRESETS.find((x) => x.key === preset);
      if (!p) throw bad({ preset: 'invalid' });
      change = { days: p.days };
    }
    const r = await deadlines.setAlertSettings(svc, { ...change, oppId: req.params.id }, { timeZone, now: clock() });
    if (!r) throw new HttpError(404, 'not_found');
    res.json(await detail(req, tenant, svc, req.params.id));
  }));

  router.get('/deadline-alerts', authed(async (req, res) => {
    const { svc } = await resolve(req);
    res.json({ alerts: await deadlines.alertSettings(svc), ownCount: await ownCount(svc) });
  }));

  router.put('/deadline-alerts', authed(async (req, res) => {
    const { svc } = await resolve(req);
    const body = req.body || {};
    const fields = {};
    let days;
    if (body.off !== true) {
      days = normalizeDays(body.days);
      if (!Array.isArray(body.days) || days.length === 0 || days.length !== body.days.length) fields.days = 'invalid';
    }
    const time = normalizeTime(body.time);
    if (!time) fields.time = 'invalid';
    if (Object.keys(fields).length) throw bad(fields);
    const r = await deadlines.setAlertSettings(svc, body.off === true ? { off: true, time } : { days, time }, { timeZone, now: clock() });
    res.json({ alerts: r.alerts, ownCount: await ownCount(svc) });
  }));

  // ---------------------------------------------------------- library

  function ownerLine(tenant, kind, email, host) {
    return kind === 'group'
      ? { kind: 'group', name: tenant.name || '', host: host?.name || '', root }
      : { kind: 'user', email, root };
  }

  router.get('/library', authed(async (req, res) => {
    const { tenant, svc, kind } = await resolve(req);
    const tab = String(req.query.tab || 'files');
    if (!['files', 'links', 'memory'].includes(tab)) throw bad({ tab: 'invalid' });
    const q = String(req.query.q || '').slice(0, 100);
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    let items;
    if (tab === 'files') {
      const [files, idx] = await Promise.all([svc.drive.allFiles(), svc.store.fileIndex()]);
      items = files.filter(isArchiveFile).map((f) => fileView(f, idx, req, tenant))
        .filter((f) => matches(q, f.name, f.caption, f.tags, f.day))
        .sort((a, b) => (b.day || '').localeCompare(a.day || '') || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
    } else if (tab === 'links') {
      items = (await svc.store.links())
        .filter((l) => matches(q, l.title, l.url, l.host, l.caption, l.tags || [], l.day))
        .sort((a, b) => (b.at || '').localeCompare(a.at || ''))
        .map((l) => ({ id: l.id, title: l.title || l.url, url: l.url, host: l.host || '', day: l.day || '', at: l.at || '', caption: l.caption || '' }));
    } else {
      items = (await svc.store.memories())
        .filter((m) => matches(q, m.text))
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt || '' }));
    }

    // Tab counts are extras: one that fails is null (unknown), never 0.
    const [nFiles, nLinks, nMem, email, host] = await Promise.all([
      tab === 'files' && !q ? items.length : tryCount(async () => (await svc.drive.allFiles()).filter(isArchiveFile).length),
      tab === 'links' && !q ? items.length : tryCount(async () => (await svc.store.links()).length),
      tab === 'memory' && !q ? items.length : tryCount(async () => (await svc.store.memories()).length),
      kind === 'user' ? tryCount(async () => maskEmail(await svc.drive.accountEmail())) : null,
      kind === 'group' && tenant.hostUserId ? tryCount(() => tenants.get(tenant.hostUserId)) : null,
    ]);
    let aiLimited = false;
    try {
      const snap = await aiUsage(clock());
      aiLimited = Boolean(snap?.models?.length) && snap.models.every((m) => m.exhausted);
    } catch { /* unknown is not "limited" */ }
    res.json({
      tab, q, total: items.length, offset, items: items.slice(offset, offset + limit),
      counts: { files: nFiles, links: nLinks, memory: nMem },
      owner: ownerLine(tenant, kind, email || '', host), aiLimited,
    });
  }));

  router.get('/files/:id', authed(async (req, res) => {
    const { tenant, svc, kind } = await resolve(req);
    // Only files inside this library's own folder tree: a group member can
    // never open the host's personal files by guessing an id.
    const [files, idx] = await Promise.all([svc.drive.allFiles(), svc.store.fileIndex()]);
    const f = files.find((x) => x.id === req.params.id && isArchiveFile(x));
    if (!f) throw new HttpError(404, 'not_found');
    const email = kind === 'user' ? await tryCount(async () => maskEmail(await svc.drive.accountEmail())) : '';
    const host = kind === 'group' && tenant.hostUserId ? await tryCount(() => tenants.get(tenant.hostUserId)) : null;
    res.json({ file: fileView(f, idx, req, tenant), owner: ownerLine(tenant, kind, email || '', host) });
  }));

  router.delete('/memories/:id', authed(async (req, res) => {
    const { svc } = await resolve(req);
    const removed = await svc.store.forget(req.params.id);
    if (!removed) throw new HttpError(404, 'not_found');
    res.json({ ok: true });
  }));

  // ------------------------------------------------------- connection

  router.post('/disconnect', authed(async (req, res) => {
    if (req.body?.confirm !== true) throw bad({ confirm: 'required' });
    if (tenants.isOwner(req.uid)) throw new HttpError(403, 'owner_managed');
    if (!settings.multiUser) throw new HttpError(403, 'owner_managed');
    const tenant = await tenants.get(req.uid);
    if (!tenant) throw new HttpError(409, 'not_connected');
    const groups = await tenants.groupsHostedBy(req.uid);
    for (const g of groups) await tenants.remove(g.id);
    await tenants.remove(req.uid);
    res.json({ ok: true, groupsReleased: groups.length });
  }));

  router.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api/app', router);
  return router;
}
