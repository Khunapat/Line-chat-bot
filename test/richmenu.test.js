import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const load = (lang) => JSON.parse(fs.readFileSync(new URL(`../assets/richmenu-areas.${lang}.json`, import.meta.url), 'utf8'));
const png = (lang) => fs.readFileSync(new URL(`../assets/richmenu.${lang}.png`, import.meta.url));

test('Thai and English menus share one action map shape', () => {
  const th = load('th');
  const en = load('en');
  assert.equal(th.areas.length, 8);
  assert.deepEqual(th.areas.map((a) => [a.data, a.bounds]), en.areas.map((a) => [a.data, a.bounds]));
  assert.equal(th.chatBarText, 'เมนู JaiJa');
  assert.equal(en.chatBarText, 'JaiJa menu');
});

test('areas are inside the image, do not overlap and use known actions', () => {
  const known = ['menu_new_reminder', 'menu_help', 'menu_notes', 'menu_gallery', 'menu_reminders', 'menu_deadlines', 'menu_files', 'menu_settings'];
  for (const lang of ['th', 'en']) {
    const m = load(lang);
    for (const [i, a] of m.areas.entries()) {
      const b = a.bounds;
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= m.width && b.y + b.height <= m.height, `${a.data} outside`);
      assert.ok(known.includes(a.data.replace('action=', '')), a.data);
      assert.ok(a.text && a.text.length <= 20, `label too long: ${a.text}`);
      for (const c of m.areas.slice(i + 1)) {
        const o = b.x < c.bounds.x + c.bounds.width && c.bounds.x < b.x + b.width && b.y < c.bounds.y + c.bounds.height && c.bounds.y < b.y + b.height;
        assert.ok(!o, `${a.data} overlaps ${c.data}`);
      }
    }
    assert.equal(m.areas.find((a) => a.data === 'action=menu_settings').liffPath, '/me');
    assert.equal(m.areas.find((a) => a.data === 'action=menu_new_reminder').inputOption, 'openKeyboard');
  }
});

test('images are 2500x1686 PNGs under LINE\'s 1 MB limit', () => {
  for (const lang of ['th', 'en']) {
    const buf = png(lang);
    assert.equal(buf.toString('latin1', 1, 4), 'PNG');
    assert.equal(buf.readUInt32BE(16), 2500);
    assert.equal(buf.readUInt32BE(20), 1686);
    assert.ok(buf.length < 1024 * 1024);
  }
});
