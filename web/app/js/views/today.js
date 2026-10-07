// วันนี้: greeting, up next, week strip with month overlay, the selected
// day's deadlines / reminders / Calendar events / saved items, and the
// "เตือนทั้งหมด" reminder manager.

import { h, clear, glyph, icon, trapFocus } from '../dom.js';
import { api } from '../api.js';
import {
  addDays, weekStart, weekTitle, formatDay, formatTime, parseKey, makeKey, zoned, zonedToUtc, isDayKey,
} from '../../../shared/dates.js';
import { occursOn, upcoming } from '../../../shared/recurrence.js';
import {
  deadlineTone, countdown, noteText, repeatShort, repeatSummary, nextLine, monthEndNote, categorize, greeting, bucket,
} from '../model.js';
import { loader, emptyState, markers, legend, banner, countdownEl, errorState, mascotFace } from '../ui.js';
import { createMotion } from '../motion.js';

const gridStart = (y, m) => weekStart(makeKey(y, m, 1));

export function renderToday(app, route, { seg } = {}) {
  const T = app.T;
  const lang = app.lang;
  const isList = seg === 'list';
  const today = app.today();
  let sel = isDayKey(route.query.get('day') || '') ? route.query.get('day') : today;
  const cache = new Map(); // grid start -> Promise<planner data>
  const destroyers = [];

  const el = h('div', { class: 'stack', style: { gap: '14px' } });
  const name = app.session?.user?.name || '';
  el.append(
    h('div', { class: 'top' },
      h('img', { src: '/app/img/mascot-sm.jpg', alt: '', width: 44, height: 44, style: { width: '44px', height: '44px', borderRadius: '50%', border: '2px solid #3B3B3B' } }),
      h('div', { class: 'grow' }, h('h1', { tabindex: '-1', 'data-autofocus': '' }, greeting(name, { T, tz: app.tz, now: app.now() })), h('p', { class: 'sm muted' }, T('todaySub')))),
  );
  const chipSlot = h('div', { class: 'row', style: { justifyContent: 'flex-end' } });
  el.append(chipSlot);
  el.append(h('div', { class: 'seg', role: 'tablist', 'aria-label': T('navToday') },
    h('button', { role: 'tab', type: 'button', class: isList ? '' : 'on', 'aria-selected': String(!isList), onclick: () => app.go(`today${sel !== today ? `?day=${sel}` : ''}`) }, h('span', null, T('planner'))),
    h('button', { role: 'tab', type: 'button', class: isList ? 'on' : '', 'aria-selected': String(isList), onclick: () => app.go('reminders') }, h('span', null, T('allRem')))));

  const fab = h('a', { class: 'btn pri fab', href: `#/reminder/new${!isList && sel >= today ? `?day=${sel}` : ''}` }, glyph('plus', { size: 20 }), T('fab'));
  fab.querySelector('img').style.filter = 'brightness(0) invert(1)';

  const showDriveChip = () => {
    clear(chipSlot);
    chipSlot.append(h('a', { class: 'btn sm', href: '#/me' }, icon('check'), T('driveOk')));
  };

  if (isList) {
    const l = reminderList(app, { onLoaded: showDriveChip });
    destroyers.push(() => l.destroy());
    el.append(l.el);
    l.run();
    return { el, fab, destroy: () => destroyers.forEach((d) => d()) };
  }

  // ------------------------------------------------------------ planner

  function fetchGrid(key) {
    const p = parseKey(key);
    const start = gridStart(p.y, p.m);
    if (!cache.has(start)) {
      const pr = api.get('/planner', { query: { from: start, to: addDays(start, 41) } });
      cache.set(start, pr);
      pr.catch(() => cache.delete(start));
    }
    return cache.get(start);
  }

  const body = h('div', { class: 'stack', style: { gap: '14px' } });
  el.append(body);
  let load = null;

  function show() {
    load?.destroy();
    load = loader(app, {
      fetch: () => fetchGrid(sel),
      render: (data) => { showDriveChip(); return plannerBody(data); },
    });
    clear(body);
    body.append(load.el);
    load.run();
  }

  function select(k) {
    sel = k;
    app.setQuery({ day: k === today ? null : k });
    fab.setAttribute('href', `#/reminder/new${k >= today ? `?day=${k}` : ''}`);
    fab.hidden = k < today;
    show();
  }

  function dayItems(data, k) {
    return {
      rems: data.reminders.filter((r) => occursOn(r, k, { timeZone: app.tz })).map((r) => ({ r, hm: zoned(r.at, app.tz).hm })).sort((a, b) => a.hm.localeCompare(b.hm)),
      dls: data.deadlines.filter((d) => d.deadline === k),
      evs: data.events.items.filter((e) => (e.allDay ? e.start === k : zoned(e.start, app.tz).key === k)),
      saved: data.saved.items.filter((x) => x.day === k),
    };
  }

  function plannerBody(data) {
    const wrap = h('div', { class: 'two' });
    const left = h('div');
    const right = h('div', { class: 'desk-only', style: { display: 'none' } });
    wrap.append(left, right);
    const now = app.now();

    if (data.events.status === 'error') left.append(banner('warn', { iconSrc: '/app/img/alert.svg', title: T('partialH'), body: T('partialCal') }));
    if (data.events.status === 'no_scope') left.append(banner('warn', { iconSrc: '/app/img/alert.svg', title: T('partialH'), body: T('partialCalScope') }));

    // Up next: the next three things from now, today and the two days after.
    if (sel === today) {
      left.append(h('h2', null, T('upNext')));
      const up = [];
      for (let i = 0; i < 3; i++) {
        const k = addDays(today, i);
        const it = dayItems(data, k);
        const rel = i === 0 ? T('today') : i === 1 ? T('tomorrow') : formatDay(k, lang, 'dm');
        for (const d of it.dls) if (bucket(d) === 'open') up.push({ sort: `${k}0`, node: agendaDeadline(d, { day: rel }) });
        for (const { r, hm } of it.rems) {
          if (r.firedAt || Date.parse(zonedToUtc(k, hm, app.tz)) <= now.getTime()) continue;
          up.push({ sort: `${k}1${hm}`, node: agendaReminder(r, hm, { day: rel }) });
        }
        for (const e of it.evs) {
          const hm = e.allDay ? '00:00' : zoned(e.start, app.tz).hm;
          if (!e.allDay && Date.parse(e.end || e.start) < now.getTime()) continue;
          up.push({ sort: `${k}1${hm}`, node: agendaEvent(e, { day: rel }) });
        }
      }
      up.sort((a, b) => a.sort.localeCompare(b.sort));
      if (up.length) left.append(...up.slice(0, 3).map((u) => u.node));
      else left.append(h('p', { class: 'sm muted' }, T('upNextEmpty')));
    }

    // Week strip.
    const ws = weekStart(sel);
    left.append(h('div', { class: 'row', style: { gap: '2px' } },
      h('button', { class: 'btn ghost', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': `${weekTitle(ws, lang)} · ${T('openMonth')}`, style: { padding: '0 6px', fontSize: '18px', fontWeight: '700' }, onclick: () => openMonth() },
        icon('calendar', { size: 20 }), weekTitle(ws, lang), glyph('down', { size: 18 })),
      h('span', { class: 'grow' }),
      sel !== today ? h('button', { class: 'btn sm', type: 'button', onclick: () => select(today) }, T('backToday')) : null,
      h('button', { class: 'btn ico', type: 'button', 'aria-label': T('prevWeek'), onclick: () => select(addDays(sel, -7)) }, glyph('prev')),
      h('button', { class: 'btn ico', type: 'button', 'aria-label': T('nextWeek'), onclick: () => select(addDays(sel, 7)) }, glyph('next'))));
    const selMonth = parseKey(sel).m;
    const week = h('div', { class: 'week' });
    for (let i = 0; i < 7; i++) {
      const k = addDays(ws, i);
      const it = dayItems(data, k);
      const p = parseKey(k);
      week.append(h('button', {
        type: 'button', class: `day${k === today ? ' today' : ''}${p.m !== selMonth ? ' out' : ''}`, 'aria-pressed': String(k === sel),
        'aria-label': `${formatDay(k, lang)}${k === today ? ` (${T('today')})` : ''}: ${T('dayCount', { r: it.rems.length, d: it.dls.length, e: it.evs.length })}`,
        onclick: () => select(k),
      }, h('small', null, formatDay(k, lang, 'dw')), h('b', null, p.d), markers({ r: it.rems.length, d: it.dls.length, e: it.evs.length, f: it.saved.length })));
    }
    left.append(week, legend(T));

    // The selected day.
    const it = dayItems(data, sel);
    const whenWord = sel === today ? 'today' : 'on';
    left.append(h('h2', { 'aria-live': 'polite' }, formatDay(sel, lang, 'full') + (sel === today ? ` (${T('today')})` : sel === addDays(today, 1) ? ` (${T('tomorrow')})` : '')));
    for (const d of it.dls) left.append(agendaDeadline(d));
    left.append(h('h3', { class: 'row', style: { gap: '6px', fontSize: '14px' } }, icon('bell'), T('lgRem'), h('span', { class: 'muted', style: { fontWeight: '500' } }, String(it.rems.length))));
    if (it.rems.length) {
      for (const { r, hm } of it.rems) left.append(agendaReminder(r, hm, { past: Date.parse(zonedToUtc(sel, hm, app.tz)) <= now.getTime() }));
    } else {
      const dm = formatDay(sel, lang, 'dm');
      left.append(emptyState({
        title: whenWord === 'today' ? T('dayEmptyToday') : T('dayEmptyOn', { date: dm }),
        ex: T('chatEx'),
        action: sel >= today ? h('a', { class: 'btn', href: `#/reminder/new?day=${sel}` }, sel === today ? T('addToday') : T('addOn', { date: dm })) : null,
      }));
    }
    for (const e of it.evs) left.append(agendaEvent(e));

    // Saved that day (collapsible). Desktop shows it in the side column.
    const savedPanel = savedSection(it.saved, data.saved.status, sel === today, formatDay(sel, lang, 'dm'));
    left.append(savedPanel.mobile);
    right.append(monthGrid(data, { inline: true }), savedPanel.desktop);
    return wrap;
  }

  function agendaDeadline(d, { day } = {}) {
    const tone = d.status === 'applied' ? 'later' : deadlineTone(d);
    return h('a', { class: `ag d ${tone}`, href: `#/deadline/${encodeURIComponent(d.id)}` },
      h('div', null, day ? h('small', { class: 'xs muted' }, day) : null, day ? h('br') : null, h('b', null, T('allDay'))),
      h('div', null, h('b', { style: { display: 'block' } }, d.title),
        h('span', { class: 'kind' }, icon('target', { size: 16 }), `Deadline · ${noteText(d, T)}`),
        countdownEl(d, tone, countdown(d, T))));
  }

  function agendaReminder(r, hm, { day, past } = {}) {
    const rep = repeatShort(r, T);
    const state = r.firedAt ? ` · ${T('fired')}` : past ? ` · ${T('past')}` : '';
    return h('div', { class: `ag r${past || r.firedAt ? ' past' : ''}` },
      h('div', null, day ? h('small', { class: 'xs muted' }, day) : null, day ? h('br') : null, h('b', null, formatTime(hm, lang).replace(' น.', ''))),
      h('div', null, h('b', null, r.text), h('span', { class: 'kind' }, icon('bell', { size: 16 }), `${T('remKind')}${rep ? ` · ${rep}` : ''}${state}`)));
  }

  function agendaEvent(e, { day } = {}) {
    const when = e.allDay ? T('allDay') : `${zoned(e.start, app.tz).hm}–${zoned(e.end || e.start, app.tz).hm}`;
    return h('div', { class: 'ag e' },
      h('div', null, day ? h('small', { class: 'xs muted' }, day) : null, day ? h('br') : null, h('b', null, when)),
      h('div', null, h('b', null, e.title), h('span', { class: 'kind' }, icon('calendar', { size: 16 }), T('evKind'))));
  }

  function savedSection(items, status, isToday, dm) {
    const title = isToday ? T('savedToday') : T('savedOn', { date: dm });
    const list = () => {
      if (status === 'error') return [h('p', { class: 'sm', role: 'status' }, T('errLoad'))];
      if (!items.length) return [h('p', { class: 'sm muted' }, isToday ? T('nothingSavedToday') : T('nothingSavedOn', { date: dm }))];
      return items.map((x) => {
        const ic = x.type === 'memory' ? 'note' : x.type === 'link' ? 'link' : 'gallery';
        const meta = x.type === 'memory' ? T('memTab') : x.type === 'link' ? x.host : T('filesTab');
        const href = x.type === 'file' ? `#/file/${encodeURIComponent(x.id)}` : `#/library?tab=${x.type === 'link' ? 'links' : 'memory'}`;
        return h('a', { class: 'it', href, style: { textDecoration: 'none' } },
          h('div', { class: 'th' }, icon(ic, { size: 28, cls: 'is' })),
          h('div', null, h('p', { style: { fontWeight: '600', overflowWrap: 'anywhere' } }, x.name), h('p', { class: 'xs muted' }, meta)));
      });
    };
    const count = status === 'error' ? '' : (items.length === 1 ? T('nItem') : T('nItems', { n: items.length }));
    let open = true;
    const content = h('div', { class: 'stack' }, list());
    const toggle = h('button', {
      type: 'button', 'aria-expanded': 'true', class: 'row', style: { minHeight: '44px', background: 'none', border: '0', padding: '0', font: '700 16px "Bai Jamjuree",sans-serif', color: '#3B3B3B', textAlign: 'left', cursor: 'pointer', flexWrap: 'nowrap' },
      onclick: () => { open = !open; toggle.setAttribute('aria-expanded', String(open)); content.hidden = !open; },
    }, icon('note'), h('span', { class: 'grow' }, title, ' ', h('span', { class: 'sm muted', style: { fontWeight: '500' } }, count)), glyph('down', { size: 18 }));
    const mobile = h('section', { class: 'panel mob-only' }, toggle, content);
    const desktop = h('section', { class: 'panel' }, h('b', null, title, ' ', h('span', { class: 'sm muted', style: { fontWeight: '500' } }, count)), h('div', { class: 'stack' }, list()));
    return { mobile, desktop };
  }

  // -------------------------------------------------------- month view

  function monthGrid(data, { inline = false, y, m, onPick } = {}) {
    const p = parseKey(sel);
    const yy = y ?? p.y;
    const mm = m ?? p.m;
    const gs = gridStart(yy, mm);
    const grid = h('div', { class: 'mgrid' });
    for (let i = 0; i < 7; i++) grid.append(h('div', { class: 'w', 'aria-hidden': 'true' }, formatDay(addDays('2026-10-05', i), lang, 'dw')));
    for (let i = 0; i < 42; i++) {
      const k = addDays(gs, i);
      const kp = parseKey(k);
      const it = data ? dayItems(data, k) : { rems: [], dls: [], evs: [], saved: [] };
      grid.append(h('button', {
        type: 'button', class: `mday${kp.m !== mm ? ' out' : ''}${k === today ? ' today' : ''}`, 'aria-pressed': String(k === sel),
        'aria-label': `${formatDay(k, lang)}${k === today ? ` (${T('today')})` : ''}: ${T('dayCount', { r: it.rems.length, d: it.dls.length, e: it.evs.length })}`,
        onclick: () => (onPick ? onPick(k) : select(k)),
      }, h('span', { class: 'dn' }, kp.d), markers({ r: it.rems.length, d: it.dls.length, e: it.evs.length, f: it.saved.length })));
    }
    if (!inline) return grid;
    return h('section', { class: 'card' }, h('b', { style: { textAlign: 'center' } }, formatDay(makeKey(yy, mm, 1), lang, 'my')), grid);
  }

  function openMonth() {
    const p = parseKey(sel);
    let y = p.y;
    let m = p.m;
    const scrim = h('div', { class: 'scrim' });
    const titleId = 'month-title';
    const box = h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
    const monthLabel = h('b', { class: 'grow', style: { textAlign: 'center' }, 'aria-live': 'polite' });
    const gridSlot = h('div');
    let release = () => {};
    let motion = null;
    const close = () => { motion?.destroy(); release(); scrim.remove(); };
    const pick = (k) => { close(); select(k); };
    async function paint() {
      monthLabel.textContent = formatDay(makeKey(y, m, 1), lang, 'my');
      clear(gridSlot);
      gridSlot.append(monthGrid(null, { y, m, onPick: pick }));
      const my = `${y}-${m}`;
      paint.cur = my;
      motion?.destroy();
      motion = createMotion({ T, kind: 'loading', compact: true });
      gridSlot.append(motion.el);
      motion.start();
      try {
        const data = await fetchGrid(makeKey(y, m, 1));
        if (paint.cur !== my) return;
        motion.destroy();
        const hadFocus = gridSlot.contains(document.activeElement) || !box.contains(document.activeElement);
        clear(gridSlot);
        gridSlot.append(monthGrid(data, { y, m, onPick: pick }));
        // Keep keyboard focus inside the dialog when the grid is replaced.
        if (hadFocus && scrim.isConnected) (gridSlot.querySelector('[aria-pressed="true"]') || box.querySelector('button'))?.focus();
      } catch (err) {
        if (paint.cur !== my) return;
        motion.destroy();
        gridSlot.append(h('p', { class: 'err-t', role: 'alert' }, T('errLoad')));
      }
    }
    box.append(
      h('div', { class: 'top' }, h('h2', { id: titleId, class: 'grow' }, T('calendar')), h('button', { class: 'btn ico', type: 'button', 'aria-label': T('close'), onclick: close }, glyph('close'))),
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
        h('button', { class: 'btn ico', type: 'button', 'aria-label': T('prevMonth'), onclick: () => { if (--m < 1) { m = 12; y--; } paint(); } }, glyph('prev')),
        monthLabel,
        h('button', { class: 'btn ico', type: 'button', 'aria-label': T('nextMonth'), onclick: () => { if (++m > 12) { m = 1; y++; } paint(); } }, glyph('next'))),
      gridSlot,
      h('button', { class: 'btn', type: 'button', onclick: () => pick(today) }, T('backToday')));
    scrim.append(box);
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
    document.body.append(scrim);
    paint();
    release = trapFocus(box, { onEscape: close, initial: box.querySelector('[aria-pressed="true"]') || undefined });
    destroyers.push(() => { if (scrim.isConnected) close(); });
  }

  fab.hidden = sel < today;
  show();
  return { el, fab, destroy: () => { load?.destroy(); destroyers.forEach((d) => d()); } };
}

// ------------------------------------------------------- reminder manager

function reminderList(app, { onLoaded } = {}) {
  const T = app.T;
  const lang = app.lang;
  let cat = app.route.query.get('cat') || 'upcoming';
  if (!['upcoming', 'repeat', 'done'].includes(cat)) cat = 'upcoming';
  const l = loader(app, {
    fetch: (signal) => api.get('/reminders', { signal }),
    render: (data) => { onLoaded?.(); return listBody(data); },
  });

  function listBody(data) {
    const now = app.now();
    const cats = categorize(data.items, now);
    const wrap = h('div', { class: 'stack', style: { gap: '14px' } });
    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': T('allRem') });
    const listEl = h('div', { class: 'stack', style: { gap: '12px' } });
    const paint = () => {
      clear(chips);
      for (const [key, label] of [['upcoming', 'cUp'], ['repeat', 'cRep'], ['done', 'cDone']]) {
        chips.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(cat === key), onclick: () => { cat = key; app.setQuery({ cat: key === 'upcoming' ? null : key }); paint(); } }, T(label), ' ', h('span', { class: 'n' }, String(cats[key].length))));
      }
      clear(listEl);
      if (cat === 'done') listEl.append(h('p', { class: 'xs muted' }, T('doneNote')));
      const items = cats[cat];
      if (!items.length) listEl.append(emptyState({ title: T({ upcoming: 'eUp', repeat: 'eRep', done: 'eDone' }[cat]), ex: T('chatEx') }));
      for (const r of items) listEl.append(card(r, now));
    };
    paint();
    wrap.append(chips, listEl);
    if (data.deadlineAlerts) wrap.append(h('a', { class: 'xs muted', href: '#/deadlines' }, T('deadlineAlertsNote', { n: data.deadlineAlerts })));
    return wrap;
  }

  function card(r, now) {
    const tz = app.tz;
    const next = r.firedAt ? r.at : (upcoming(r, 1, { timeZone: tz, now })[0] || r.at);
    const z = zoned(next, tz);
    const today = app.today();
    const day = z.key === today ? T('today') : z.key === addDays(today, 1) ? T('tomorrow') : formatDay(z.key, lang, 'dm');
    const warn = monthEndNote(r, { T, tz });
    const actions = h('div', { class: 'row' });
    const busy = (btn, fn) => async () => {
      const all = actions.querySelectorAll('button,a');
      all.forEach((b) => { b.disabled = true; b.setAttribute('aria-disabled', 'true'); });
      const label = btn.textContent;
      btn.textContent = T('saving');
      try {
        await fn();
      } catch (err) {
        all.forEach((b) => { b.disabled = false; b.removeAttribute('aria-disabled'); });
        btn.textContent = label;
        if (err?.status === 404) { app.toast(T('gone')); l.run({ quiet: true }); return; }
        app.toast(err?.isNetwork ? T('tOpFailNet') : T('tOpFail'));
      }
    };
    if (r.firedAt) {
      const done = h('button', { class: 'btn pri', type: 'button' }, T('remDone'));
      done.onclick = busy(done, async () => { await api.post(`/reminders/${r.id}/done`); app.toast(T('tDoneRem')); l.run({ quiet: true }); });
      const s10 = h('button', { class: 'btn sm', type: 'button' }, T('snooze10'));
      const s60 = h('button', { class: 'btn sm', type: 'button' }, T('snooze60'));
      const snooze = (btn, min) => busy(btn, async () => {
        const res = await api.post(`/reminders/${r.id}/snooze`, { minutes: min });
        app.toast(T('tSnoozed', { when: formatTime(zoned(res.reminder.at, tz).hm, lang) }));
        l.run({ quiet: true });
      });
      s10.onclick = snooze(s10, 10);
      s60.onclick = snooze(s60, 60);
      actions.append(done, s10, s60);
    } else {
      const cancel = h('button', { class: 'btn sm dan', type: 'button', 'aria-haspopup': 'dialog' }, T('cancelRem'));
      cancel.onclick = async () => {
        const ok = await app.confirm({
          title: T('cancelTitle', { text: r.text }), body: r.repeat === 'none' ? T('cancelOnce') : T('cancelRepeat'),
          no: T('cancelNo'), yes: T('cancelYes'), danger: true, run: () => api.del(`/reminders/${r.id}`),
        });
        if (ok) { app.toast(T('tCancelled')); l.run({ quiet: true }); }
      };
      actions.append(h('a', { class: 'btn sm', href: `#/reminder/${encodeURIComponent(r.id)}` }, icon('clock'), T('changeTime')), cancel);
    }
    return h('article', { class: 'card' },
      r.firedAt ? h('span', { class: 'cd urgent' }, T('dueNow', { time: formatTime(zoned(r.at, tz).hm, lang) })) : null,
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '12px', flexWrap: 'nowrap' } },
        h('div', { style: { minWidth: '64px' } }, h('b', { style: { fontSize: '22px', lineHeight: '1.3' } }, z.hm), h('p', { class: 'xs muted' }, day)),
        h('div', { class: 'grow' }, h('b', { style: { lineHeight: '1.5', overflowWrap: 'anywhere' } }, r.text), h('p', { class: 'sm' }, repeatSummary(r, { lang, T, tz })),
          h('p', { class: 'xs muted' }, nextLine(r, { lang, T, tz, now })),
          warn ? h('p', { class: 'sm', style: { background: '#F6E7CB', borderRadius: '10px', padding: '6px 10px', marginTop: '4px' } }, warn) : null)),
      h('p', { class: 'xs muted' }, T('destPrivate')),
      actions);
  }

  l.run();
  return l;
}

export { mascotFace, errorState };
