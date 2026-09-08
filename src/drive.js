import { google } from 'googleapis';
import { Readable } from 'node:stream';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Thin wrapper around the Google Drive v3 API that knows how to keep a
 * `<root>/YYYY-MM-DD/` folder structure and upload into it.
 *
 * Auth is a plain OAuth2 refresh token for *your own* Google account, so
 * files land in your normal "My Drive" and count against your own quota.
 * (Service accounts have no storage on personal Gmail accounts, which is
 * why we don't use one.)
 */
export class DriveArchive {
  constructor({ clientId, clientSecret, refreshToken, rootFolderName = 'LineArchive', timeZone = 'UTC' }) {
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN are required');
    }
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    this.drive = google.drive({ version: 'v3', auth });
    this.rootFolderName = rootFolderName;
    this.timeZone = timeZone;
    this.folderCache = new Map(); // "parentId/name" -> folderId
  }

  /** Today's date as YYYY-MM-DD in the configured time zone. */
  todayKey(date = new Date()) {
    // en-CA gives ISO-style YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  /** HH-mm-ss in the configured time zone, safe for file names. */
  timeKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: this.timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .format(date)
      .replace(/:/g, '-');
  }

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

  /** Returns the folder id for `<root>/YYYY-MM-DD` (created on demand). */
  async dayFolder(date = new Date()) {
    const rootId = await this.findOrCreateFolder(this.rootFolderName, 'root');
    return this.findOrCreateFolder(this.todayKey(date), rootId);
  }

  /**
   * Upload a binary stream (photo / video / audio / file) into today's folder.
   * Returns { id, name, webViewLink }.
   */
  async uploadStream({ name, mimeType, body, date = new Date() }) {
    const parentId = await this.dayFolder(date);
    const { data } = await this.drive.files.create({
      requestBody: { name, parents: [parentId] },
      media: { mimeType: mimeType || 'application/octet-stream', body },
      fields: 'id, name, webViewLink',
    });
    return data;
  }

  /**
   * Append a block of text to `<root>/YYYY-MM-DD/notes.md`.
   * Text messages and links go here so a day's worth of notes is one file
   * instead of dozens of tiny ones. Returns { id, name, webViewLink }.
   */
  async appendNote(text, date = new Date()) {
    const parentId = await this.dayFolder(date);
    const fileName = 'notes.md';

    const q = [
      `name = '${escapeQuery(fileName)}'`,
      `'${parentId}' in parents`,
      'trashed = false',
    ].join(' and ');
    const { data } = await this.drive.files.list({ q, fields: 'files(id)', pageSize: 1 });
    const existingId = data.files?.[0]?.id;

    const entry = `## ${this.timeKey(date).replace(/-/g, ':')}\n\n${text.trim()}\n\n`;

    if (existingId) {
      const { data: current } = await this.drive.files.get(
        { fileId: existingId, alt: 'media' },
        { responseType: 'text' },
      );
      const merged = (typeof current === 'string' ? current : String(current ?? '')) + entry;
      const { data: updated } = await this.drive.files.update({
        fileId: existingId,
        media: { mimeType: 'text/markdown', body: Readable.from([merged]) },
        fields: 'id, name, webViewLink',
      });
      return updated;
    }

    const header = `# Notes ${this.todayKey(date)}\n\n`;
    const { data: created } = await this.drive.files.create({
      requestBody: { name: fileName, parents: [parentId] },
      media: { mimeType: 'text/markdown', body: Readable.from([header + entry]) },
      fields: 'id, name, webViewLink',
    });
    return created;
  }
}

function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
