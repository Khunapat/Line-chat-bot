// In-memory stand-ins for Drive, Calendar, tenants and LINE, shared by the
// app API tests and the local preview server (scripts/preview-app.mjs).
import { Store } from '../../src/store.js';

export function fakeDrive({ files = [], email = 'jai.example@gmail.com' } = {}) {
  const docs = new Map();
  return {
    docs,
    files,
    md: '',
    failAllFiles: false,
    failReads: false,
    async readJson(name, fallback) {
      if (this.failReads) throw new Error('drive read failed');
      return docs.has(name) ? structuredClone(docs.get(name)) : structuredClone(fallback);
    },
    async writeJson(name, value) { docs.set(name, structuredClone(value)); },
    async writeRootText(_name, text) { this.md = text; },
    async accountEmail() { return email; },
    async allFiles() {
      if (this.failAllFiles) throw new Error('drive list failed');
      return this.files.map((f) => ({ ...f }));
    },
    async rootFolderLink() { return 'https://drive.google.com/drive/folders/root'; },
    todayKey: () => '2026-10-07',
  };
}

export function fakeCalendar({ events = [] } = {}) {
  const created = new Map();
  let n = 0;
  return {
    events,
    created,
    fail: null, // 'scope' | 'error'
    async listRange() {
      if (this.fail === 'scope') { const e = new Error('insufficient scope'); e.code = 403; throw e; }
      if (this.fail === 'error') throw new Error('calendar down');
      return this.events.map((e) => ({ ...e }));
    },
    async listUpcoming() {
      if (this.fail === 'scope') { const e = new Error('insufficient scope'); e.code = 403; throw e; }
      if (this.fail === 'error') throw new Error('calendar down');
      return [];
    },
    async createEvent({ title, start }) { const id = `ev${++n}`; created.set(id, { title, date: start }); return { id, title, start, allDay: true }; },
    async moveAllDayEvent(id, date) { const e = created.get(id); if (e) e.date = date; return { id }; },
    async deleteEvent(id) { return created.delete(id); },
    async findAllDay() { return []; },
  };
}

export function makeSvc(tenant, opts = {}) {
  const drive = fakeDrive(opts);
  return { drive, store: new Store(drive, { cacheMs: 0 }), calendar: fakeCalendar(opts), tenant };
}

/** Tenants registry with fixed services per tenant id. */
export function fakeTenants({ tenants = [], owners = [] } = {}) {
  const reg = new Map(tenants.map((t) => [t.id, { subFolders: [], ...t }]));
  const svcs = new Map();
  return {
    reg,
    svcs,
    isOwner: (id) => owners.includes(id),
    async get(id) { return reg.get(id) || null; },
    async list() { return [...reg.values()]; },
    async services(t) { return svcs.get(t.id) || null; },
    async servicesFor(id) { return svcs.get(id) || null; },
    async groupsHostedBy(uid) { return [...reg.values()].filter((t) => t.type === 'group' && t.hostUserId === uid); },
    async remove(id) { const t = reg.get(id); reg.delete(id); svcs.delete(id); return t || null; },
    attach(id, svc) { svcs.set(id, svc); },
  };
}

/** LINE client: profiles plus group membership. */
export function fakeLine({ members = {}, profiles = {} } = {}) {
  const calls = [];
  const notMember = () => Object.assign(new Error('Not found'), { status: 404 });
  return {
    calls,
    async getProfile(uid) {
      calls.push(['getProfile', uid]);
      if (!profiles[uid]) throw notMember();
      return { displayName: profiles[uid], pictureUrl: '' };
    },
    async getGroupMemberProfile(gid, uid) {
      calls.push(['getGroupMemberProfile', gid, uid]);
      if (!(members[gid] || []).includes(uid)) throw notMember();
      return { displayName: profiles[uid] || '' };
    },
    async getRoomMemberProfile(rid, uid) {
      calls.push(['getRoomMemberProfile', rid, uid]);
      if (!(members[rid] || []).includes(uid)) throw notMember();
      return { displayName: profiles[uid] || '' };
    },
  };
}

/** Memory-only Prefs-compatible store. */
export function memoryStore() {
  const docs = new Map();
  return {
    docs,
    async read(name, fallback) { return docs.has(name) ? structuredClone(docs.get(name)) : structuredClone(fallback); },
    async update(name, fallback, mutate) {
      const v = docs.has(name) ? structuredClone(docs.get(name)) : structuredClone(fallback);
      const r = await mutate(v);
      docs.set(name, v);
      return r;
    },
  };
}
