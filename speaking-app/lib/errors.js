/**
 * Provider error helpers (same idea as the LINE bot's src/providers/errors.js).
 * Free tiers answer 429 / RESOURCE_EXHAUSTED when quota is used up and
 * 503 / 529 when the model is overloaded; we report those as "busy".
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

/** Seconds the provider asked us to wait, if it said so. */
function retryAfterMs(err) {
  const header = err?.headers?.['retry-after'] ?? err?.headers?.get?.('retry-after');
  const fromMsg = /retry in (\d+(?:\.\d+)?)s/i.exec(String(err?.message || ''))?.[1];
  const secs = Number(header ?? fromMsg);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

/**
 * Run `fn`, retrying once on a transient quota / overload error. The user is
 * waiting mid-conversation, so never wait more than `maxDelayMs`.
 */
export async function withRetry(fn, { retries = 1, delayMs = 1500, maxDelayMs = 4000, sleep = defaultSleep } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isQuotaError(err) || isDailyQuota(err)) throw err;
      attempt++;
      await sleep(Math.min(retryAfterMs(err) ?? delayMs, maxDelayMs));
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
