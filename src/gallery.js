/**
 * Private gallery: a calendar of everything the bot archived, served by the
 * bot itself. Links carry a signed, expiring token so the page is not public.
 *
 *   GET /gallery?t=...                 the page
 *   GET /api/gallery/month?t=&m=YYYY-MM  files + deadlines for a month
 *   GET /api/gallery/search?t=&q=...   keyword search (index + names)
 *   GET /api/gallery/thumb/:id?t=      thumbnail proxy (Drive needs our token)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sortOpportunities, describeDeadline, KIND_THAI } from './opportunities.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function signGalleryToken(secret, tenantId, ttlMs = DAY_MS) {
  const exp = String(Date.now() + ttlMs);
  const tid = Buffer.from(String(tenantId)).toString('base64url');
  return `${exp}.${tid}.${hmac(secret, `${exp}.${tid}`)}`;
}

/** Returns the tenant id when the token is valid, otherwise null. */
export function verifyGalleryToken(secret, token) {
  if (!secret || typeof token !== 'string') return null;
  const [exp, tid, sig] = token.split('.');
  if (!exp || !tid || !sig || !/^\d+$/.test(exp)) return null;
  if (Number(exp) < Date.now()) return null;
  const expected = hmac(secret, `${exp}.${tid}`);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return Buffer.from(tid, 'base64url').toString();
}

function hmac(secret, data) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/** A no-expiry thumbnail URL scoped to one file, for images inside chat cards. */
export function thumbUrl(base, secret, tenantId, fileId, size = 600) {
  const tid = Buffer.from(String(tenantId)).toString('base64url');
  return `${base.replace(/\/+$/, '')}/thumb/${tid}/${encodeURIComponent(fileId)}.jpg?s=${hmac(secret, `thumb.${tid}.${fileId}`)}&z=${size}`;
}

export function verifyThumbSig(secret, tid, fileId, sig) {
  if (!secret || !tid || !fileId || typeof sig !== 'string') return null;
  const expected = hmac(secret, `thumb.${tid}.${fileId}`);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return Buffer.from(tid, 'base64url').toString();
}

export function galleryUrl(base, secret, tenantId) {
  return `${base.replace(/\/+$/, '')}/gallery?t=${signGalleryToken(secret, tenantId)}`;
}

/**
 * `resolve(tenantId)` returns { drive, store } for a tenant, or null.
 */
export function registerGalleryRoutes(app, { resolve, secret, timeZone, botName }) {
  const guard = async (req, res, next) => {
    try {
      const tenantId = verifyGalleryToken(secret, req.query.t);
      const svc = tenantId ? await resolve(tenantId) : null;
      if (!svc) return res.status(401).send('ลิงก์หมดอายุแล้ว กดเมนู "ไฟล์/รูป" ในแชทเพื่อขอลิงก์ใหม่');
      req.svc = svc;
      next();
    } catch (err) {
      console.error('gallery auth failed', err?.message || err);
      res.status(500).send('failed');
    }
  };

  app.get('/gallery', (req, res) => {
    if (!verifyGalleryToken(secret, req.query.t)) {
      return res.status(401).type('html').send(expiredPage());
    }
    res.type('html').send(galleryPage({ botName }));
  });

  app.get('/api/gallery/month', guard, async (req, res) => {
    const m = /^\d{4}-\d{2}$/.test(req.query.m || '') ? req.query.m : null;
    if (!m) return res.status(400).json({ error: 'm=YYYY-MM' });
    try {
      const { drive, store } = req.svc;
      const [files, index, opps, links] = await Promise.all([drive.allFiles(), store.fileIndex(), store.opportunities(), store.links()]);
      const inMonth = [
        ...files.filter((f) => (f.day || '').startsWith(m) && !isMeta(f)).map((f) => publicFile(f, index[f.id])),
        ...links.filter((l) => (l.day || '').startsWith(m)).map(publicLink),
      ];
      const deadlines = opps.filter((o) => (o.deadline || '').startsWith(m)).map(publicOpp);
      const counts = {};
      for (const f of inMonth) counts[f.day] = (counts[f.day] || 0) + 1;
      res.json({ month: m, counts, files: inMonth, deadlines });
    } catch (err) {
      console.error('gallery month failed', err?.message || err);
      res.status(500).json({ error: 'failed' });
    }
  });

  app.get('/api/gallery/search', guard, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ files: [], opportunities: [], memories: [] });
    try {
      const { drive, store } = req.svc;
      const [files, index, opps, memories, links] = await Promise.all([drive.allFiles(), store.fileIndex(), store.opportunities(), store.searchMemory(q, 10), store.searchLinks(q, 30)]);
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      const hit = (s) => { const h = String(s || '').toLowerCase(); return terms.some((t) => h.includes(t)); };
      const matched = files
        .filter((f) => !isMeta(f) && (hit(f.name) || hit(index[f.id]?.caption) || (index[f.id]?.tags || []).some(hit)))
        .sort((a, b) => (a.day < b.day ? 1 : -1))
        .slice(0, 60)
        .map((f) => publicFile(f, index[f.id]))
        .concat(links.map(publicLink));
      const oppHits = sortOpportunities(opps.filter((o) => hit(o.title) || hit(o.organizer) || hit(o.summary)), timeZone).map(publicOpp);
      res.json({ files: matched, opportunities: oppHits, memories: memories.map((x) => ({ text: x.text, createdAt: x.createdAt })) });
    } catch (err) {
      console.error('gallery search failed', err?.message || err);
      res.status(500).json({ error: 'failed' });
    }
  });

  app.get('/api/gallery/thumb/:id', guard, async (req, res) => {
    try {
      const size = Math.min(Math.max(Number(req.query.s) || 400, 64), 1600);
      const t = await req.svc.drive.thumbnail(req.params.id, size);
      if (!t) return res.status(204).end();
      res.set('Content-Type', t.contentType);
      res.set('Cache-Control', 'private, max-age=86400');
      res.send(t.body);
    } catch (err) {
      console.error('thumb failed', err?.message || err);
      res.status(404).end();
    }
  });

  // Thumbnail for chat cards: LINE fetches this whenever the card is shown.
  app.get('/thumb/:tid/:file', async (req, res) => {
    try {
      const fileId = String(req.params.file || '').replace(/\.jpg$/i, '');
      const tenantId = verifyThumbSig(secret, req.params.tid, fileId, req.query.s);
      const svc = tenantId ? await resolve(tenantId) : null;
      if (!svc) return res.status(404).end();
      const size = Math.min(Math.max(Number(req.query.z) || 600, 64), 1024);
      const t = await svc.drive.thumbnail(fileId, size);
      if (!t) return res.status(404).end();
      res.set('Content-Type', t.contentType);
      res.set('Cache-Control', 'public, max-age=604800');
      res.send(t.body);
    } catch (err) {
      console.error('card thumb failed', err?.message || err);
      res.status(404).end();
    }
  });

  /** Markdown notes / tables the bot writes for itself are not gallery items. */
  function isMeta(f) {
    return /\.md$/i.test(f.name || '') || f.mimeType === 'text/markdown';
  }
  function publicFile(f, idx) {
    return {
      id: f.id, name: f.name, day: f.day, mimeType: f.mimeType, size: f.size,
      webViewLink: f.webViewLink, hasThumb: Boolean(f.hasThumb),
      caption: idx?.caption || '', tags: idx?.tags || [],
    };
  }
  function publicLink(l) {
    return { id: 'link:' + l.id, name: l.title || l.url, day: l.day, mimeType: 'text/uri-list', host: l.host, webViewLink: l.url, hasThumb: false, caption: l.caption || '', tags: l.tags || [], isLink: true };
  }
  function publicOpp(o) {
    return { id: o.id, title: o.title, kind: KIND_THAI[o.kind] || o.kind, deadline: o.deadline, when: describeDeadline(o.deadline, timeZone), link: o.link || o.source?.webViewLink || '' };
  }
}

function expiredPage() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ลิงก์หมดอายุ</title>
<body style="font-family:system-ui;background:#F4EFE4;color:#3B3B3B;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px">
<div><div style="font-size:40px">⏳</div><h2 style="margin:8px 0">ลิงก์หมดอายุแล้ว</h2><p>กดเมนู <b>ไฟล์/รูป</b> ในแชทเพื่อขอลิงก์ใหม่</p></div></body>`;
}

export function galleryPage({ botName }) {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(botName)} Gallery</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bai+Jamjuree:wght@400;500;600;700&display=swap">
<style>
  :root { --ground:#F4EFE4; --card:#FBF8F1; --ink:#3B3B3B; --muted:#8A8A8A; --olive:#8B9270; --olive-deep:#6F7658; --stroke:#3B3B3B; --red:#B5482F; --line:#E4DCC8; }
  * { box-sizing:border-box; }
  html, body { margin:0; background:var(--ground); color:var(--ink); font-family:'Bai Jamjuree', system-ui, sans-serif; }
  body { padding: 14px 14px calc(24px + env(safe-area-inset-bottom)); max-width: 720px; margin: 0 auto; }
  header { display:flex; align-items:center; gap:10px; margin-bottom: 12px; }
  header h1 { font-size: 22px; margin:0; font-weight:700; }
  header h1 span { color: var(--olive-deep); }
  .search { display:flex; gap:8px; margin-bottom: 14px; }
  .search input { flex:1; min-width: 0; font: inherit; font-size:16px; padding: 10px 14px; border: 2px solid var(--stroke); border-radius: 14px; background: var(--card); color: var(--ink); outline: none; }
  .search input:focus { box-shadow: 0 0 0 3px rgba(139,146,112,.35); }
  .search button { font: inherit; font-weight:600; padding: 10px 14px; border: 2px solid var(--stroke); border-radius: 14px; background: var(--olive); color:#fff; cursor:pointer; }
  .cal { background: var(--card); border: 3px solid var(--stroke); border-radius: 20px; padding: 12px; box-shadow: 0 6px 0 var(--stroke); }
  .nav { display:flex; align-items:center; justify-content:space-between; margin-bottom: 8px; }
  .nav button { font: inherit; width: 40px; height: 36px; border: 2px solid var(--stroke); border-radius: 12px; background: var(--card); cursor:pointer; font-weight:700; color: var(--ink); }
  .nav .m { font-weight: 700; font-size: 18px; }
  .dow, .grid { display:grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
  .dow div { text-align:center; font-size: 12px; color: var(--muted); font-weight: 600; padding-bottom: 4px; }
  .day { position:relative; min-width: 0; aspect-ratio: 1; border-radius: 12px; border: 2px solid transparent; display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer; background: transparent; font: inherit; color: var(--ink); padding: 0; }
  .day.has { background: #EEE8D8; border-color: var(--line); }
  .day.sel { border-color: var(--stroke); background: var(--olive); color: #fff; }
  .day.today .n { text-decoration: underline; text-underline-offset: 3px; }
  .day.other { opacity: .35; }
  .day .n { font-weight: 600; font-size: 15px; line-height: 1; }
  .day .c { font-size: 11px; line-height: 1; margin-top: 4px; color: var(--olive-deep); font-weight: 600; }
  .day.sel .c { color: #fff; }
  .day .dl { position:absolute; top: 5px; right: 6px; width: 7px; height: 7px; border-radius: 50%; background: var(--red); }
  h2 { font-size: 15px; letter-spacing: .04em; text-transform: uppercase; color: var(--olive-deep); margin: 18px 0 8px; font-weight: 700; }
  .files { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  @media (min-width: 560px) { .files { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  .file { display:block; min-width: 0; text-decoration:none; color: inherit; background: var(--card); border: 2px solid var(--stroke); border-radius: 14px; overflow:hidden; }
  .file .th { aspect-ratio: 1; background: #E9E2D2; display:grid; place-items:center; font-size: 34px; overflow:hidden; }
  .file .th .ic { width: 44%; height: auto; }
  .file .th img { width:100%; height:100%; object-fit: cover; display:block; }
  .file .cap { padding: 6px 8px 8px; font-size: 12px; line-height: 1.3; }
  .file .cap b { display:block; font-weight: 600; white-space: nowrap; overflow:hidden; text-overflow: ellipsis; }
  .file .cap span { color: var(--muted); font-size: 11px; }
  .dls { display:flex; flex-direction:column; gap: 6px; }
  .dl-item { display:flex; justify-content:space-between; gap: 10px; align-items:center; background: var(--card); border: 2px solid var(--stroke); border-radius: 12px; padding: 8px 12px; text-decoration:none; color: inherit; }
  .dl-item .w { color: var(--red); font-weight: 600; font-size: 13px; white-space:nowrap; }
  .empty { color: var(--muted); padding: 18px 4px; text-align:center; }
  .memo { background: var(--card); border: 2px solid var(--stroke); border-radius: 12px; padding: 8px 12px; margin-bottom: 6px; white-space: pre-wrap; font-size: 14px; }
  .muted { color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
  <header><h1>${escapeHtml(botName)} <span>Gallery</span></h1></header>
  <form class="search" id="search"><input id="q" type="search" placeholder="ค้นหา เช่น ใบเสร็จ, slip, bookbank, ทุน" autocomplete="off"><button type="submit">หา</button></form>
  <div class="cal">
    <div class="nav"><button type="button" id="prev" aria-label="เดือนก่อน">‹</button><div class="m" id="mlabel"></div><button type="button" id="next" aria-label="เดือนถัดไป">›</button></div>
    <div class="dow"><div>อา</div><div>จ</div><div>อ</div><div>พ</div><div>พฤ</div><div>ศ</div><div>ส</div></div>
    <div class="grid" id="grid"></div>
  </div>
  <div id="panel"></div>
<script>
  const T = new URLSearchParams(location.search).get('t') || '';
  const TZ_TODAY = new Date().toLocaleDateString('en-CA', { timeZone: '${escapeJs(timeZoneOf())}' });
  const THAI_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  let month = TZ_TODAY.slice(0, 7);
  let data = { counts: {}, files: [], deadlines: [] };
  let selected = TZ_TODAY;
  const $ = (id) => document.getElementById(id);
  const api = (path, params) => fetch(path + '?' + new URLSearchParams({ t: T, ...params })).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const iconName = (f) => f.isLink ? 'link' : f.mimeType?.startsWith('image/') ? 'gallery' : f.mimeType?.startsWith('video/') ? 'video' : f.mimeType?.startsWith('audio/') ? 'audio' : f.mimeType === 'application/pdf' ? 'pdf' : /\.md$/.test(f.name || '') ? 'note' : 'clip';
  const icon = (f) => { const i = document.createElement('img'); i.className = 'ic'; i.alt = ''; i.src = '/static/icons/' + iconName(f) + '.png'; return i; };
  const size = (b) => !b ? '' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';

  async function loadMonth() {
    const [y, m] = month.split('-').map(Number);
    $('mlabel').textContent = THAI_MONTHS[m - 1] + ' ' + (y + 543);
    $('grid').innerHTML = '';
    try { data = await api('/api/gallery/month', { m: month }); } catch (e) { if (String(e.message) === '401') { location.reload(); return; } data = { counts: {}, files: [], deadlines: [] }; }
    renderGrid();
    if (!selected.startsWith(month)) selected = null;
    renderDay();
  }
  function renderGrid() {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const start = first.getUTCDay();
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const dlDays = new Set(data.deadlines.map((d) => d.deadline));
    const grid = $('grid');
    for (let i = 0; i < start; i++) grid.appendChild(Object.assign(document.createElement('div'), { className: 'day other' }));
    for (let d = 1; d <= days; d++) {
      const iso = month + '-' + String(d).padStart(2, '0');
      const c = data.counts[iso] || 0;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'day' + (c ? ' has' : '') + (iso === selected ? ' sel' : '') + (iso === TZ_TODAY ? ' today' : '');
      b.innerHTML = '<span class="n">' + d + '</span>' + (c ? '<span class="c">' + c + '</span>' : '') + (dlDays.has(iso) ? '<span class="dl"></span>' : '');
      b.addEventListener('click', () => { selected = iso; renderGrid2(); renderDay(); });
      grid.appendChild(b);
    }
  }
  function renderGrid2() { $('grid').innerHTML = ''; renderGrid(); }
  function fileCard(f) {
    const a = document.createElement('a');
    a.className = 'file'; a.href = f.webViewLink; a.target = '_blank'; a.rel = 'noopener';
    const th = document.createElement('div'); th.className = 'th';
    if (f.hasThumb) { const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.src = '/api/gallery/thumb/' + encodeURIComponent(f.id) + '?t=' + encodeURIComponent(T) + '&s=400'; img.onerror = () => { th.replaceChildren(icon(f)); }; th.appendChild(img); }
    else th.appendChild(icon(f));
    const cap = document.createElement('div'); cap.className = 'cap';
    const b = document.createElement('b'); b.textContent = f.caption || f.name; cap.appendChild(b);
    const s = document.createElement('span'); s.textContent = [f.day, f.host || size(f.size)].filter(Boolean).join(' · '); cap.appendChild(s);
    a.appendChild(th); a.appendChild(cap);
    return a;
  }
  function renderDay() {
    const p = $('panel'); p.innerHTML = '';
    const dls = data.deadlines.filter((d) => !selected || d.deadline === selected);
    if (selected) {
      const [y, m, d] = selected.split('-').map(Number);
      const h = document.createElement('h2'); h.textContent = d + ' ' + THAI_MONTHS[m - 1] + ' ' + (y + 543); p.appendChild(h);
    } else {
      const h = document.createElement('h2'); h.textContent = 'ทั้งเดือน'; p.appendChild(h);
    }
    if (dls.length) {
      const wrap = document.createElement('div'); wrap.className = 'dls';
      for (const o of dls) { const a = document.createElement('a'); a.className = 'dl-item'; a.href = o.link || '#'; if (o.link) { a.target = '_blank'; a.rel = 'noopener'; } a.innerHTML = '<span>⏳ <b></b> <span class="muted"></span></span><span class="w"></span>'; a.querySelector('b').textContent = o.title; a.querySelector('.muted').textContent = o.kind; a.querySelector('.w').textContent = o.when; wrap.appendChild(a); }
      p.appendChild(wrap);
    }
    const files = data.files.filter((f) => !selected || f.day === selected).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.name < b.name ? 1 : -1));
    if (!files.length && !dls.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'ไม่มีอะไรในวันนี้'; p.appendChild(e); return; }
    if (files.length) { const g = document.createElement('div'); g.className = 'files'; files.forEach((f) => g.appendChild(fileCard(f))); p.appendChild(g); }
  }
  async function search(q) {
    const p = $('panel'); p.innerHTML = '<div class="empty">กำลังหา…</div>';
    let r; try { r = await api('/api/gallery/search', { q }); } catch { p.innerHTML = '<div class="empty">หาไม่ได้ ลองใหม่</div>'; return; }
    p.innerHTML = '';
    const h = document.createElement('h2'); h.textContent = 'ผลการค้นหา "' + q + '"'; p.appendChild(h);
    if (r.opportunities.length) { const wrap = document.createElement('div'); wrap.className = 'dls'; r.opportunities.forEach((o) => { const a = document.createElement('a'); a.className = 'dl-item'; a.href = o.link || '#'; a.innerHTML = '<span>⏳ <b></b> <span class="muted"></span></span><span class="w"></span>'; a.querySelector('b').textContent = o.title; a.querySelector('.muted').textContent = o.kind; a.querySelector('.w').textContent = o.when; wrap.appendChild(a); }); p.appendChild(wrap); }
    if (r.memories.length) { r.memories.forEach((m) => { const d = document.createElement('div'); d.className = 'memo'; d.textContent = '🧠 ' + m.text; p.appendChild(d); }); }
    if (r.files.length) { const g = document.createElement('div'); g.className = 'files'; r.files.forEach((f) => g.appendChild(fileCard(f))); p.appendChild(g); }
    if (!r.files.length && !r.opportunities.length && !r.memories.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'ไม่เจอเลย ลองคำอื่นดูนะ'; p.appendChild(e); }
  }
  $('prev').addEventListener('click', () => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); month = d.toISOString().slice(0, 7); loadMonth(); });
  $('next').addEventListener('click', () => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); month = d.toISOString().slice(0, 7); loadMonth(); });
  $('search').addEventListener('submit', (e) => { e.preventDefault(); const q = $('q').value.trim(); if (q) search(q); else renderDay(); });
  loadMonth();
</script>
</body>
</html>`;
}

let _tz = 'Asia/Bangkok';
export function setGalleryTimeZone(tz) { _tz = tz; }
function timeZoneOf() { return _tz; }

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeJs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
