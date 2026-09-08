import { randomUUID } from 'node:crypto';

/**
 * Small JSON documents persisted in Drive under `<root>/_data/`:
 *   memory.json     - facts the user asked the bot to remember
 *   reminders.json  - pending reminders
 *   state.json      - per-user scratch state (last uploaded file, pending actions)
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

  async update(name, fallback, mutate) {
    const value = await this.read(name, fallback);
    const result = await mutate(value);
    await this.write(name, value);
    return result;
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
