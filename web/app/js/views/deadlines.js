// Deadlines: list with status filters and search, detail with the exact
// closing date, event dates kept apart, applied / resume, per-item alerts,
// merge explanation and split, delete with undo; and the chat-wide alert
// schedule. Date-only items say "ไม่ระบุเวลา"; no closing time is invented.

import { h, clear, glyph, icon, uid } from '../dom.js';
import { api, ApiError } from '../api.js';
import { formatDay, formatTime, formatDateTime, addDays } from '../../../shared/dates.js';
import {
  deadlineTone, bucket, countdown, noteText, kindName, sourceName, sortDeadlines, alertChip, offsetLabel,
} from '../model.js';
import { topBar, loader, emptyState, stubEl, countdownEl, banner, errorState } from '../ui.js';
import { createMotion } from '../motion.js';

const PRESETS = [
  ['std', [7, 3, 1, 0]],
  ['early', [14, 7, 3, 1, 0]],
  ['light', [3, 1, 0]],
];

// ------------------------------------------------------------------ list

export function renderDeadlines(app, route) {
  const T = app.T;
  let filter = route.query.get('f') || 'open';
  let q = route.query.get('q') || '';
  const el = h('div', { class: 'stack', style: { gap: '12px' } });
  el.append(topBar(app, T('dlTitle')));
  const l = loader(app, {
    fetch: (signal) => api.get('/deadlines', { signal }),
    render: (data) => listBody(app, data, { filter, q, onFilter: (f) => { filter = f; app.setQuery({ f: f === 'open' ? null : f }); }, onQuery: (v) => { q = v; app.setQuery({ q: v || null }); }, reload: () => l.run({ quiet: true }) }),
  });
  el.append(l.el);
  l.run();
  return { el, destroy: () => l.destroy() };
}

function listBody(app, data, { filter, q, onFilter, onQuery, reload }) {
  const T = app.T;
  const wrap = h('div', { class: 'stack', style: { gap: '12px' } });
  wrap.append(h('a', { class: 'btn sm', href: '#/deadline-alerts', style: { justifyContent: 'flex-start' } }, icon('bell'), alertChip(data.alerts, app.lang, T)));
  const searchId = uid('dl-q');
  const search = h('input', { id: searchId, class: 'inp', type: 'search', placeholder: T('dlSearchPh'), value: q, autocomplete: 'off' });
  wrap.append(h('div', { class: 'search' }, h('label', { for: searchId, class: 'sr' }, T('dlSearch')), icon('search', { size: 22 }), search));
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': T('dlTitle') });
  const list = h('div', { class: 'stack', style: { gap: '12px' } });
  const status = h('p', { class: 'sm', role: 'status' });
  wrap.append(chips, status, list);

  const matches = (o) => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = [o.title, o.organizer, kindName(o.kind, T), o.summary].join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  };

  function paint() {
    const items = data.items.filter(matches);
    const counts = { open: 0, applied: 0, closed: 0, all: items.length };
    for (const o of items) counts[bucket(o)]++;
    clear(chips);
    for (const [key, label] of [['open', 'fOpen'], ['applied', 'fApplied'], ['closed', 'fClosed'], ['all', 'fAll']]) {
      chips.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(filter === key), onclick: () => { filter = key; onFilter(key); paint(); } }, T(label), ' ', h('span', { class: 'n' }, String(counts[key]))));
    }
    clear(list);
    const shown = sortDeadlines(items.filter((o) => filter === 'all' || bucket(o) === filter));
    status.textContent = q ? (shown.length === 1 ? T('result1', { q }) : T('results', { n: shown.length, q })) : '';
    if (!shown.length) list.append(emptyState({ title: q ? T('noMatch') : T('dlEmptyTitle'), ex: q ? null : T('dlEmptyEx') }));
    for (const o of shown) list.append(dlCard(app, o, { reload }));
  }
  let timer = null;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); onQuery(q); paint(); }, 200); });
  paint();
  return wrap;
}

function dlCard(app, o, { reload }) {
  const T = app.T;
  const b = bucket(o);
  const tone = o.status === 'applied' ? 'later' : deadlineTone(o);
  const href = `#/deadline/${encodeURIComponent(o.id)}`;
  const close = o.deadline ? `${T('closesOn', { date: formatDay(o.deadline, app.lang) })} · ` : '';
  const more = h('button', { class: 'btn ico more', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': T('moreFor', { title: o.title }) }, glyph('more'));
  more.addEventListener('click', () => overflow(app, o, { reload }));
  const open = o.link && b === 'open';
  return h('article', { class: `card${b !== 'open' ? ' flat' : ''}` },
    h('div', { class: 'dlc' },
      stubEl(o, app),
      h('a', { class: 'rowb', href, style: { textDecoration: 'none' } },
        h('span', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'tag' }, kindName(o.kind, T)), o.sourceCount > 1 ? h('span', { class: 'tag plain' }, T('mergedTag', { n: o.sourceCount })) : null),
        h('span', { class: 'ttl', title: o.title }, o.title),
        countdownEl(o, tone, countdown(o, T)),
        h('span', { class: 'sm' }, o.deadline ? [close, h('span', { class: o.deadlineNote ? '' : 'muted', style: { whiteSpace: 'nowrap' } }, noteText(o, T))] : h('span', { class: 'muted' }, T('sendDate')))),
      more),
    h('div', { class: 'row' }, open
      ? h('a', { class: 'btn sm pri', href: o.link, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: '/app/img/open.svg', alt: '', width: 18, height: 18 }), T('openLink'))
      : h('a', { class: 'btn sm', href }, T('view'))));
}

/** The ⋯ sheet: extra actions stay off the compact card. */
function overflow(app, o, { reload }) {
  const T = app.T;
  app.sheet((close) => h('div', { class: 'stack' },
    o.status === 'applied'
      ? h('button', { class: 'btn', type: 'button', onclick: async () => { close(); await act(app, () => api.post(`/deadlines/${o.id}/applied`, { applied: false }), T('tResumed')); reload(); } }, T('resume'))
      : bucket(o) === 'open' ? h('button', { class: 'btn', type: 'button', onclick: async () => { close(); await act(app, () => api.post(`/deadlines/${o.id}/applied`, { applied: true }), T('tApplied')); reload(); } }, T('apply')) : null,
    bucket(o) !== 'closed' && o.status !== 'applied' ? h('a', { class: 'btn', href: `#/deadline/${encodeURIComponent(o.id)}?alerts=1`, onclick: () => close() }, icon('bell'), T('itemAlertsTitle')) : null,
    h('a', { class: 'btn', href: `#/deadline/${encodeURIComponent(o.id)}`, onclick: () => close() }, T('details')),
    h('button', { class: 'btn dan', type: 'button', onclick: async () => { close(); await deleteWithUndo(app, o, { after: reload }); } }, icon('trash'), T('del'))), { title: o.title });
}

async function act(app, fn, okText) {
  try {
    const r = await fn();
    if (okText) app.toast(okText);
    return r;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) app.toast(app.T('gone'));
    else app.toast(err instanceof ApiError && err.isNetwork ? app.T('tOpFailNet') : app.T('tOpFail'));
    return null;
  }
}

async function deleteWithUndo(app, o, { after } = {}) {
  const T = app.T;
  const r = await act(app, () => api.del(`/deadlines/${o.id}`));
  if (!r) return;
  after?.();
  app.toast(T('tDeleted'), {
    actionLabel: T('undo'),
    action: async () => {
      try {
        await api.post(`/deadlines/${o.id}/restore`);
        app.toast(T('tRestored'));
        after?.();
      } catch (err) {
        app.toast(err instanceof ApiError && err.status === 410 ? T('tRestoreFail') : T('tOpFail'));
      }
    },
  });
}

// ---------------------------------------------------------------- detail

export function renderDeadline(app, route) {
  const T = app.T;
  const id = route.parts[0];
  const el = h('div', { class: 'stack', style: { gap: '16px' } });
  el.append(topBar(app, T('details'), { back: 'deadlines' }));
  const l = loader(app, {
    fetch: (signal) => api.get(`/deadlines/${encodeURIComponent(id)}`, { signal }),
    render: (data) => detailBody(app, data, { reload: () => l.run({ quiet: true }), openAlerts: route.query.get('alerts') === '1' }),
    skeletons: 2,
  });
  el.append(l.el);
  l.run();
  return { el, destroy: () => l.destroy() };
}

function detailBody(app, data, { reload, openAlerts }) {
  const T = app.T;
  const lang = app.lang;
  const o = data.item;
  const tone = o.status === 'applied' ? 'later' : deadlineTone(o);
  const b = bucket(o);
  const wrap = h('article', { class: 'stack', style: { gap: '16px' }, 'aria-labelledby': 'dl-title' });

  wrap.append(h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '12px', flexWrap: 'nowrap' } },
    stubEl(o, app),
    h('div', { class: 'grow stack', style: { gap: '2px' } }, h('span', null, h('span', { class: 'tag' }, kindName(o.kind, T))),
      h('h2', { id: 'dl-title', style: { fontSize: '21px', lineHeight: '1.4', overflowWrap: 'anywhere' } }, o.title),
      o.organizer ? h('p', { class: 'sm muted' }, o.organizer) : null)));

  wrap.append(h('section', { class: 'card', 'aria-label': T('closing') },
    h('p', { class: 'sm muted' }, T('closing')),
    h('p', { style: { fontSize: '21px', fontWeight: '700', lineHeight: '1.35' } }, o.deadline ? formatDay(o.deadline, lang) : T('notGiven')),
    h('p', null, o.deadline ? noteText(o, T) : T('noDateFound')),
    countdownEl(o, tone, countdown(o, T)),
    o.eventDates ? h('p', { class: 'sm' }, `${T('eventDates')}: `, h('b', null, o.eventDates), ' ', h('span', { class: 'muted' }, `(${T('notClosing')})`)) : null));

  const actions = h('div', { class: 'row' });
  const applyBtn = (applied) => {
    const btn = h('button', { class: 'btn pri', type: 'button' }, applied ? T('apply') : T('resume'));
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = T('saving');
      const r = await act(app, () => api.post(`/deadlines/${o.id}/applied`, { applied }));
      if (r) {
        app.toast(applied ? T('tApplied') : T('tResumed'), applied ? { actionLabel: T('resume'), action: async () => { await act(app, () => api.post(`/deadlines/${o.id}/applied`, { applied: false }), T('tResumed')); reload(); } } : {});
        reload();
      } else {
        btn.disabled = false;
        btn.textContent = applied ? T('apply') : T('resume');
      }
    });
    return btn;
  };
  if (o.status === 'applied') {
    wrap.append(banner('ok', { iconSrc: '/static/icons/check.png', title: T('appliedState'), body: o.appliedAt ? T('appliedAt', { when: formatDateTime(o.appliedAt, lang, app.tz) }) : '' }));
    actions.append(applyBtn(false));
  } else if (b === 'open') {
    actions.append(applyBtn(true));
  }
  if (o.link) actions.append(h('a', { class: 'btn', href: o.link, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: '/app/img/open.svg', alt: '', width: 18, height: 18 }), T('openLink')));
  if (actions.childNodes.length) wrap.append(actions);

  // Alerts for this item, past ones listed as past.
  const al = data.alerts;
  const modeLabel = { stopped: T('alertStopped'), own: T('alertOwn'), off: T('alertOffItem'), default: T('alertUseDefault') }[al.mode];
  const alerts = h('section', { class: 'stack', 'aria-labelledby': 'dl-alerts' },
    h('h3', { id: 'dl-alerts', class: 'row', style: { gap: '6px' } }, icon('bell'), T('itemAlerts'), h('span', { class: 'tag' }, modeLabel)));
  for (const a of al.schedule) {
    alerts.append(h('p', { class: `al${a.past ? ' past' : ''}` }, icon('bell'),
      h('span', null, a.past ? h('s', null, formatDateTime(a.at, lang, app.tz)) : h('b', null, formatDateTime(a.at, lang, app.tz)),
        ` · ${offsetLabel(a.offset, T)}${a.past ? ` · ${a.sent ? T('alertSent') : T('alertPast')}` : ''}`)));
  }
  if (o.status === 'applied') alerts.append(h('p', { class: 'sm' }, T('alertsStoppedApplied')));
  else if (o.deadline && al.schedule.length && al.schedule.every((a) => a.past)) alerts.append(h('p', { class: 'sm' }, h('b', null, T('alertsNone'))));
  if (o.status !== 'applied' && b !== 'closed') {
    alerts.append(h('p', { class: 'xs muted' }, `${T('alertTimeShared', { time: formatTime(al.time, lang) })} · ${T('alertBatchShort')}`));
    const change = h('button', { class: 'btn sm', type: 'button', 'aria-haspopup': 'dialog', style: { alignSelf: 'flex-start' } }, T('changeAlerts'));
    change.addEventListener('click', () => itemAlerts(app, o, al, reload));
    alerts.append(change);
    if (openAlerts) queueMicrotask(() => itemAlerts(app, o, al, reload));
  }
  wrap.append(alerts);

  // Merge explanation and split correction.
  if (o.mergeCount > 0 || o.sourceCount > 1) {
    const panel = h('section', { class: 'panel', 'aria-labelledby': 'dl-merged' },
      h('h3', { id: 'dl-merged', class: 'row', style: { gap: '6px' } }, icon('clip'), T('mergedH')),
      h('p', { class: 'xs muted' }, `${T('mergedTag', { n: Math.max(o.sourceCount, 2) })}${o.updatedAt ? ` · ${formatDateTime(o.updatedAt, lang, app.tz)}` : ''}`));
    if (data.canSplit) {
      const btn = h('button', { class: 'btn sm', type: 'button', 'aria-haspopup': 'dialog', style: { alignSelf: 'flex-start' } }, T('splitAsk'));
      btn.addEventListener('click', async () => {
        let created = null;
        const ok = await app.confirm({
          title: T('splitTitle'), body: T('splitBody'), no: T('cancelL'), yes: T('splitYes'),
          run: async () => { created = (await api.post(`/deadlines/${o.id}/split`)).created; },
        });
        if (ok && created) {
          app.toast(T('tSplit'), { actionLabel: T('tSplitView'), action: () => app.go(`deadline/${created.id}`) });
          reload();
        }
      });
      panel.append(btn);
    } else {
      panel.append(h('p', { class: 'xs muted' }, T('splitOnlyLatest')));
    }
    wrap.append(panel);
  }

  // Details; missing values say "ไม่ระบุ".
  const kv = h('dl', { class: 'kv' });
  const row = (k, v) => kv.append(h('dt', null, k), h('dd', { class: v ? '' : 'muted' }, v || T('notGiven')));
  row(T('kindL'), kindName(o.kind, T));
  row(T('organizer'), o.organizer);
  row(T('summaryL'), o.summary);
  row(T('elig'), o.eligibility);
  row(T('cost'), o.cost);
  row(T('contact'), o.contact);
  const src = h('dd', { class: 'stack', style: { gap: '6px' } });
  for (const link of o.links || []) src.append(h('a', { class: 'row sm', href: link, target: '_blank', rel: 'noopener noreferrer', style: { gap: '8px', overflowWrap: 'anywhere' } }, icon('link'), h('span', { class: 'grow' }, link.replace(/^https?:\/\//, ''))));
  if (o.source?.webViewLink) src.append(h('span', { class: 'row sm', style: { gap: '8px' } }, icon(o.source.kind === 'pdf' ? 'pdf' : 'gallery'), h('span', { class: 'grow' }, sourceName(o, T)), h('a', { class: 'btn sm', href: o.source.webViewLink, target: '_blank', rel: 'noopener noreferrer' }, T('openSource'))));
  if (!src.childNodes.length) src.append(h('span', null, sourceName(o, T)));
  kv.append(h('dt', null, T('source')), src);
  if (o.updatedAt) row(T('updated'), formatDateTime(o.updatedAt, lang, app.tz));
  wrap.append(h('section', { class: 'stack' }, h('h3', null, T('details')), kv));

  const del = h('button', { class: 'btn dan', type: 'button' }, icon('trash'), T('del'));
  del.addEventListener('click', () => deleteWithUndo(app, o, { after: () => app.go('deadlines') }));
  wrap.append(h('div', { style: { borderTop: '2px dashed #CFC6B2', paddingTop: '14px' } }, del, h('p', { class: 'xs muted', style: { marginTop: '6px' } }, T('delNote'))));
  return wrap;
}

function itemAlerts(app, o, al, reload) {
  const T = app.T;
  const current = al.mode === 'own' ? (PRESETS.find(([, d]) => d.join() === al.days.join())?.[0] || 'custom') : al.mode;
  let pick = current;
  app.sheet((close) => {
    const name = uid('ia');
    const fs = h('fieldset', null, h('legend', { class: 'sr' }, T('itemAlertsTitle')));
    const opts = [['default', T('alertUseDefault'), ''], ...PRESETS.map(([k, d]) => [k, T(k), T('presetD', { days: d.filter((x) => x > 0).join(', ') })]), ['off', T('alertOffItem'), '']];
    if (current === 'custom') opts.splice(1, 0, ['custom', T('custom'), al.days.join(', ')]);
    for (const [k, label, sub] of opts) {
      const inp = h('input', { type: 'radio', name, checked: pick === k, disabled: k === 'custom' });
      inp.addEventListener('change', () => { pick = k; save.disabled = pick === current; });
      fs.append(h('label', { class: 'rc' }, inp, h('span', null, h('b', null, label), sub ? h('small', null, sub) : null)));
    }
    const err = h('p', { class: 'err-t', role: 'alert', hidden: true });
    const save = h('button', { class: 'btn pri', type: 'button', disabled: true }, T('save'));
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.textContent = T('saving');
      try {
        await api.put(`/deadlines/${o.id}/alerts`, { preset: pick });
        close(true);
        app.toast(T('saved'));
        reload();
      } catch (e) {
        save.disabled = false;
        save.textContent = T('save');
        err.hidden = false;
        err.textContent = e instanceof ApiError && e.isNetwork ? T('tOpFailNet') : T('tOpFail');
      }
    });
    return h('div', { class: 'stack' }, fs, h('p', { class: 'xs muted' }, T('alertTimeShared', { time: formatTime(al.time, app.lang) })), err, save);
  }, { title: T('itemAlertsTitle') });
}

// -------------------------------------------------------- alert settings

export function renderAlertSettings(app) {
  const T = app.T;
  const lang = app.lang;
  const el = h('div', { class: 'stack', style: { gap: '16px' } });
  let dirty = false;
  app.setGuard(() => dirty);
  el.append(topBar(app, T('alertsTitle'), { back: 'deadlines' }));
  const l = loader(app, {
    fetch: (signal) => api.get('/deadline-alerts', { signal }),
    render: (data) => form(data),
    skeletons: 2,
  });
  el.append(l.el);
  l.run();

  function form(data) {
    const base = { days: data.alerts.days.join(','), time: data.alerts.time };
    const draft = { ...base };
    const wrap = h('div', { class: 'stack', style: { gap: '16px' } });
    wrap.append(h('p', null, T('alertsIntro')));
    if (data.ownCount) wrap.append(h('p', { class: 'sm muted' }, T('alertsOwnCount', { n: data.ownCount })));

    const presets = h('fieldset', null, h('legend', { class: 'lg' }, T('howManyDays')));
    const pname = uid('pr');
    const opts = [...PRESETS.map(([k, d]) => [k, d.join(','), T(k), T('presetD', { days: d.filter((x) => x > 0).join(', ') })]), ['off', '', T('off'), T('offD')]];
    if (base.days && !opts.some((o) => o[1] === base.days)) opts.unshift(['custom', base.days, T('custom'), base.days.split(',').map(Number).filter((x) => x > 0).join(', ')]);
    for (const [, days, label, sub] of opts) {
      const inp = h('input', { type: 'radio', name: pname, checked: draft.days === days });
      inp.addEventListener('change', () => { draft.days = days; update(); });
      presets.append(h('label', { class: 'rc' }, inp, h('span', null, h('b', null, label), h('small', null, sub))));
    }
    wrap.append(presets);

    const times = h('div', { class: 'chips wrap', role: 'radiogroup', 'aria-label': T('alertTime') });
    const otherId = uid('time');
    const other = h('input', { id: otherId, class: 'inp', type: 'time', value: draft.time, style: { maxWidth: '200px' } });
    other.addEventListener('change', () => { if (/^\d{2}:\d{2}$/.test(other.value)) { draft.time = other.value; update(); } });
    wrap.append(h('fieldset', null, h('legend', { class: 'lg' }, T('alertTime')), times,
      h('div', { class: 'field' }, h('label', { for: otherId, class: 'sm' }, T('otherTime')), other)));

    const preview = h('section', { class: 'card', 'aria-live': 'polite' });
    wrap.append(preview);
    wrap.append(h('p', { class: 'sm row', style: { gap: '8px', flexWrap: 'nowrap', alignItems: 'flex-start' } }, h('img', { src: '/app/img/tone.svg', alt: '', width: 18, height: 18, style: { marginTop: '3px' } }), h('span', null, T('batchNote'))));
    wrap.append(h('p', { class: 'xs muted' }, T('alertsChatTip')));
    const err = h('p', { class: 'err-t', role: 'alert', hidden: true });
    const save = h('button', { class: 'btn pri blk big', type: 'button' });
    const hint = h('p', { class: 'xs muted', style: { textAlign: 'center' } });
    wrap.append(err, save, hint);

    function update() {
      dirty = draft.days !== base.days || draft.time !== base.time;
      clear(times);
      for (const t of ['08:00', '09:00', '12:00', '20:00']) {
        times.append(h('button', { type: 'button', role: 'radio', class: 'chip', 'aria-checked': String(draft.time === t), onclick: () => { draft.time = t; other.value = t; update(); } }, formatTime(t, lang)));
      }
      const sample = addDays(app.today(), 14);
      clear(preview);
      preview.append(h('p', { class: 'sm muted' }, T('previewTitle', { date: formatDay(sample, lang) })));
      const days = draft.days ? draft.days.split(',').map(Number) : [];
      const ul = h('ul', { class: 'sm' });
      if (!days.length) ul.append(h('li', null, T('noAlerts')));
      for (const n of days) ul.append(h('li', null, `${formatDay(addDays(sample, -n), lang)} · ${formatTime(draft.time, lang)} · ${offsetLabel(n, T)}`));
      preview.append(ul);
      save.disabled = !dirty;
      save.textContent = dirty ? T('save') : T('unchanged');
      hint.textContent = dirty ? '' : T('unchangedHint');
    }
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.textContent = T('saving');
      err.hidden = true;
      try {
        await api.put('/deadline-alerts', draft.days ? { days: draft.days.split(',').map(Number), time: draft.time } : { off: true, time: draft.time });
        dirty = false;
        app.setGuard(null);
        app.toast(T('tAlerts'));
        app.go('deadlines');
      } catch (e) {
        err.hidden = false;
        err.textContent = e instanceof ApiError && e.isNetwork ? T('tOpFailNet') : T('tOpFail');
        update();
      }
    });
    update();
    return wrap;
  }

  return { el, destroy: () => l.destroy() };
}

export { errorState, createMotion };
