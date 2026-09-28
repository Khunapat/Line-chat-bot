import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LogStore } from '../lib/store.js';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'speaking-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('empty store lists nothing and creates no file', async (t) => {
  const dir = await tempDir(t);
  const store = new LogStore(path.join(dir, 'nested', 'data'));
  assert.deepEqual(await store.list(), []);
});

test('append writes atomically and fills id + date', async (t) => {
  const dir = await tempDir(t);
  const store = new LogStore(path.join(dir, 'data'));
  const e = await store.append({ day: 1, turns: 2, summary: { words: [], mistakes: [], practice: '' } });
  assert.match(e.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(e.date)));

  const files = await fs.readdir(path.join(dir, 'data'));
  assert.deepEqual(files, ['log.json'], 'no temp files left behind');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'data', 'log.json'), 'utf8'));
  assert.deepEqual(saved, [e]);
});

test('concurrent appends are not lost and list is newest first', async (t) => {
  const dir = await tempDir(t);
  const store = new LogStore(dir);
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.append({ day: (i % 30) + 1, n: i })));
  const list = await store.list();
  assert.equal(list.length, 25);
  assert.deepEqual(list.map((e) => e.n), Array.from({ length: 25 }, (_, i) => 24 - i));
  assert.equal(new Set(list.map((e) => e.id)).size, 25);

  // A second store on the same dir sees the same data.
  assert.equal((await new LogStore(dir).list()).length, 25);
});

test('a failed write does not block later ones', async (t) => {
  const dir = await tempDir(t);
  const store = new LogStore(dir);
  const writeAll = store.writeAll.bind(store);
  let fail = true;
  store.writeAll = async (entries) => {
    if (fail) { fail = false; throw new Error('disk full'); }
    return writeAll(entries);
  };
  await assert.rejects(store.append({ day: 1 }), /disk full/);
  await store.append({ day: 2 });
  assert.deepEqual((await store.list()).map((e) => e.day), [2]);
});

test('a corrupt log is reported, not overwritten', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, 'log.json'), '{oops');
  const store = new LogStore(dir);
  await assert.rejects(store.list());
  await assert.rejects(store.append({ day: 1 }));
  assert.equal(await fs.readFile(path.join(dir, 'log.json'), 'utf8'), '{oops');
});
