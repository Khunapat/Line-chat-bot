// ของฉัน: identity, connected account, counts (items, not storage), shared AI
// usage marked as estimated with the real reset time, preferences, the
// connection and help / privacy.

import { h, clear, glyph, icon, uid } from '../dom.js';
import { api, ApiError } from '../api.js';
import { formatDay, formatTime, formatDateTime, zoned, addDays } from '../../../shared/dates.js';
import { topBar, loader } from '../ui.js';
import { setUserReducedMotion, userReducedMotion } from '../motion.js';

function resetText(iso, app) {
  const z = zoned(iso, app.tz);
  const today = app.today();
  const time = formatTime(z.hm, app.lang);
  if (z.key === today) return `${app.T('today')} ${time}`;
  if (z.key === addDays(today, 1)) return `${app.T('tomorrow')} ${time}`;
  return formatDateTime(iso, app.lang, app.tz);
}

export function renderMe(app) {
  const T = app.T;
  const el = h('div', { class: 'stack', style: { gap: '14px' } });
  el.append(topBar(app, T('meTitle')));
  const l = loader(app, {
    fetch: (signal) => api.get('/me', { signal }),
    render: (me) => { app.me = me; app.connectUrl = me.connectUrl || ''; return body(me); },
    skeletons: 4,
  });
  el.append(l.el);
  l.run();

  function body(me) {
    const wrap = h('div', { class: 'stack', style: { gap: '14px' } });
    const name = me.user.name || '—';
    wrap.append(h('section', { class: 'card', style: { flexDirection: 'row', alignItems: 'center', gap: '12px' } },
      h('div', { class: 'avatar', 'aria-hidden': 'true' }, me.user.picture ? h('img', { src: me.user.picture, alt: '' }) : name.slice(0, 1).toUpperCase()),
      h('div', { class: 'grow' }, h('b', { style: { fontSize: '18px', overflowWrap: 'anywhere' } }, name), h('p', { class: 'sm muted' }, T('privateChat')))));

    // Account and connection status, as the server found them just now.
    const connected = me.drive?.status === 'ok';
    const acct = h('dl', { class: 'kv' },
      h('dt', null, 'Google'), h('dd', null, me.drive?.email || '—', ' ', h('span', { class: `tag${connected ? '' : ' u'}` }, connected ? T('connected') : T('disconnected'))),
      h('dt', null, T('dest2')), h('dd', { class: 'sm' }, `My Drive › ${me.root}`));
    if (me.calendar) acct.append(h('dt', null, T('calStatus')), h('dd', { class: 'sm' }, { ok: T('calOk'), no_scope: T('calNoScope'), error: T('calUnknown') }[me.calendar]));
    wrap.append(h('section', { class: 'card' }, h('h2', { style: { fontSize: '17px' } }, T('account')), acct));

    // Counts of items. Unknown stays unknown.
    const c = me.counts;
    const stat = (n, label, sub) => h('div', { class: 'st' }, h('b', null, n === null || n === undefined ? '–' : String(n)), h('span', null, label), n === null ? h('span', { class: 'xs' }, T('countFailed')) : null, sub ? h('span', { class: 'xs' }, sub) : null);
    const counts = h('section', { class: 'card' }, h('h2', { style: { fontSize: '17px' } }, T('counts')), h('p', { class: 'xs muted' }, T('countsNote')));
    if (c) {
      counts.append(h('div', { class: 'stats' },
        stat(c.files, T('cntFiles')), stat(c.links, T('cntLinks')), stat(c.memories, T('cntMem')), stat(c.reminders, T('cntRem')),
        stat(c.deadlines?.open ?? null, T('cntDl'), c.deadlines ? T('cntDlSub', { a: c.deadlines.applied, c: c.deadlines.closed }) : '')));
    } else {
      counts.append(h('p', { class: 'sm' }, me.connected ? T('driveOffB') : T('notConnectedB')));
    }
    wrap.append(counts);

    // Shared AI usage: our own count, so it is an estimate.
    const ai = h('section', { class: 'card' },
      h('h2', { class: 'row', style: { gap: '8px', fontSize: '17px' } }, icon('ai', { size: 20 }), T('aiH'), h('span', { class: 'tag est' }, T('estimated'))),
      h('p', { class: 'xs muted' }, T('aiNote')));
    if (!me.ai?.enabled) ai.append(h('p', { class: 'sm' }, T('aiOff')));
    else if (me.ai.error) ai.append(h('p', { class: 'sm' }, T('aiCountFailed')));
    else {
      for (const m of me.ai.models) {
        const pct = m.limit ? Math.min(100, Math.round((m.used / m.limit) * 100)) : null;
        ai.append(h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('b', { class: 'grow', style: { overflowWrap: 'anywhere' } }, m.model), h('span', { class: 'sm' }, m.exhausted ? T('aiExhausted') : '')));
        if (pct !== null) {
          const label = T('aiUsedOf', { used: m.used, limit: m.limit });
          ai.append(h('div', { class: 'meter', role: 'img', 'aria-label': label }, h('i', { class: m.exhausted || pct >= 100 ? 'full' : '', style: { width: `${pct}%` } })), h('p', { class: 'xs' }, label));
        } else {
          ai.append(h('p', { class: 'xs' }, `${T('aiUsed', { used: m.used })} · ${m.exhausted ? T('aiExhausted') : T('aiLimitUnknown')}`));
        }
      }
      ai.append(h('p', { class: 'xs muted' }, T('aiTotal', { n: me.ai.total })));
      if (me.ai.resetAt) ai.append(h('p', { class: 'sm' }, h('b', null, T('aiReset', { when: resetText(me.ai.resetAt, app) })), ` · ${T('aiResetWhy')}`));
    }
    wrap.append(ai);

    // Preferences.
    const rmId = uid('rm');
    const rm = h('input', { id: rmId, type: 'checkbox', checked: userReducedMotion() });
    rm.addEventListener('change', () => setUserReducedMotion(rm.checked));
    wrap.append(h('section', { class: 'card' }, h('h2', { style: { fontSize: '17px' } }, T('prefs')),
      h('a', { class: 'li', href: '#/me/lang' }, h('img', { src: '/app/img/language.svg', alt: '' }), h('span', { class: 'grow' }, T('language')), h('span', { class: 'v' }, app.lang === 'en' ? 'English' : 'ไทย')),
      h('a', { class: 'li', href: '#/me/tone' }, h('img', { src: '/app/img/tone.svg', alt: '' }), h('span', { class: 'grow' }, T('tone')), h('span', { class: 'v' }, me.prefs.tone === 'friend' ? T('toneFr') : T('tonePol'))),
      me.connected ? h('a', { class: 'li', href: '#/deadline-alerts' }, icon('bell', { size: 20 }), h('span', { class: 'grow' }, T('deadlineAlerts'))) : null,
      h('label', { class: 'rc', for: rmId }, rm, h('span', null, h('b', null, T('rmLabel')), h('small', null, T('rmSub'))))));

    if (app.preview) wrap.append(simPanel(app));

    // Connection.
    const conn = h('section', { class: 'card' }, h('h2', { style: { fontSize: '17px' } }, T('conn')));
    if (me.owner) conn.append(h('p', { class: 'sm' }, T('ownerManaged')));
    else if (me.canDisconnect) {
      const btn = h('button', { class: 'btn dan', type: 'button', 'aria-haspopup': 'dialog' }, T('disconnect'));
      btn.addEventListener('click', async () => {
        const ok = await app.confirm({
          title: T('discTitle'), body: `${T('discBody')}${me.groupsHosted ? ` ${T('discGroups', { n: me.groupsHosted })}` : ''}`,
          no: T('cancelL'), yes: T('discYes'), danger: true, run: () => api.post('/disconnect', { confirm: true }),
        });
        if (ok) { app.session.connected = false; app.toast(T('tDisc')); l.run(); }
      });
      conn.append(btn);
      if (me.connectUrl && !connected) conn.append(h('a', { class: 'btn pri', href: me.connectUrl, target: '_blank', rel: 'noopener' }, T('reconnect')));
    } else if (me.connectUrl) {
      conn.append(h('a', { class: 'btn pri', href: me.connectUrl, target: '_blank', rel: 'noopener' }, T('reconnect')));
    } else {
      conn.append(h('p', { class: 'sm' }, me.connected ? T('connected') : T('notConnectedB')));
    }
    wrap.append(conn);

    wrap.append(h('section', { class: 'card' }, h('h2', { style: { fontSize: '17px' } }, T('helpH')), h('p', { class: 'sm' }, T('privacyB', { root: me.root })),
      h('a', { class: 'li', href: '#/me/help' }, h('img', { src: '/app/img/help.svg', alt: '' }), h('span', { class: 'grow' }, T('help'))),
      h('a', { class: 'li', href: '#/me/privacy' }, h('img', { src: '/app/img/privacy.svg', alt: '' }), h('span', { class: 'grow' }, T('privacy')))));
    return wrap;
  }

  return { el, destroy: () => l.destroy() };
}

/** Local preview only: the server exposes /api/preview/sim just in that mode. */
function simPanel(app) {
  const T = app.T;
  const panel = h('section', { class: 'panel', style: { border: '2px dashed #686458' } }, h('h2', { style: { fontSize: '16px' } }, T('simH')), h('p', { class: 'xs muted' }, T('simNote')));
  const state = { net: 'normal', ai: false, drive: false, cal: false };
  const chips = h('div', { class: 'chips wrap' });
  const toggles = h('div', { class: 'chips wrap' });
  async function send(patch) {
    Object.assign(state, patch);
    try { Object.assign(state, await (await fetch('/api/preview/sim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) })).json()); } catch { /* preview only */ }
    paint();
  }
  function paint() {
    clear(chips);
    for (const [k, label] of [['normal', 'nNormal'], ['slow', 'nSlow'], ['very', 'nVery'], ['fail', 'nFail']]) chips.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.net === k), onclick: () => send({ net: k }) }, T(label)));
    clear(toggles);
    for (const [k, label] of [['ai', 'simAi'], ['drive', 'simDrive'], ['cal', 'simCal']]) toggles.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(state[k]), onclick: () => send({ [k]: !state[k] }) }, T(label)));
    toggles.append(h('button', { type: 'button', class: 'chip', onclick: () => app.go('welcome') }, T('simWelcome')));
  }
  fetch('/api/preview/sim').then((r) => r.json()).then((s) => { Object.assign(state, s); paint(); }).catch(() => paint());
  panel.append(h('p', { class: 'sm', style: { fontWeight: '600' } }, T('simNet')), chips, toggles);
  return panel;
}

export function renderLang(app) {
  const T = app.T;
  const el = h('div', { class: 'stack', style: { gap: '14px' } });
  el.append(topBar(app, T('langTitle'), { back: 'me' }), h('p', null, T('langIntro')));
  const name = uid('lang');
  const status = h('p', { class: 'sm', role: 'status' });
  const fs = h('fieldset', null, h('legend', { class: 'sr' }, T('langTitle')));
  const sample = app.today();
  const inputs = [];
  for (const [code, label] of [['th', 'ไทย'], ['en', 'English']]) {
    const inp = h('input', { type: 'radio', name, checked: app.lang === code });
    inputs.push(inp);
    inp.addEventListener('change', async () => {
      inputs.forEach((x) => { x.disabled = true; });
      status.textContent = T('saving');
      try {
        const r = await api.put('/prefs', { lang: code });
        app.session.prefs = r.prefs;
        app.setLang(code);
        app.toast(`${app.T('tLang')}${r.menu?.menuSwitched ? ` · ${app.T('langMenuSwitched')}` : ''}`);
      } catch (err) {
        inputs.forEach((x, i) => { x.disabled = false; x.checked = (i === 0 ? 'th' : 'en') === app.lang; });
        status.textContent = err instanceof ApiError && err.isNetwork ? T('tOpFailNet') : T('tOpFail');
      }
    });
    fs.append(h('label', { class: 'rc', lang: code }, inp, h('span', null, h('b', null, label), h('small', null, `${formatDay(sample, code)} · ${formatTime('09:00', code)}`))));
  }
  el.append(fs, status, h('p', { class: 'xs muted' }, T('langNote')));
  return { el };
}

export function renderTone(app) {
  const T = app.T;
  const el = h('div', { class: 'stack', style: { gap: '14px' } });
  el.append(topBar(app, T('toneTitle'), { back: 'me' }));
  const saved = app.session?.prefs?.tone || 'polite';
  let pick = saved;
  const name = uid('tone');
  const bub = h('p', { class: 'bub', 'aria-live': 'polite' });
  const save = h('button', { class: 'btn pri blk', type: 'button' });
  const status = h('p', { class: 'sm', role: 'status' });
  const paint = () => {
    bub.textContent = pick === 'friend' ? T('sampleFr') : T('samplePol');
    const changed = pick !== saved;
    save.disabled = !changed;
    save.textContent = changed ? T('save') : T('unchanged');
  };
  const fs = h('fieldset', null, h('legend', { class: 'sr' }, T('toneTitle')));
  for (const [k, label, sub] of [['polite', 'tonePol', 'tonePolD'], ['friend', 'toneFr', 'toneFrD']]) {
    const inp = h('input', { type: 'radio', name, checked: pick === k });
    inp.addEventListener('change', () => { pick = k; paint(); });
    fs.append(h('label', { class: 'rc' }, inp, h('span', null, h('b', null, T(label)), h('small', null, T(sub)))));
  }
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = T('saving');
    try {
      const r = await api.put('/prefs', { tone: pick });
      app.session.prefs = r.prefs;
      app.toast(T('tTone'));
      app.go('me');
    } catch (err) {
      status.textContent = err instanceof ApiError && err.isNetwork ? T('tOpFailNet') : T('tOpFail');
      paint();
    }
  });
  el.append(fs, h('p', { class: 'sm muted' }, T('preview')), h('div', { class: 'speech' }, h('img', { src: '/app/img/mascot-sm.jpg', alt: '' }), bub), h('p', { class: 'xs muted' }, T('toneGroupNote')), status, save);
  paint();
  return { el };
}

export function renderHelp(app) {
  const T = app.T;
  return {
    el: h('div', { class: 'stack', style: { gap: '14px' } },
      topBar(app, T('help'), { back: 'me' }),
      h('p', null, T('helpIntro')),
      h('section', { class: 'card' }, h('ul', { class: 'stack', style: { gap: '6px' } }, ['help1', 'help2', 'help3', 'help4', 'help5', 'help6'].map((k) => h('li', null, T(k))))),
      h('div', { class: 'panel' }, h('p', { class: 'sm' }, T('alertsChatTip')))),
  };
}

export function renderPrivacy(app) {
  const T = app.T;
  const root = app.me?.root || 'LineArchive';
  return {
    el: h('div', { class: 'stack', style: { gap: '14px' } },
      topBar(app, T('privacy'), { back: 'me' }),
      h('section', { class: 'card' }, h('h2', { style: { fontSize: '17px' } }, T('helpH')), h('p', { class: 'sm' }, T('privacyB', { root }))),
      h('section', { class: 'card' }, ['privacy2', 'privacy3', 'privacy4'].map((k) => h('p', { class: 'sm' }, T(k))))),
  };
}
