/**
 * Per-person preferences (language, chat tone), keyed by the verified LINE
 * user id. Kept in the owner's Drive (_data/prefs.json) so they exist before
 * a person connects their own Drive and survive a disconnect.
 */
import { normalizeLang, normalizeTone } from '../web/shared/i18n.js';

const DOC = 'prefs.json';

export class Prefs {
  constructor(store) {
    this.store = store;
  }

  async get(userId) {
    if (!userId) return { lang: 'th', tone: 'polite', chosen: false };
    let all = {};
    try {
      all = await this.store.read(DOC, {});
    } catch (err) {
      console.warn('prefs: read failed', err?.message || err);
    }
    const p = all[userId] || {};
    return { lang: normalizeLang(p.lang), tone: normalizeTone(p.tone), chosen: Boolean(p.lang) };
  }

  /** Only lang / tone are stored; anything else is ignored. */
  async set(userId, { lang, tone } = {}) {
    if (!userId) throw new Error('userId required');
    return this.store.update(DOC, {}, (all) => {
      const cur = all[userId] || {};
      if (lang !== undefined) cur.lang = normalizeLang(lang);
      if (tone !== undefined) cur.tone = normalizeTone(tone);
      cur.updatedAt = new Date().toISOString();
      all[userId] = cur;
      return { lang: normalizeLang(cur.lang), tone: normalizeTone(cur.tone), chosen: Boolean(cur.lang) };
    });
  }

  /** Language for a chat: the speaker's choice in 1:1, the host's for group pushes. */
  async langFor(userId) {
    return (await this.get(userId)).lang;
  }
}
