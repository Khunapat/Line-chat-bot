/**
 * Who is using the web app (LIFF). The browser sends the LIFF ID token; the
 * server checks it with LINE (never trusting a user id from the client) and
 * hands back a short-lived session token signed with our secret. The session
 * token travels in the Authorization header only, never in a URL.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class AuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/**
 * Verify a LIFF / LINE Login ID token with LINE. Returns { userId, name,
 * picture }. Throws AuthError('invalid_token') when LINE rejects it and
 * AuthError('verify_unavailable') when LINE cannot be reached.
 */
export async function verifyLineIdToken(idToken, { channelId, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!channelId) throw new AuthError('not_configured', 'LINE_LOGIN_CHANNEL_ID is not set');
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 4096) throw new AuthError('invalid_token');
  let resp;
  try {
    resp = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }).toString(),
    });
  } catch {
    throw new AuthError('verify_unavailable');
  }
  if (resp.status >= 500) throw new AuthError('verify_unavailable');
  let body = null;
  try { body = await resp.json(); } catch { /* handled below */ }
  if (!resp.ok || !body) throw new AuthError('invalid_token');
  // LINE already checks the signature, audience and expiry; check again so a
  // misconfigured channel id or a stale token can never slip through.
  if (body.aud !== channelId) throw new AuthError('invalid_token');
  if (body.iss !== 'https://access.line.me') throw new AuthError('invalid_token');
  if (!Number.isFinite(body.exp) || body.exp * 1000 <= now) throw new AuthError('invalid_token');
  if (typeof body.sub !== 'string' || !/^U[0-9a-f]{32}$/.test(body.sub)) throw new AuthError('invalid_token');
  return { userId: body.sub, name: typeof body.name === 'string' ? body.name : '', picture: typeof body.picture === 'string' ? body.picture : '' };
}

function hmac(secret, data) {
  return createHmac('sha256', secret).update(`app-session.${data}`).digest('base64url');
}

export function signSession(secret, userId, { ttlMs = SESSION_TTL_MS, now = Date.now() } = {}) {
  if (!secret) throw new Error('session secret missing');
  const exp = now + ttlMs;
  const payload = Buffer.from(JSON.stringify({ u: userId, e: exp })).toString('base64url');
  return { token: `${payload}.${hmac(secret, payload)}`, expiresAt: new Date(exp).toISOString() };
}

/** Returns { userId, expiresAt } or throws AuthError('session_invalid' | 'session_expired'). */
export function verifySession(secret, token, { now = Date.now() } = {}) {
  if (!secret || typeof token !== 'string' || token.length > 1024) throw new AuthError('session_invalid');
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw new AuthError('session_invalid');
  const expected = hmac(secret, payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new AuthError('session_invalid');
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new AuthError('session_invalid'); }
  if (typeof data?.u !== 'string' || !Number.isFinite(data?.e)) throw new AuthError('session_invalid');
  if (data.e <= now) throw new AuthError('session_expired');
  return { userId: data.u, expiresAt: new Date(data.e).toISOString() };
}

/** "Bearer <token>" from a request, or ''. */
export function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
