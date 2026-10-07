import { randomUUID } from 'node:crypto';
import { withLock } from './lock.js';

/**
 * Small JSON documents persisted in Drive under `<root>/_data/`:
 *   memory.json     - facts the user asked the bot to remember
 *   reminders.json  - pending reminders
 *   state.json      - per-user scratch state (last uploaded file, pending actions)
 *   settings.json   - per-chat preferences (deadline alert schedule)
 *
 * Each document is cached in memory for a short while and written through on
 * every change. Fine for a single-user bot; run Cloud Run with max 1 instance
 * so two containers never race on the same file.
 */
export class Store {
  constructor(drive, { cacheMs = 20_000 } = {}) {
    this.drive = drive;
    this.cacheMs = cacheMs;
    this.cache = new Map(); // name -> { value, at }
    this.locks = new Map(); // name -> tail of the update queue
  }

  async read(name, fallback) {
    const hit = this.cache.get(name);
    if (hit && Date.now() - hit.at < this.cacheMs) return hit.value;
    const value = await this.drive.readJson(name, fallback);
    this.cache.set(name, { value, at: Date.now() });
    return value;
  }

  async write(name, value) {
    this.cache.set(name, { value, at: Date.now() });
    await this.drive.writeJson(name, value);
    return value;
  }

  /**
   * Read-modify-write one document. Updates to the same document are queued,
   * so two events handled at once (say a photo and a message sent together)
   * cannot read the same old copy and overwrite each other's change.
   */
  async update(name, fallback, mutate) {
    return withLock(this.locks, name, async () => {
      const value = await this.read(name, fallback);
      const result = await mutate(value);
      await this.write(name, value);
      return result;
    });
  }

  // ------------------------------------------------------------- memory

  async remember(text, { userId } = {}) {
    const entry = { id: shortId(), text: text.trim(), userId, createdAt: new Date().toISOString() };
    await this.update('memory.json', [], (list) => list.push(entry));
    return entry;
  }

  async memories() {
    return this.read('memory.json', []);
  }

  async forget(id) {
    return this.update('memory.json', [], (list) => {
      const idx = list.findIndex((m) => m.id === id);
      if (idx === -1) return null;
      return list.splice(idx, 1)[0];
    });
  }

  /** Cheap keyword search across remembered facts (newest first). */
  async searchMemory(query, limit = 10) {
    const list = await this.memories();
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const scored = list.map((m) => {
      const hay = m.text.toLowerCase();
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { m, score };
    });
    const matches = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || (a.m.createdAt < b.m.createdAt ? 1 : -1));
    return matches.slice(0, limit).map((s) => s.m);
  }

  // ---------------------------------------------------------- reminders

  async reminders() {
    return this.read('reminders.json', []);
  }

  async addReminder(reminder) {
    const entry = { id: shortId(), createdAt: new Date().toISOString(), repeat: 'none', ...reminder };
    await this.update('reminders.json', [], (list) => list.push(entry));
    return entry;
  }

  async updateReminder(id, patch) {
    return this.update('reminders.json', [], (list) => {
      const r = list.find((x) => x.id === id);
      if (!r) return null;
      Object.assign(r, patch);
      return r;
    });
  }

  async removeReminder(id) {
    return this.update('reminders.json', [], (list) => {
      const idx = list.findIndex((x) => x.id === id);
      if (idx === -1) return null;
      return list.splice(idx, 1)[0];
    });
  }

  // ------------------------------------------------------ opportunities

  async opportunities() {
    return this.read('opportunities.json', []);
  }

  async addOpportunity(opp) {
    const entry = { id: shortId(), createdAt: new Date().toISOString(), ...opp };
    await this.update('opportunities.json', [], (list) => list.push(entry));
    return entry;
  }

  async removeOpportunity(id) {
    return this.update('opportunities.json', [], (list) => {
      const idx = list.findIndex((x) => x.id === id);
      if (idx === -1) return null;
      return list.splice(idx, 1)[0];
    });
  }

  async updateOpportunity(id, patch) {
    return this.update('opportunities.json', [], (list) => {
      const o = list.find((x) => x.id === id);
      if (!o) return null;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete o[k];
        else o[k] = v;
      }
      return { ...o };
    });
  }

  /** Put a removed record back with its original id (undo delete). */
  async restoreOpportunity(opp) {
    return this.update('opportunities.json', [], (list) => {
      if (list.some((x) => x.id === opp.id)) return null;
      list.push(opp);
      return opp;
    });
  }

  /**
   * Replace the future deadline alerts of several opportunities in one write.
   * `plan` maps oppId -> array of new reminder fields. Alerts already fired,
   * or due but not yet sent (at <= now), are left alone so nothing is lost or
   * sent twice. Returns oppId -> ids of the alerts now scheduled.
   */
  async replaceDeadlineAlerts(plan, now = new Date()) {
    const ids = new Map([...plan.keys()].map((k) => [k, []]));
    await this.update('reminders.json', [], (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        if (r.oppId && plan.has(r.oppId) && !r.firedAt && new Date(r.at) > now) list.splice(i, 1);
      }
      for (const [oppId, entries] of plan) {
        for (const e of entries) {
          const entry = { id: shortId(), createdAt: now.toISOString(), repeat: 'none', ...e, oppId };
          list.push(entry);
          ids.get(oppId).push(entry.id);
        }
      }
    });
    return ids;
  }

  /** Drop every alert of one opportunity (used when it is deleted or merged away). */
  async removeAlertsFor(oppId) {
    return this.update('reminders.json', [], (list) => {
      let n = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].oppId === oppId) { list.splice(i, 1); n++; }
      }
      return n;
    });
  }

  // ------------------------------------------------------------ settings

  async settings() {
    return this.read('settings.json', {});
  }

  async updateSettings(patch) {
    return this.update('settings.json', {}, (all) => {
      Object.assign(all, patch);
      return { ...all };
    });
  }

  // ---------------------------------------------------------- file index
  // _data/files.json: { [fileId]: { name, day, caption, tags, mimeType, webViewLink } }

  async fileIndex() {
    return this.read('files.json', {});
  }

  async indexFile(fileId, info) {
    return this.update('files.json', {}, (idx) => { idx[fileId] = { ...(idx[fileId] || {}), ...info }; return idx[fileId]; });
  }

  /** Keyword match over captions, tags and names in the index. */
  async searchFileIndex(query, limit = 10) {
    const idx = await this.fileIndex();
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const scored = Object.entries(idx).map(([id, f]) => {
      const hay = [f.caption, f.name, ...(f.tags || [])].join(' ').toLowerCase();
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { id, f, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || (a.f.day < b.f.day ? 1 : -1));
    return scored.slice(0, limit).map((x) => ({ id: x.id, ...x.f }));
  }

  // --------------------------------------------------------------- links
  // _data/links.json: [{ id, url, title, host, day, at, caption, tags, userId }]

  async links() {
    return this.read('links.json', []);
  }

  async addLink({ url, title = '', day, at, caption = '', tags = [], userId }) {
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
    const link = { id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url, title, host, day, at, caption, tags, userId };
    await this.update('links.json', [], (list) => { list.push(link); });
    return link;
  }

  async updateLink(id, patch) {
    return this.update('links.json', [], (list) => {
      const l = list.find((x) => x.id === id);
      if (l) Object.assign(l, patch);
      return l || null;
    });
  }

  async removeLink(id) {
    return this.update('links.json', [], (list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return false;
      list.splice(i, 1);
      return true;
    });
  }

  /** Newest first. */
  async recentLinks(limit = 5) {
    const list = await this.links();
    return [...list].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
  }

  /** Keyword match over title, url, caption and tags. */
  async searchLinks(query, limit = 10) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const list = await this.links();
    return list.map((l) => {
      const hay = [l.title, l.url, l.host, l.caption, ...(l.tags || [])].join(' ').toLowerCase();
      return { l, score: terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || (a.l.at < b.l.at ? 1 : -1)).slice(0, limit).map((x) => x.l);
  }

  // -------------------------------------------------------------- state

  async getUserState(userId) {
    const all = await this.read('state.json', {});
    return all[userId] || {};
  }

  async setUserState(userId, patch) {
    return this.update('state.json', {}, (all) => {
      all[userId] = { ...(all[userId] || {}), ...patch };
      return all[userId];
    });
  }
}

export function shortId() {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}
