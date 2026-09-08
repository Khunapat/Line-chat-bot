/**
 * "Connect your Google Drive" for other people. The bot sends a signed link;
 * Google's consent screen runs in the browser; the callback stores the
 * person's refresh token as a tenant. Requires a "Web application" OAuth
 * client with `<service url>/oauth/callback` as an authorised redirect URI.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.events',
];
const STATE_TTL_MS = 30 * 60 * 1000;

export function signState(secret, userId, ttlMs = STATE_TTL_MS) {
  const exp = String(Date.now() + ttlMs);
  const uid = Buffer.from(userId).toString('base64url');
  return `${exp}.${uid}.${hmac(secret, `${exp}.${uid}`)}`;
}

export function verifyState(secret, state) {
  if (!secret || typeof state !== 'string') return null;
  const [exp, uid, sig] = state.split('.');
  if (!exp || !uid || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const expected = hmac(secret, `${exp}.${uid}`);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return Buffer.from(uid, 'base64url').toString();
}

function hmac(secret, data) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function connectUrl(base, secret, userId) {
  return `${base.replace(/\/+$/, '')}/connect?s=${signState(secret, userId)}`;
}

export function baseUrlOf(req) {
  return `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
}

/**
 * @param onConnected async ({ userId, email }) => void   called after a token is stored
 */
export function registerOAuthRoutes(app, { googleWeb, secret, tenants, botName, onConnected }) {
  const enabled = () => Boolean(googleWeb?.clientId && googleWeb?.clientSecret);
  const client = (req) => new google.auth.OAuth2(googleWeb.clientId, googleWeb.clientSecret, `${baseUrlOf(req)}/oauth/callback`);

  app.get('/connect', (req, res) => {
    if (!enabled()) return res.status(503).type('html').send(page('ยังเชื่อมไม่ได้', 'เจ้าของบอทยังไม่ได้ตั้งค่า GOOGLE_WEB_CLIENT_ID / SECRET'));
    const userId = verifyState(secret, req.query.s);
    if (!userId) return res.status(401).type('html').send(page('ลิงก์หมดอายุ', 'กลับไปที่ LINE แล้วพิมพ์ "เชื่อม Drive" เพื่อขอลิงก์ใหม่'));
    const url = client(req).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state: req.query.s,
      include_granted_scopes: true,
    });
    res.redirect(url);
  });

  app.get('/oauth/callback', async (req, res) => {
    if (!enabled()) return res.status(503).end();
    const userId = verifyState(secret, req.query.state);
    if (!userId) return res.status(401).type('html').send(page('ลิงก์หมดอายุ', 'กลับไปที่ LINE แล้วพิมพ์ "เชื่อม Drive" เพื่อขอลิงก์ใหม่'));
    if (req.query.error) return res.status(400).type('html').send(page('ไม่ได้อนุญาต', 'ถ้าเปลี่ยนใจ กลับไปที่ LINE แล้วพิมพ์ "เชื่อม Drive" ได้อีกครั้ง'));
    try {
      const oauth = client(req);
      const { tokens } = await oauth.getToken(String(req.query.code || ''));
      if (!tokens.refresh_token) {
        return res.status(400).type('html').send(page('ยังไม่ได้สิทธิ์ถาวร', 'ไปที่ https://myaccount.google.com/permissions ลบ "' + botName + '" ออก แล้วลองเชื่อมใหม่'));
      }
      oauth.setCredentials(tokens);
      let email = '';
      try {
        const { data } = await google.drive({ version: 'v3', auth: oauth }).about.get({ fields: 'user(emailAddress,displayName)' });
        email = data.user?.emailAddress || '';
      } catch { /* optional */ }
      await tenants.upsert({ id: userId, type: 'user', refreshToken: tokens.refresh_token, clientKind: 'web', email });
      await onConnected?.({ userId, email });
      res.type('html').send(page('เชื่อมแล้ว 🎉', `${botName} จะเก็บทุกอย่างลง Google Drive ของ ${email || 'คุณ'} กลับไปที่ LINE ได้เลย`));
    } catch (err) {
      console.error('oauth callback failed', err?.message || err);
      res.status(500).type('html').send(page('เชื่อมไม่สำเร็จ', 'ลองใหม่จาก LINE อีกครั้ง'));
    }
  });
}

function page(title, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui;background:#F4EFE4;color:#3B3B3B;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">
<div style="max-width:420px;background:#FBF8F1;border:3px solid #3B3B3B;border-radius:20px;padding:28px;box-shadow:0 6px 0 #3B3B3B"><h2 style="margin:0 0 10px">${esc(title)}</h2><p style="margin:0;line-height:1.5">${esc(text)}</p></div></body>`;
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
