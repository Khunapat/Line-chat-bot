/**
 * Shared error helpers for LLM providers.
 *
 * Free tiers (Gemini especially) answer with HTTP 429 / RESOURCE_EXHAUSTED when
 * the per-minute or per-day quota is used up, and 503 / 529 when the model is
 * overloaded. We treat those as "AI busy" rather than "the bot is broken".
 */

const QUOTA_STATUS = new Set([429, 503, 529]);
const QUOTA_WORDS = /RESOURCE_EXHAUSTED|rate.?limit|quota|overloaded|too many requests|UNAVAILABLE/i;

/** True when the model refused us because of quota / rate limits / overload. */
export function isQuotaError(err) {
  if (!err) return false;
  const status = Number(err.status ?? err.code ?? err.statusCode ?? err.error?.code);
  if (QUOTA_STATUS.has(status)) return true;
  const type = err.error?.error?.type || err.error?.type || err.type || '';
  if (/rate_limit|overloaded/.test(String(type))) return true;
  return QUOTA_WORDS.test(String(err.message || ''));
}

/** A daily cap will not clear in seconds, so retrying is pointless. */
export function isDailyQuota(err) {
  return /per.?day|daily|PerDay/i.test(String(err?.message || ''));
}

/** Seconds the provider asked us to wait, if it said so and it is short. */
function retryAfterMs(err) {
  const header = err?.headers?.['retry-after'] ?? err?.headers?.get?.('retry-after');
  const fromMsg = /retry in (\d+(?:\.\d+)?)s/i.exec(String(err?.message || ''))?.[1];
  const secs = Number(header ?? fromMsg);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

/**
 * Run `fn`, retrying once on a transient quota / overload error.
 * A LINE reply token only lives for a short while, so we never wait more
 * than `maxDelayMs` and give up on daily-cap errors immediately.
 */
export async function withRetry(fn, { retries = 1, delayMs = 2000, maxDelayMs = 6000, sleep = defaultSleep } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isQuotaError(err) || isDailyQuota(err)) throw err;
      attempt++;
      const wait = Math.min(retryAfterMs(err) ?? delayMs, maxDelayMs);
      await sleep(wait);
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thai text shown to the user when the AI is rate-limited. */
export const QUOTA_MESSAGE = 'ตอนนี้ AI ติดลิมิตชั่วคราว 😅 ลองใหม่อีกสักครู่นะ (ไฟล์ที่ส่งมายังเก็บเข้า Drive ให้ตามปกติ)';
