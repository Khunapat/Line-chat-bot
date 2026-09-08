import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signGalleryToken, verifyGalleryToken, galleryUrl, galleryPage } from '../src/gallery.js';
import { captionSlug } from '../src/opportunities.js';

test('gallery tokens verify, expire, and reject tampering', () => {
  const t = signGalleryToken('s3cret', 60_000);
  assert.ok(verifyGalleryToken('s3cret', t));
  assert.equal(verifyGalleryToken('other', t), false);
  assert.equal(verifyGalleryToken('s3cret', t + 'x'), false);
  assert.equal(verifyGalleryToken('s3cret', signGalleryToken('s3cret', -1)), false); // already expired
  assert.equal(verifyGalleryToken('s3cret', 'garbage'), false);
  assert.equal(verifyGalleryToken('', t), false);
});

test('galleryUrl and page embed the token contract and bot name', () => {
  const url = galleryUrl('https://x.a.run.app/', 's3cret');
  assert.match(url, /^https:\/\/x\.a\.run\.app\/gallery\?t=\d+\.[A-Za-z0-9_-]+$/);
  const html = galleryPage({ botName: 'JaiJa <b>' });
  assert.match(html, /JaiJa &lt;b&gt;/);
  assert.match(html, /\/api\/gallery\/month/);
  assert.match(html, /Bai\+Jamjuree/);
});

test('captionSlug keeps Thai and Latin, drops unsafe characters, caps length', () => {
  assert.equal(captionSlug('ใบเสร็จร้านกาแฟ Starbucks'), 'ใบเสร็จร้านกาแฟ_Starbucks');
  assert.equal(captionSlug('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.ok(captionSlug('x'.repeat(100)).length <= 40);
  assert.equal(captionSlug(''), '');
});
