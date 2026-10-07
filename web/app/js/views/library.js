// คลัง: files/photos, links and remembered facts, for the person's own Drive
// or a group they belong to (checked on the server). Search is debounced and
// a newer query cancels the older one, so late results never overwrite.

import { h, clear, glyph, icon, uid } from '../dom.js';
import { api, ApiError } from '../api.js';
import { formatDay, formatDateTime } from '../../../shared/dates.js';
import { fileKindName, fileIconName } from '../model.js';
import { topBar, emptyState, errorState, banner, loader } from '../ui.js';
import { createMotion } from '../motion.js';

const PAGE = 60;

export function renderLibrary(app, route) {
  const T = app.T;
  const contexts = app.session?.contexts || [{ id: 'me', type: 'user' }];
  let ctx = route.query.get('ctx') || 'me';
  if (!contexts.some((c) => c.id === ctx)) ctx = 'me';
  let tab = ['files', 'links', 'memory'].includes(route.query.get('tab')) ? route.query.get('tab') : 'files';
  let view = route.query.get('view') === 'gallery' ? 'gallery' : 'list';
  let q = route.query.get('q') || '';
  let offset = 0;
  let ctrl = null;
  let motion = null;
  let seq = 0;
  let timer = null;
  let destroyed = false;

  const el = h('div', { class: 'stack', style: { gap: '14px' } });
  el.append(topBar(app, T('libTitle')));

  if (contexts.length > 1) {
    const seg = h('div', { class: contexts.length > 3 ? 'chips' : 'seg', role: 'radiogroup', 'aria-label': T('libCtx') });
    for (const c of contexts) {
      const label = c.id === 'me' ? T('mine') : c.name;
      const ic = c.id === 'me' ? glyph('me', { size: 18 }) : icon('group');
      seg.append(h('button', {
        type: 'button', role: 'radio', class: contexts.length > 3 ? 'chip' : (ctx === c.id ? 'on' : ''), 'aria-checked': String(ctx === c.id),
        onclick: () => { ctx = c.id; app.setQuery({ ctx: c.id === 'me' ? null : c.id }); offset = 0; repaintSeg(); load(); },
      }, ic, h('span', null, label)));
    }
    const repaintSeg = () => seg.querySelectorAll('button').forEach((b, i) => {
      const on = contexts[i].id === ctx;
      b.setAttribute('aria-checked', String(on));
      if (!b.classList.contains('chip')) b.className = on ? 'on' : '';
    });
    el.append(seg);
  }
  const ownerLine = h('p', { class: 'sm muted', style: { overflowWrap: 'anywhere' } });
  const aiSlot = h('div');
  const searchId = uid('lib-q');
  const search = h('input', { id: searchId, class: 'inp', type: 'search', placeholder: T('searchPh'), value: q, autocomplete: 'off' });
  const tabs = h('div', { class: 'chips', role: 'tablist', 'aria-label': T('libTitle') });
  const viewSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': T('vGal') });
  const status = h('p', { class: 'sm', role: 'status' });
  const results = h('div', { class: 'stack', style: { gap: '12px' } });
  el.append(ownerLine, aiSlot, h('div', { class: 'search' }, h('label', { for: searchId, class: 'sr' }, T('search')), icon('search', { size: 22 }), search), tabs, viewSeg, status, results);

  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { q = search.value.trim(); app.setQuery({ q: q || null }); offset = 0; load({ searching: true }); }, 350);
  });

  let counts = { files: null, links: null, memory: null };
  function paintTabs() {
    clear(tabs);
    for (const [k, label] of [['files', 'filesTab'], ['links', 'linksTab'], ['memory', 'memTab']]) {
      tabs.append(h('button', {
        type: 'button', role: 'tab', class: 'chip', 'aria-selected': String(tab === k),
        onclick: () => { tab = k; app.setQuery({ tab: k === 'files' ? null : k }); offset = 0; paintTabs(); load(); },
      }, T(label), ' ', h('span', { class: 'n' }, counts[k] === null ? '–' : String(counts[k]))));
    }
    clear(viewSeg);
    viewSeg.hidden = tab !== 'files';
    for (const [k, label] of [['list', 'vList'], ['gallery', 'vGal']]) {
      viewSeg.append(h('button', { type: 'button', role: 'radio', class: view === k ? 'on' : '', 'aria-checked': String(view === k), onclick: () => { view = k; app.setQuery({ view: k === 'list' ? null : k }); paintTabs(); load(); } }, h('span', null, T(label))));
    }
  }

  function stop() {
    ctrl?.abort();
    motion?.destroy();
    motion = null;
  }

  async function load({ searching = false, more = false } = {}) {
    if (destroyed) return;
    stop();
    const my = ++seq;
    ctrl = new AbortController();
    if (!more) {
      clear(results);
      status.textContent = '';
      motion = createMotion({ T, kind: searching || q ? 'searching' : 'loading' });
      results.append(motion.el);
      motion.start();
    }
    try {
      const data = await api.get('/library', { query: { ctx, tab, q, offset, limit: PAGE }, signal: ctrl.signal });
      if (destroyed || my !== seq) return; // a newer query took over
      motion?.destroy();
      motion = null;
      counts = data.counts;
      paintTabs();
      ownerLine.textContent = data.owner.kind === 'group'
        ? T('ownerGroup', { host: data.owner.host || '—', root: data.owner.root, name: data.owner.name })
        : T('ownerMine', { email: data.owner.email || '—', root: data.owner.root });
      clear(aiSlot);
      if (data.aiLimited) aiSlot.append(banner('warn', { iconSrc: '/static/icons/ai.png', title: T('aiBusyH'), body: T('aiBusyB') }));
      if (!more) clear(results);
      status.textContent = q ? (data.total === 1 ? T('result1', { q }) : T('results', { n: data.total, q })) : '';
      if (!data.total) {
        results.append(emptyState({ title: q ? T('noMatch') : T('libEmpty'), ex: q ? null : tab === 'memory' ? T('memEmptyEx') : T('libEmptyEx') }));
        return;
      }
      const box = tab === 'files' && view === 'gallery' ? h('div', { class: 'gal' }) : h('div', { class: 'stack', style: { gap: '12px' } });
      for (const x of data.items) box.append(tab === 'files' ? (view === 'gallery' ? galleryCell(x) : fileRow(x)) : tab === 'links' ? linkRow(x) : memoryRow(x));
      results.querySelector('.more-btn')?.remove();
      results.append(box);
      if (data.offset + data.items.length < data.total) {
        results.append(h('button', { class: 'btn more-btn', type: 'button', onclick: () => { offset = data.offset + data.items.length; load({ more: true }); } }, T('showMore')));
      }
    } catch (err) {
      if (destroyed || my !== seq) return;
      if (err instanceof ApiError && err.kind === 'aborted') return;
      motion?.destroy();
      motion = null;
      if (err instanceof ApiError && err.status === 401) return;
      clear(results);
      results.append(errorState(app, err, { retry: () => load() }));
    }
  }

  const ctxQ = () => (ctx === 'me' ? '' : `?ctx=${encodeURIComponent(ctx)}`);

  function fileRow(x) {
    const thumb = x.thumb ? h('img', { class: 'ib', src: x.thumb, alt: '', loading: 'lazy' }) : icon(fileIconName(x.kind), { size: 28, cls: 'is' });
    return h('div', { class: 'it' },
      h('div', { class: 'th' }, thumb),
      h('div', null,
        h('a', { class: 'nm', href: `#/file/${encodeURIComponent(x.id)}${ctxQ()}` }, x.name),
        h('p', { class: 'xs muted' }, `${fileKindName(x.kind, T)}${x.day ? ` · ${T('savedAt', { date: formatDay(x.day, app.lang, 'dm') })}` : ''}`),
        x.caption ? h('p', { class: 'xs', style: { overflowWrap: 'anywhere' } }, x.caption) : null),
      x.webViewLink ? h('div', { style: { gridColumn: '2' } }, h('a', { class: 'btn sm pri', href: x.webViewLink, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: '/app/img/open.svg', alt: '', width: 18, height: 18 }), T('openDrive'))) : null);
  }

  function galleryCell(x) {
    return h('a', { class: 'gc', href: `#/file/${encodeURIComponent(x.id)}${ctxQ()}`, style: { textDecoration: 'none' } },
      h('div', { class: 'ph' }, x.thumb ? h('img', { src: x.thumb, alt: '', loading: 'lazy' }) : icon(fileIconName(x.kind), { size: 40, cls: 'is' })),
      h('span', null, x.caption || x.name), h('span', { class: 'xs muted' }, x.day ? formatDay(x.day, app.lang, 'dm') : ''));
  }

  function linkRow(x) {
    return h('div', { class: 'it' },
      h('div', { class: 'th' }, icon('link', { size: 28, cls: 'is' })),
      h('div', null,
        h('a', { class: 'nm', href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.title),
        h('p', { class: 'xs muted', style: { overflowWrap: 'anywhere' } }, `${x.host}${x.day ? ` · ${T('savedAt', { date: formatDay(x.day, app.lang, 'dm') })}` : ''}`)),
      h('div', { style: { gridColumn: '2' } }, h('a', { class: 'btn sm pri', href: x.url, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: '/app/img/open.svg', alt: '', width: 18, height: 18 }), T('openL'))));
  }

  function memoryRow(x) {
    const forget = h('button', { class: 'btn sm dan', type: 'button', 'aria-haspopup': 'dialog' }, T('forget'));
    const row = h('div', { class: 'it' },
      h('div', { class: 'th' }, icon('note', { size: 28, cls: 'is' })),
      h('div', null, h('p', { class: 'nm plain', style: { whiteSpace: 'pre-wrap' } }, x.text), h('p', { class: 'xs muted' }, x.createdAt ? T('rememberedAt', { when: formatDateTime(x.createdAt, app.lang, app.tz) }) : '')),
      h('div', { style: { gridColumn: '2' } }, forget));
    forget.addEventListener('click', async () => {
      const short = x.text.length > 40 ? `${x.text.slice(0, 40)}…` : x.text;
      const ok = await app.confirm({ title: T('forgetTitle', { text: short }), body: T('forgetBody'), no: T('cancelL'), yes: T('forget'), danger: true, run: () => api.del(`/memories/${encodeURIComponent(x.id)}`, { query: { ctx } }) });
      if (ok) { app.toast(T('tForgot')); load(); }
    });
    return row;
  }

  paintTabs();
  load();
  return { el, destroy() { destroyed = true; clearTimeout(timer); stop(); } };
}

export function renderFile(app, route) {
  const T = app.T;
  const id = route.parts[0];
  const ctx = route.query.get('ctx') || 'me';
  const el = h('div', { class: 'stack', style: { gap: '14px' } });
  el.append(topBar(app, T('filesTab'), { back: `library${ctx === 'me' ? '' : `?ctx=${encodeURIComponent(ctx)}`}` }));
  const l = loader(app, {
    fetch: (signal) => api.get(`/files/${encodeURIComponent(id)}`, { query: { ctx }, signal }),
    render: ({ file: f, owner }) => {
      const where = owner.kind === 'group'
        ? `${owner.host || '—'} › My Drive › ${owner.root} › Groups › ${owner.name}${f.day ? ` › ${f.day}` : ''}`
        : `${owner.email || '—'} › My Drive › ${owner.root}${f.day ? ` › ${f.day}` : ''}`;
      const kv = h('dl', { class: 'kv' },
        h('dt', null, T('where')), h('dd', { class: 'sm' }, where),
        h('dt', null, T('savedOnL')), h('dd', null, f.day ? formatDay(f.day, app.lang) : T('notGiven')),
        h('dt', null, T('kindFile')), h('dd', null, fileKindName(f.kind, T)),
        h('dt', null, T('caption')), h('dd', { class: f.caption ? '' : 'muted' }, f.caption || T('noCap')));
      if (f.tags?.length) kv.append(h('dt', null, T('tags')), h('dd', null, f.tags.join(', ')));
      return h('div', { class: 'stack', style: { gap: '14px' } },
        f.thumb ? h('img', { class: 'hero', src: f.thumb.replace(/z=\d+/, 'z=900'), alt: '' }) : h('div', { class: 'hero', style: { display: 'flex', alignItems: 'center', justifyContent: 'center' } }, icon(fileIconName(f.kind), { size: 64 })),
        h('h2', { style: { overflowWrap: 'anywhere', wordBreak: 'break-word' } }, f.name),
        f.webViewLink ? h('a', { class: 'btn pri', href: f.webViewLink, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: '/app/img/open.svg', alt: '', width: 18, height: 18 }), T('openDrive')) : null,
        kv);
    },
    skeletons: 2,
  });
  el.append(l.el);
  l.run();
  return { el, destroy: () => l.destroy() };
}
