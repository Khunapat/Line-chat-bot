import { DriveArchive } from './drive.js';
import { Store } from './store.js';
import { Calendar } from './calendar.js';

/**
 * A tenant is one place things get archived to: a person's 1:1 chat (their
 * own Drive) or a LINE group (a sub-folder in the host member's Drive).
 *
 *   { id, type: 'user'|'group', name, email, refreshToken, clientKind: 'desktop'|'web',
 *     hostUserId, subFolders: [], timeZone, createdAt }
 *
 * The registry lives in the owner's Drive (_data/tenants.json). Owner ids from
 * ALLOWED_USER_IDS are tenants implicitly, using the token from the
 * environment, so the single-user setup keeps working unchanged.
 */
export class Tenants {
  constructor({ ownerStore, ownerIds = [], ownerToken, ownerName = '', google, googleWeb, rootFolderName, timeZone }) {
    this.ownerStore = ownerStore;
    this.ownerIds = new Set(ownerIds);
    this.ownerToken = ownerToken;
    this.ownerName = ownerName;
    this.google = google;
    this.googleWeb = googleWeb;
    this.rootFolderName = rootFolderName;
    this.timeZone = timeZone;
    this.cache = new Map(); // tenant id -> { key, svc }
  }

  isOwner(userId) {
    return this.ownerIds.has(userId);
  }

  async registry() {
    return this.ownerStore.read('tenants.json', {});
  }

  async list() {
    const reg = await this.registry();
    const list = Object.values(reg);
    for (const id of this.ownerIds) if (!reg[id]) list.push(this.ownerTenant(id));
    return list;
  }

  ownerTenant(id) {
    return { id, type: 'user', name: this.ownerName, refreshToken: this.ownerToken, clientKind: 'desktop', subFolders: [], timeZone: this.timeZone, owner: true };
  }

  async get(id) {
    const reg = await this.registry();
    if (reg[id]) return reg[id];
    if (this.ownerIds.has(id)) return this.ownerTenant(id);
    return null;
  }

  async upsert(tenant) {
    const t = { subFolders: [], timeZone: this.timeZone, createdAt: new Date().toISOString(), ...tenant };
    await this.ownerStore.update('tenants.json', {}, (reg) => { reg[t.id] = { ...(reg[t.id] || {}), ...t }; });
    this.cache.delete(t.id);
    return t;
  }

  async remove(id) {
    const removed = await this.ownerStore.update('tenants.json', {}, (reg) => { const t = reg[id]; delete reg[id]; return t || null; });
    this.cache.delete(id);
    return removed;
  }

  /** Groups hosted by a user (for cleanup when they disconnect). */
  async groupsHostedBy(userId) {
    return (await this.list()).filter((t) => t.type === 'group' && t.hostUserId === userId);
  }

  /** Resolve the token + OAuth client a tenant should use (groups borrow the host's). */
  async credentials(tenant) {
    let source = tenant;
    if (tenant.type === 'group') {
      source = await this.get(tenant.hostUserId);
      if (!source) return null;
    }
    if (!source.refreshToken) return null;
    const client = source.clientKind === 'web' ? this.googleWeb : this.google;
    if (!client?.clientId || !client?.clientSecret) return null;
    return { refreshToken: source.refreshToken, clientId: client.clientId, clientSecret: client.clientSecret };
  }

  /** { drive, store, calendar } for a tenant, cached while its token is unchanged. */
  async services(tenant) {
    const creds = await this.credentials(tenant);
    if (!creds) return null;
    const key = `${creds.refreshToken}|${(tenant.subFolders || []).join('/')}|${tenant.timeZone || this.timeZone}`;
    const hit = this.cache.get(tenant.id);
    if (hit && hit.key === key) return hit.svc;
    const drive = new DriveArchive({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
      rootFolderName: this.rootFolderName,
      subFolders: tenant.subFolders || [],
      timeZone: tenant.timeZone || this.timeZone,
    });
    const store = new Store(drive);
    const calendar = new Calendar(drive.auth, { timeZone: tenant.timeZone || this.timeZone });
    const svc = { drive, store, calendar, tenant };
    this.cache.set(tenant.id, { key, svc });
    return svc;
  }

  async servicesFor(id) {
    const tenant = await this.get(id);
    return tenant ? this.services(tenant) : null;
  }
}
