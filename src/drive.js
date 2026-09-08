import { google } from 'googleapis';
import { Readable } from 'node:stream';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DATA_FOLDER = '_data'; // JSON state (reminders, memory) lives here

/**
 * Google Drive v3 wrapper that keeps a `<root>/YYYY-MM-DD/` folder structure,
 * uploads into it, and stores small JSON documents under `<root>/_data/`.
 *
 * Auth is an OAuth2 refresh token for *your own* Google account, so files
 * land in your normal "My Drive". (Service accounts have no storage quota on
 * personal Gmail accounts, which is why we don't use one.)
 */
export class DriveArchive {
  constructor({ clientId, clientSecret, refreshToken, rootFolderName = 'LineArchive', timeZone = 'UTC' }) {
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN are required');
    }
    this.auth = new google.auth.OAuth2(clientId, clientSecret);
    this.auth.setCredentials({ refresh_token: refreshToken });
    this.drive = google.drive({ version: 'v3', auth: this.auth });
    this.rootFolderName = rootFolderName;
    this.timeZone = timeZone;
    this.folderCache = new Map(); // "parentId/name" -> folderId
    this.fileIdCache = new Map(); // "parentId/name" -> fileId (json docs, notes)
  }

  // ---------------------------------------------------------------- dates

  /** YYYY-MM-DD in the configured time zone. */
  todayKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  }

  /** HH-mm-ss in the configured time zone, safe for file names. */
  timeKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: this.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(date).replace(/:/g, '-');
  }

  // -------------------------------------------------------------- folders

  async findOrCreateFolder(name, parentId = 'root') {
    const cacheKey = `${parentId}/${name}`;
    if (this.folderCache.has(cacheKey)) return this.folderCache.get(cacheKey);

    const q = [
      `name = '${escapeQuery(name)}'`,
      `mimeType = '${FOLDER_MIME}'`,
      `'${parentId}' in parents`,
      'trashed = false',
    ].join(' and ');
    const { data } = await this.drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
    let id = data.files?.[0]?.id;
    if (!id) {
      const { data: created } = await this.drive.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
        fields: 'id',
      });
      id = created.id;
    }
    this.folderCache.set(cacheKey, id);
    return id;
  }

  rootFolder() {
    return this.findOrCreateFolder(this.rootFolderName, 'root');
  }

  /** `<root>/YYYY-MM-DD` (created on demand). */
  async dayFolder(date = new Date()) {
    return this.findOrCreateFolder(this.todayKey(date), await this.rootFolder());
  }

  async dataFolder() {
    return this.findOrCreateFolder(DATA_FOLDER, await this.rootFolder());
  }

  async findFileInFolder(name, parentId) {
    const cacheKey = `${parentId}/${name}`;
    if (this.fileIdCache.has(cacheKey)) return this.fileIdCache.get(cacheKey);
    const q = [`name = '${escapeQuery(name)}'`, `'${parentId}' in parents`, 'trashed = false'].join(' and ');
    const { data } = await this.drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
    const id = data.files?.[0]?.id;
    if (id) this.fileIdCache.set(cacheKey, id);
    return id;
  }

  // -------------------------------------------------------------- uploads

  /** Upload a binary stream into today's folder. Returns a file record. */
  async uploadStream({ name, mimeType, body, date = new Date() }) {
    const parentId = await this.dayFolder(date);
    const { data } = await this.drive.files.create({
      requestBody: { name, parents: [parentId] },
      media: { mimeType: mimeType || 'application/octet-stream', body },
      fields: FILE_FIELDS,
    });
    this._allFiles = null;
    return decorate(data, this.todayKey(date));
  }

  /** Append a block of text to `<root>/YYYY-MM-DD/notes.md`. */
  async appendNote(text, date = new Date()) {
    const parentId = await this.dayFolder(date);
    const entry = `## ${this.timeKey(date).replace(/-/g, ':')}\n\n${text.trim()}\n\n`;
    const file = await this.upsertText({
      name: 'notes.md',
      parentId,
      mimeType: 'text/markdown',
      header: `# Notes ${this.todayKey(date)}\n\n`,
      append: entry,
    });
    return decorate(file, this.todayKey(date));
  }

  /** Create or append to a text file. */
  async upsertText({ name, parentId, mimeType, header = '', append }) {
    const existingId = await this.findFileInFolder(name, parentId);
    if (existingId) {
      const { data: current } = await this.drive.files.get(
        { fileId: existingId, alt: 'media' }, { responseType: 'text' },
      );
      const merged = (typeof current === 'string' ? current : String(current ?? '')) + append;
      const { data } = await this.drive.files.update({
        fileId: existingId,
        media: { mimeType, body: Readable.from([merged]) },
        fields: FILE_FIELDS,
      });
      return data;
    }
    const { data } = await this.drive.files.create({
      requestBody: { name, parents: [parentId] },
      media: { mimeType, body: Readable.from([header + append]) },
      fields: FILE_FIELDS,
    });
    this.fileIdCache.set(`${parentId}/${name}`, data.id);
    return data;
  }

  /** Metadata for one file. */
  async fileInfo(fileId) {
    const { data } = await this.drive.files.get({ fileId, fields: FILE_FIELDS });
    return decorate(data);
  }

  /** Download a file's bytes (for re-scanning a poster). */
  async download(fileId) {
    const { data } = await this.drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    return Buffer.from(data);
  }

  /** Create or replace `<root>/<name>` with the given text. */
  async writeRootText(name, text, mimeType = 'text/markdown') {
    const parentId = await this.rootFolder();
    const body = Readable.from([text]);
    const existingId = await this.findFileInFolder(name, parentId);
    if (existingId) {
      const { data } = await this.drive.files.update({ fileId: existingId, media: { mimeType, body }, fields: FILE_FIELDS });
      return decorate(data);
    }
    const { data } = await this.drive.files.create({
      requestBody: { name, parents: [parentId] },
      media: { mimeType, body },
      fields: FILE_FIELDS,
    });
    this.fileIdCache.set(`${parentId}/${name}`, data.id);
    return decorate(data);
  }

  // ------------------------------------------------------------ json docs

  /** Read `<root>/_data/<name>` as JSON, or `fallback` when missing. */
  async readJson(name, fallback) {
    const parentId = await this.dataFolder();
    const id = await this.findFileInFolder(name, parentId);
    if (!id) return structuredClone(fallback);
    const { data } = await this.drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' });
    try {
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      return structuredClone(fallback);
    }
  }

  /** Write (replace) `<root>/_data/<name>`. */
  async writeJson(name, value) {
    const parentId = await this.dataFolder();
    const body = Readable.from([JSON.stringify(value, null, 2)]);
    const existingId = await this.findFileInFolder(name, parentId);
    if (existingId) {
      await this.drive.files.update({ fileId: existingId, media: { mimeType: 'application/json', body } });
      return existingId;
    }
    const { data } = await this.drive.files.create({
      requestBody: { name, parents: [parentId] },
      media: { mimeType: 'application/json', body },
      fields: 'id',
    });
    this.fileIdCache.set(`${parentId}/${name}`, data.id);
    return data.id;
  }

  // --------------------------------------------------------------- search

  /**
   * Find archived files whose name contains `query` (case-insensitive on
   * Drive's side). Falls back to full-text search when nothing matches by
   * name. Notes and JSON state are excluded.
   */
  async findFiles(query, limit = 5) {
    const dataId = await this.dataFolder();
    const base = [
      `mimeType != '${FOLDER_MIME}'`,
      `not '${dataId}' in parents`,
      "name != 'notes.md'",
      'trashed = false',
    ];
    const terms = String(query || '').trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.recentFiles(limit);

    const byName = [...base, ...terms.map((t) => `name contains '${escapeQuery(t)}'`)].join(' and ');
    let files = await this.list(byName, limit);
    if (files.length === 0) {
      const fullText = [...base, `fullText contains '${escapeQuery(terms.join(' '))}'`].join(' and ');
      files = await this.list(fullText, limit);
    }
    return files;
  }

  /** Most recently archived files (excluding notes / state). */
  async recentFiles(limit = 5) {
    const dataId = await this.dataFolder();
    const q = [
      `mimeType != '${FOLDER_MIME}'`,
      `not '${dataId}' in parents`,
      "name != 'notes.md'",
      'trashed = false',
    ].join(' and ');
    return this.list(q, limit);
  }

  async list(q, limit) {
    const { data } = await this.drive.files.list({
      q,
      orderBy: 'modifiedTime desc',
      pageSize: limit,
      fields: `files(${FILE_FIELDS})`,
    });
    return (data.files || []).map((f) => decorate(f));
  }

  /**
   * Every archived file (non-folder, outside _data), with the day folder name
   * it lives in. Cached briefly; the gallery calls this per page view.
   */
  async allFiles({ cacheMs = 60_000 } = {}) {
    if (this._allFiles && Date.now() - this._allFiles.at < cacheMs) return this._allFiles.value;
    const rootId = await this.rootFolder();
    const dataId = await this.dataFolder();
    const { data: folderData } = await this.drive.files.list({
      q: `'${rootId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: 'files(id, name)', pageSize: 1000,
    });
    const dayOf = new Map((folderData.files || []).map((f) => [f.id, f.name]));
    const files = [];
    let pageToken;
    do {
      const { data } = await this.drive.files.list({
        q: `mimeType != '${FOLDER_MIME}' and not '${dataId}' in parents and trashed = false`,
        fields: `nextPageToken, files(${FILE_FIELDS}, parents, thumbnailLink)`,
        pageSize: 1000,
        pageToken,
      });
      for (const f of data.files || []) {
        const parent = (f.parents || [])[0];
        const day = dayOf.get(parent);
        if (!day && parent !== rootId) continue; // stray file outside our tree
        files.push({ ...decorate(f, day || f.createdTime?.slice(0, 10)), hasThumb: Boolean(f.thumbnailLink), thumbnailLink: f.thumbnailLink });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    this._allFiles = { value: files, at: Date.now() };
    return files;
  }

  /** Fetch a Drive thumbnail with our credentials. Returns { body, contentType } or null. */
  async thumbnail(fileId, size = 400) {
    const { data } = await this.drive.files.get({ fileId, fields: 'thumbnailLink' });
    if (!data.thumbnailLink) return null;
    const url = data.thumbnailLink.replace(/=s\d+$/, `=s${size}`);
    const { token } = await this.auth.getAccessToken();
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    return { body: Buffer.from(await resp.arrayBuffer()), contentType: resp.headers.get('content-type') || 'image/jpeg' };
  }

  /** Rename a file, keeping its extension when the new label has none. */
  async renameFile(fileId, label) {
    const { data: current } = await this.drive.files.get({ fileId, fields: 'name' });
    const ext = extensionOf(current.name);
    const clean = label.trim().replace(/[\\/:*?"<>|]/g, '_');
    const newName = extensionOf(clean) ? clean : clean + ext;
    const { data } = await this.drive.files.update({
      fileId,
      requestBody: { name: newName },
      fields: FILE_FIELDS,
    });
    this._allFiles = null;
    return decorate(data);
  }
}

const FILE_FIELDS = 'id, name, mimeType, webViewLink, modifiedTime, createdTime, size';

function decorate(file, dayKey) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    webViewLink: file.webViewLink,
    modifiedTime: file.modifiedTime,
    createdTime: file.createdTime,
    size: file.size ? Number(file.size) : undefined,
    day: dayKey || (file.createdTime ? file.createdTime.slice(0, 10) : undefined),
  };
}

function extensionOf(name) {
  const m = /\.[A-Za-z0-9]{1,6}$/.exec(name || '');
  return m ? m[0] : '';
}

function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
