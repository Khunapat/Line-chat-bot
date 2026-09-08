import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tenants } from '../src/tenants.js';
import { Store } from '../src/store.js';
import { signState, verifyState, connectUrl } from '../src/oauth.js';

function fakeOwnerStore() {
  const docs = new Map();
  const drive = {
    async readJson(name, fallback) { return docs.has(name) ? structuredClone(docs.get(name)) : structuredClone(fallback); },
    async writeJson(name, value) { docs.set(name, structuredClone(value)); },
  };
  return new Store(drive, { cacheMs: 0 });
}

const google = { clientId: 'desk', clientSecret: 'desk-s' };
const googleWeb = { clientId: 'web', clientSecret: 'web-s' };

test('owner is an implicit tenant using the environment token', async () => {
  const t = new Tenants({ ownerStore: fakeOwnerStore(), ownerIds: ['U1'], ownerToken: 'tok', ownerName: 'Jai', google, googleWeb, rootFolderName: 'LineArchive', timeZone: 'Asia/Bangkok' });
  const owner = await t.get('U1');
  assert.equal(owner.type, 'user');
  assert.equal(owner.name, 'Jai');
  assert.equal(await t.get('U2'), null);
  assert.deepEqual(await t.credentials(owner), { refreshToken: 'tok', clientId: 'desk', clientSecret: 'desk-s' });
  assert.equal((await t.list()).length, 1);
});

test('connected users use the web client; groups borrow the host token', async () => {
  const t = new Tenants({ ownerStore: fakeOwnerStore(), ownerIds: ['U1'], ownerToken: 'tok', google, googleWeb, rootFolderName: 'LineArchive', timeZone: 'Asia/Bangkok' });
  await t.upsert({ id: 'U2', type: 'user', refreshToken: 'r2', clientKind: 'web', email: 'b@x.com' });
  await t.upsert({ id: 'U2', name: 'Bee' }); // partial update keeps the token
  const u2 = await t.get('U2');
  assert.equal(u2.refreshToken, 'r2');
  assert.equal(u2.name, 'Bee');
  assert.deepEqual(await t.credentials(u2), { refreshToken: 'r2', clientId: 'web', clientSecret: 'web-s' });

  await t.upsert({ id: 'C1', type: 'group', name: 'Family', hostUserId: 'U2', subFolders: ['Groups', 'Family'] });
  const g = await t.get('C1');
  assert.deepEqual(await t.credentials(g), { refreshToken: 'r2', clientId: 'web', clientSecret: 'web-s' });
  assert.deepEqual((await t.groupsHostedBy('U2')).map((x) => x.id), ['C1']);

  const svc = await t.services(g);
  assert.deepEqual(svc.drive.subFolders, ['Groups', 'Family']);
  assert.equal(await t.services(g), svc); // cached while the token is unchanged

  await t.remove('U2');
  assert.equal(await t.credentials(g), null); // host gone
  assert.equal((await t.list()).length, 2); // owner + orphaned group
});

test('services returns null without usable credentials', async () => {
  const t = new Tenants({ ownerStore: fakeOwnerStore(), ownerIds: [], ownerToken: '', google, googleWeb: {}, rootFolderName: 'LineArchive', timeZone: 'UTC' });
  await t.upsert({ id: 'U9', type: 'user', refreshToken: 'r', clientKind: 'web' });
  assert.equal(await t.services(await t.get('U9')), null); // no web client configured
});

test('oauth state round-trips the user id and rejects tampering', () => {
  const s = signState('sec', 'U123', 60_000);
  assert.equal(verifyState('sec', s), 'U123');
  assert.equal(verifyState('other', s), null);
  assert.equal(verifyState('sec', signState('sec', 'U123', -1)), null);
  assert.match(connectUrl('https://x.run.app/', 'sec', 'U123'), /^https:\/\/x\.run\.app\/connect\?s=\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});
