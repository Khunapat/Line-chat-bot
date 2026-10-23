/**
 * Personal forwarding link for bank and card notifications. The person's own
 * Gmail (a small Apps Script in their Google account) or phone (iPhone
 * Shortcuts, Android SMS forwarders) posts each message here, and JaiJa
 * matches it against their subscriptions and trials.
 *
 *   POST /hooks/money           Authorization: Bearer <token>   (preferred: the
 *                               token never shows up in request logs)
 *   POST /hooks/money/:token    for forwarders that cannot set headers
 *
 * Body: JSON { text, source?: 'email'|'sms', from?, subject?, id? } (the
 * keys body / message / content / sms also work), form fields, or plain text.
 *
 * The token names the person and is signed with a nonce kept in their
 * prefs, so it can be switched off or replaced from the web app. The message
 * text is never stored: only the charge read from it (merchant, amount,
 * date, last card digits) and a fingerprint to skip resends. One-time
 * passwords are dropped before anything else happens.
 */
import express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isOneTimeCode, fingerprint, parseKnownFormats, extractCharge, cleanText } from './chargeParse.js';
import * as subs from './subscriptionService.js';

const USER_ID = /^U[0-9a-f]{32}$/;
export const HOOK_LIMITS = Object.freeze({ perHour: 120, aiPerDay: 40, textChars: 8000, bodyBytes: '64kb' });

const sign = (secret, userId, nonce) => createHmac('sha256', secret).update(`money-hook:${userId}:${nonce}`).digest('base64url').slice(0, 32);

export function newNonce() {
  return randomBytes(12).toString('base64url');
}

/** `<base64url user id>.<signature>` */
export function hookToken(secret, userId, nonce) {
  return `${Buffer.from(userId).toString('base64url')}.${sign(secret, userId, nonce)}`;
}

/** The LINE user id a token names, or null for anything malformed. Does not check the signature. */
export function tokenUser(token) {
  const m = /^([A-Za-z0-9_-]{20,80})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const userId = Buffer.from(m[1], 'base64url').toString();
  return USER_ID.test(userId) ? userId : null;
}

/** userId when the token is signed with the person's current nonce, else null. */
export async function verifyHookToken(secret, token, prefs) {
  const userId = tokenUser(token);
  if (!userId || !secret) return null;
  const nonce = await prefs.hookNonce(userId);
  if (!nonce) return null;
  const want = Buffer.from(sign(secret, userId, nonce));
  const got = Buffer.from(String(token).split('.')[1]);
  return want.length === got.length && timingSafeEqual(want, got) ? userId : null;
}

// Something about money: an amount and a money word. Anything else is not worth an AI call.
const MONEY_WORD = /บาท|฿|THB|USD|US\$|\$|€|£|ชำระ|ตัดเงิน|ตัดบัตร|หักเงิน|ใช้จ่าย|ใบเสร็จ|ทดลองใช้|สมาชิก|ต่ออายุ|charged|payment|paid|receipt|invoice|trial|subscription|renew|billing|order/i;
export function looksLikeMoney(text) {
  return MONEY_WORD.test(text) && /\d/.test(text);
}

/** { text, source, id, subject } from whatever shape the forwarder sent. */
export function readMessage(req) {
  const b = req.body;
  if (typeof b === 'string') return { text: b, source: 'sms', id: '', subject: '' };
  if (!b || typeof b !== 'object') return { text: '', source: 'sms', id: '', subject: '' };
  const pick = (...keys) => {
    for (const k of keys) if (typeof b[k] === 'string' && b[k].trim()) return b[k];
    return '';
  };
  const subject = pick('subject', 'title').slice(0, 300);
  const text = pick('text', 'body', 'message', 'content', 'sms', 'msg');
  const source = ['email', 'sms'].includes(b.source) ? b.source : subject ? 'email' : 'sms';
  const id = pick('id', 'messageId', 'message_id').slice(0, 120);
  return { text, source, id, subject };
}

/**
 * @param deps.tenants    Tenants registry (the person's own tenant only)
 * @param deps.prefs      Prefs (hook nonce, language)
 * @param deps.secret     HMAC secret for tokens
 * @param deps.provider   AI provider for unknown formats, or null
 * @param deps.notify     async (userId, result, svc) => void: push the card for outcomes worth a message
 * @param deps.timeZone   tenant time zone
 * @param deps.now        () => Date (tests)
 */
export function registerMoneyHook(app, deps) {
  const { tenants, prefs, secret, provider = null, notify = async () => {}, timeZone = 'Asia/Bangkok', now: clock = () => new Date() } = deps;
  const hits = new Map(); // userId -> [ms]
  const aiUse = new Map(); // `${userId}:${day}` -> n
  const parsers = [
    express.json({ limit: HOOK_LIMITS.bodyBytes }),
    express.urlencoded({ extended: false, limit: HOOK_LIMITS.bodyBytes }),
    express.text({ type: ['text/*'], limit: HOOK_LIMITS.bodyBytes }),
  ];

  function allow(userId, at) {
    const list = (hits.get(userId) || []).filter((t) => at - t < 3_600_000);
    if (list.length >= HOOK_LIMITS.perHour) { hits.set(userId, list); return false; }
    list.push(at);
    hits.set(userId, list);
    return true;
  }

  function aiAllowed(userId, at) {
    const day = new Date(at).toISOString().slice(0, 10);
    const key = `${userId}:${day}`;
    const n = aiUse.get(key) || 0;
    if (n >= HOOK_LIMITS.aiPerDay) return false;
    aiUse.set(key, n + 1);
    if (aiUse.size > 500) for (const k of aiUse.keys()) if (!k.endsWith(`:${day}`)) aiUse.delete(k);
    return true;
  }

  const handler = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const auth = req.get('authorization') || '';
      const token = req.params.token || (/^Bearer\s+(.+)$/i.exec(auth)?.[1] || '').trim();
      const userId = await verifyHookToken(secret, token, prefs).catch(() => null);
      // One answer for "no such link" and "switched off", so links cannot be probed.
      if (!userId) return res.status(404).json({ error: 'not_found' });
      const at = clock();
      if (!allow(userId, at.getTime())) return res.status(429).json({ error: 'rate_limited' });
      // "Test the link" from the app: the link works, nothing is read or stored.
      if (req.body && typeof req.body === 'object' && req.body.test === true) return res.json({ ok: true, outcome: 'test' });

      const msg = readMessage(req);
      const text = cleanText(msg.text).slice(0, HOOK_LIMITS.textChars);
      if (!text.trim()) return res.status(400).json({ error: 'empty' });
      if (isOneTimeCode(text) || isOneTimeCode(msg.subject)) return res.json({ ok: true, outcome: 'skipped' });

      const tenant = await tenants.get(userId);
      if (!tenant || tenant.type === 'group') return res.status(409).json({ error: 'not_connected' });
      const svc = await tenants.services(tenant);
      if (!svc) return res.status(409).json({ error: 'drive_disconnected' });

      const fp = fingerprint({ source: msg.source, id: msg.id, text: msg.id ? '' : text });
      if (await subs.isSeen(svc, fp)) return res.json({ ok: true, outcome: 'duplicate' });

      let charge = parseKnownFormats(text, { now: at, timeZone });
      let read = charge ? 'pattern' : 'none';
      if (!charge && provider && looksLikeMoney(`${msg.subject}\n${text}`)) {
        if (!aiAllowed(userId, at.getTime())) return res.status(429).json({ error: 'ai_limit' });
        charge = await extractCharge(provider, msg.subject ? `Subject: ${msg.subject}\n\n${text}` : text, { now: at, timeZone });
        read = 'ai';
      }
      if (!charge) {
        await subs.markSeen(svc, fp, { now: at });
        return res.json({ ok: true, outcome: 'not_a_charge' });
      }
      const r = await subs.recordCharge(svc, charge, { source: msg.source, fp, userId, timeZone, now: at });
      if (r.notify) {
        try {
          await notify(userId, r, svc);
        } catch (err) {
          console.warn('money hook push failed', err?.status || err?.message || err);
        }
      }
      return res.json({ ok: true, outcome: r.outcome, read });
    } catch (err) {
      console.error('money hook failed', err?.message || err);
      return res.status(500).json({ error: 'failed' });
    }
  };

  app.post('/hooks/money', ...parsers, handler);
  app.post('/hooks/money/:token', ...parsers, handler);
  // Bodies that are too big or not valid JSON: a plain answer, not the server's 500.
  app.use('/hooks/money', (err, _req, res, next) => {
    if (!err?.type) return next(err);
    res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? 'too_large' : 'bad_body' });
  });
}
