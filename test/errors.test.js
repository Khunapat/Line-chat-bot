import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQuotaError, isDailyQuota, withRetry } from '../src/providers/errors.js';

test('isQuotaError recognises Gemini and Claude rate-limit shapes', () => {
  assert.equal(isQuotaError(Object.assign(new Error('{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED"}}'), { status: 429 })), true);
  assert.equal(isQuotaError(Object.assign(new Error('overloaded'), { status: 529 })), true);
  assert.equal(isQuotaError(Object.assign(new Error('x'), { error: { type: 'rate_limit_error' } })), true);
  assert.equal(isQuotaError(new Error('The model is overloaded. Please try again later.')), true);
  assert.equal(isQuotaError(Object.assign(new Error('not found'), { status: 404 })), false);
  assert.equal(isQuotaError(new Error('boom')), false);
  assert.equal(isQuotaError(null), false);
});

test('isDailyQuota only for per-day limits', () => {
  assert.equal(isDailyQuota(new Error('Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel')), true);
  assert.equal(isDailyQuota(new Error('Quota exceeded for GenerateRequestsPerMinute. Please retry in 12.3s')), false);
});

test('withRetry retries once on a transient quota error, honouring retry-in hints', async () => {
  const waits = [];
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('rate limit. Please retry in 3s'), { status: 429 });
    return 'ok';
  }, { sleep: async (ms) => waits.push(ms) });
  assert.equal(out, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [3000]);
});

test('withRetry gives up on daily caps, non-quota errors, and after the retry budget', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('GenerateRequestsPerDay exceeded'), { status: 429 }); }, { sleep: async () => {} }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error('boom'); }, { sleep: async () => {} }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('busy'), { status: 503 }); }, { sleep: async () => {} }), /busy/);
  assert.equal(calls, 2);
});
