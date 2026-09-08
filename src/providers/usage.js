/**
 * Counts AI requests per model per day so the settings card can show how much
 * of the free quota is left. Google does not expose remaining quota through
 * the API, so we count ourselves and learn each model's daily limit from the
 * 429 error it eventually returns.
 *
 * Free-tier daily quotas reset at midnight Pacific time; that is the "day"
 * used for counting, regardless of the bot's own time zone.
 *
 * Counts live in memory and are flushed to a small JSON doc in the owner's
 * Drive (debounced) so a Cloud Run restart does not zero them.
 */

const RESET_ZONE = 'America/Los_Angeles';
const DOC = 'ai-usage.json';

export class Usage {
  constructor({ store = null, flushMs = 3000 } = {}) {
    this.store = store;
    this.flushMs = flushMs;
    this.data = null;       // { day, models: { [model]: { used, limit, exhausted } } }
    this.loaded = null;     // promise
    this.timer = null;
    this.dirty = false;
  }

  async load() {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          if (this.store) this.data = await this.store.read(DOC, null);
        } catch (err) {
          console.warn('ai usage: could not load counts', err?.message || err);
        }
        if (!this.data || typeof this.data !== 'object') this.data = { day: quotaDay(), models: {} };
      })();
    }
    await this.loaded;
    this.rollover();
    return this.data;
  }

  /** Forget yesterday's counts once Pacific midnight has passed. */
  rollover(now = new Date()) {
    const day = quotaDay(now);
    if (this.data && this.data.day !== day) {
      this.data = { day, models: {} };
      this.dirty = true;
    }
  }

  /** Record one request. `err` is the error thrown, if any. */
  async record(model, err = null, now = new Date()) {
    await this.load();
    this.rollover(now);
    const m = (this.data.models[model] ||= { used: 0, limit: null, exhausted: false });
    m.used += 1;
    if (err) {
      const q = parseQuota(err);
      if (q?.daily) {
        m.exhausted = true;
        if (q.limit) m.limit = q.limit;
        // The rejected call did not count against the quota.
        m.used = Math.max(m.used - 1, m.limit ?? 0);
      }
    } else {
      m.exhausted = false;
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (!this.store || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.flushMs);
    this.timer.unref?.();
  }

  async flush() {
    if (!this.store || !this.dirty || !this.data) return;
    this.dirty = false;
    try {
      await this.store.write(DOC, this.data);
    } catch (err) {
      this.dirty = true;
      console.warn('ai usage: could not save counts', err?.message || err);
    }
  }

  /** Snapshot for display: models in the configured order first. */
  async snapshot(models = [], now = new Date()) {
    await this.load();
    this.rollover(now);
    const names = [...new Set([...models, ...Object.keys(this.data.models)])];
    const rows = names.map((model) => {
      const m = this.data.models[model] || { used: 0, limit: null, exhausted: false };
      return { model, used: m.used, limit: m.limit, exhausted: m.exhausted };
    });
    return { day: this.data.day, resetAt: nextReset(now), models: rows, total: rows.reduce((n, r) => n + r.used, 0) };
  }
}

/** Pull limit + daily/minute flag out of a Gemini 429 message. */
export function parseQuota(err) {
  const msg = String(err?.message || '');
  if (!/429|RESOURCE_EXHAUSTED|quota/i.test(msg) && Number(err?.status) !== 429) return null;
  const limit = Number(/"quotaValue":"(\d+)"/.exec(msg)?.[1] || /limit:\s*(\d+)/.exec(msg)?.[1]) || null;
  const daily = /PerDay|per day|daily/i.test(msg);
  return { limit, daily };
}

/** YYYY-MM-DD in the quota reset zone. */
export function quotaDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: RESET_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Next Pacific midnight as a Date (Pacific offsets are whole hours, so hour boundaries suffice). */
export function nextReset(now = new Date()) {
  const today = quotaDay(now);
  const hour = 3600_000;
  let t = Math.floor(now.getTime() / hour) * hour;
  for (let i = 0; i < 30; i++) {
    t += hour;
    if (quotaDay(new Date(t)) !== today) return new Date(t);
  }
  return new Date(t);
}

/** "14:00 น." or "พรุ่งนี้ 14:00 น." in the bot's time zone. */
export function describeReset(resetAt, timeZone, now = new Date()) {
  const time = new Intl.DateTimeFormat('th-TH', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(resetAt);
  const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return dayOf(resetAt) === dayOf(now) ? `${time} น.` : `พรุ่งนี้ ${time} น.`;
}
