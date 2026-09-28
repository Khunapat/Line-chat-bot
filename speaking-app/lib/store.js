import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Session log kept as one JSON array in `<dataDir>/log.json`.
 * Writes go through a queue (no lost updates when requests overlap) and
 * land atomically (temp file + rename), so a crash never leaves half a file.
 */
export class LogStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'log.json');
    this.queue = Promise.resolve();
  }

  async readAll() {
    let text;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error(`${this.file} is not a JSON array`);
    return data;
  }

  async writeAll(entries) {
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(entries, null, 2) + '\n');
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Run `fn` after every earlier write has finished (a failure does not block later ones). */
  serialize(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Append an entry; fills in `id` and `date` when missing. Returns the stored entry. */
  append(entry) {
    return this.serialize(async () => {
      const stored = { id: crypto.randomUUID(), date: new Date().toISOString(), ...entry };
      const entries = await this.readAll();
      entries.push(stored);
      await this.writeAll(entries);
      return stored;
    });
  }

  /** All entries, newest first. */
  async list() {
    await this.queue;
    return (await this.readAll()).reverse();
  }
}

export function createStore(dataDir) {
  return new LogStore(dataDir);
}
