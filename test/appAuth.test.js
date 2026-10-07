import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyLineIdToken, signSession, verifySession, AuthError } from '../src/appAuth.js';

const CHANNEL = '2010420189';
const UID = 'U' + 'd'.repeat(32);
const NOW = Date.parse('2026-10-07T05:51:00Z');
const TOKEN = 'x'.repeat(40);

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const good = { iss: 'https://access.line.me', sub: UID, aud: CHANNEL, exp: NOW / 1000 + 600, iat: NOW / 1000, name: 'Jai' };

test('verifies the ID token with LINE and returns the user', async () => {
  const f = fakeFetch(200, good);
  const r = await verifyLineIdToken(TOKEN, { channelId: CHANNEL, fetchImpl: f, now: NOW });
  assert.deepEqual(r, { userId: UID, name: 'Jai', picture: '' });
  assert.equal(f.calls[0].url, 'https://api.line.me/oauth2/v2.1/verify');
  const sent = new URLSearchParams(f.calls[0].init.body);
  assert.equal(sent.get('client_id'), CHANNEL);
  assert.equal(sent.get('id_token'), TOKEN);
});

test('rejects tokens for another channel, issuer, expired or malformed', async () => {
  const cases = [
    { ...good, aud: '999' },
    { ...good, iss: 'https://evil.example' },
    { ...good, exp: NOW / 1000 - 1 },
    { ...good, sub: 'not-a-line-id' },
  ];
  for (const body of cases) {
    await assert.rejects(verifyLineIdToken(TOKEN, { channelId: CHANNEL, fetchImpl: fakeFetch(200, body), now: NOW }), (e) => e instanceof AuthError && e.code === 'invalid_token');
  }
  await assert.rejects(verifyLineIdToken(TOKEN, { channelId: CHANNEL, fetchImpl: fakeFetch(400, { error: 'invalid_request' }), now: NOW }), /invalid_token/);
  await assert.rejects(verifyLineIdToken('short', { channelId: CHANNEL, fetchImpl: fakeFetch(200, good), now: NOW }), /invalid_token/);
  await assert.rejects(verifyLineIdToken(TOKEN, { channelId: '', fetchImpl: fakeFetch(200, good) }), (e) => e.code === 'not_configured');
});

test('LINE being down is not reported as a bad token', async () => {
  await assert.rejects(verifyLineIdToken(TOKEN, { channelId: CHANNEL, fetchImpl: fakeFetch(503, {}), now: NOW }), (e) => e.code === 'verify_unavailable');
  const throwing = async () => { throw new Error('ECONNRESET'); };
  await assert.rejects(verifyLineIdToken(TOKEN, { channelId: CHANNEL, fetchImpl: throwing, now: NOW }), (e) => e.code === 'verify_unavailable');
});

test('session tokens are signed, expire and resist tampering', () => {
  const { token, expiresAt } = signSession('s3cret', UID, { now: NOW, ttlMs: 60_000 });
  assert.equal(expiresAt, new Date(NOW + 60_000).toISOString());
  assert.equal(verifySession('s3cret', token, { now: NOW }).userId, UID);
  assert.throws(() => verifySession('s3cret', token, { now: NOW + 60_001 }), (e) => e.code === 'session_expired');
  assert.throws(() => verifySession('other', token, { now: NOW }), (e) => e.code === 'session_invalid');
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'U' + 'e'.repeat(32), e: NOW + 60_000 })).toString('base64url');
  assert.throws(() => verifySession('s3cret', `${forged}.${sig}`, { now: NOW }), (e) => e.code === 'session_invalid');
  assert.throws(() => verifySession('s3cret', payload, { now: NOW }), (e) => e.code === 'session_invalid');
});
