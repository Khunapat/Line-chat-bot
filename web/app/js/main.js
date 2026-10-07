// JaiJa web app: sign-in through LIFF, then a hash router over four tabs
// (วันนี้ / Deadline / คลัง / ของฉัน). Language comes from the server-side
// preference of the verified LINE user.

import { h, clear, glyph, icon, trapFocus } from './dom.js';
import { api, setToken, onSessionLost, ApiError } from './api.js';
import { translator, normalizeLang } from '../../shared/i18n.js';
import { zoned, DEFAULT_TZ } from '../../shared/dates.js';
import { createMotion } from './motion.js';
import { renderToday } from './views/today.js';
import { renderEditor, renderDone } from './views/reminders.js';
import { renderDeadlines, renderDeadline, renderAlertSettings } from './views/deadlines.js';
import { renderLibrary, renderFile } from './views/library.js';
import { renderMe, renderLang, renderTone, renderHelp, renderPrivacy } from './views/me.js';
import { renderWelcome } from './views/welcome.js';

const LIFF_SDK = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
const root = document.getElementById('app');

const app = {
  lang: 'th',
  T: translator('th'),
  tz: DEFAULT_TZ,
  skew: 0,
  session: null,
  me: null,
  config: null,
  connectUrl: '',
  preview: false,
  guard: null,
  view: null,
  route: { name: 'today', parts: [], query: new URLSearchParams() },
  now() { return new Date(Date.now() + this.skew); },
  today() { return zoned(this.now(), this.tz).key; },
  go(path, { replace = false } = {}) {
    const hash = path.startsWith('#') ? path : `#/${path.replace(/^\/+/, '')}`;
    if (hash === location.hash) { render(); return; }
    if (replace) { history.replaceState(null, '', hash); render(); } else location.hash = hash;
  },
  /** Update the query of the current route without re-rendering. */
  setQuery(patch) {
    const q = new URLSearchParams(this.route.query);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === '') q.delete(k); else q.set(k, v); }
    this.route.query = q;
    const base = ['', this.route.name, ...this.route.parts].join('/');
    const s = q.toString();
    history.replaceState(null, '', `#${base}${s ? `?${s}` : ''}`);
  },
  setGuard(fn) { this.guard = fn; },
  toast,
  confirm,
  sheet,
  setLang(lang) {
    this.lang = normalizeLang(lang);
    this.T = translator(this.lang);
    document.documentElement.lang = this.lang;
    document.title = 'JaiJa';
    renderShell();
    render();
  },
};
window.__jaija = app; // handy in the console and for the browser checks

// ------------------------------------------------------------------ boot

async function boot() {
  renderBare(h('div', { class: 'stack', style: { paddingTop: '40px' } }, waitBlock('authing')));
  let cfg;
  try {
    cfg = await api.get('/config', { auth: false });
  } catch (err) {
    return renderBare(fatal(err, boot));
  }
  app.config = cfg;
  app.preview = Boolean(cfg.preview);
  app.tz = cfg.timeZone || DEFAULT_TZ;
  onSessionLost(() => reauth());
  await signIn();
}

let liffReady = null;
async function liffInit() {
  if (!liffReady) {
    liffReady = (async () => {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = LIFF_SDK;
        s.onload = resolve;
        s.onerror = () => reject(new ApiError('network'));
        document.head.append(s);
      });
      await window.liff.init({ liffId: app.config.liffId });
      return window.liff;
    })();
  }
  return liffReady;
}

async function idToken() {
  if (app.preview) return 'preview-id-token-for-local-checks';
  const liff = await liffInit();
  if (!liff.isLoggedIn()) return null;
  return liff.getIDToken();
}

async function signIn() {
  if (!app.preview && !app.config.liffId) return renderBare(infoScreen('notConfiguredH', 'notConfiguredB'));
  let tok;
  try {
    tok = await idToken();
  } catch (err) {
    return renderBare(fatal(err, signIn));
  }
  if (!tok) return renderBare(loginScreen());
  let s;
  try {
    s = await api.post('/session', { idToken: tok }, { auth: false });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // The LIFF token was stale or rejected: sign in again through LINE.
      try { window.liff?.logout?.(); } catch { /* ignore */ }
      return renderBare(loginScreen('sessionExpiredH', 'sessionExpiredB'));
    }
    if (err instanceof ApiError && err.status === 503 && err.code === 'not_configured') return renderBare(infoScreen('notConfiguredH', 'notConfiguredB'));
    return renderBare(fatal(err, signIn));
  }
  app.session = s;
  app.skew = s.now ? Date.parse(s.now) - Date.now() : 0;
  setToken(s.token);
  app.lang = normalizeLang(s.prefs?.lang);
  app.T = translator(app.lang);
  document.documentElement.lang = app.lang;
  if (!s.connected) {
    renderShell();
    if (!s.prefs?.chosen) return app.go('welcome', { replace: true });
    return render();
  }
  renderShell();
  if (!s.prefs?.chosen) app.go('welcome', { replace: true });
  else render();
}

let reauthing = null;
function reauth() {
  if (reauthing) return reauthing;
  reauthing = (async () => {
    try {
      const tok = await idToken();
      if (!tok) throw new Error('logged out');
      const s = await api.post('/session', { idToken: tok }, { auth: false });
      app.session = { ...app.session, ...s };
      setToken(s.token);
      render();
    } catch {
      renderBare(loginScreen('sessionExpiredH', 'sessionExpiredB'));
    } finally {
      reauthing = null;
    }
  })();
  return reauthing;
}

// ---------------------------------------------------------------- shell

let mainEl;
let navEl;
let fabSlot;
let toastEl;

function renderShell() {
  const T = app.T;
  clear(root);
  mainEl = h('main', { id: 'main', class: 'main', tabindex: '-1' });
  fabSlot = h('div');
  navEl = h('nav', { class: 'nav', 'aria-label': T('navLabel') });
  toastEl = h('div', { class: 'toast-slot', 'aria-live': 'polite' });
  root.append(h('a', { class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); mainEl.focus(); } }, T('skipToContent')), mainEl, fabSlot, navEl, toastEl);
}

function renderBare(node) {
  clear(root);
  app.view?.destroy?.();
  app.view = null;
  const m = h('main', { id: 'main', class: 'main no-nav', tabindex: '-1' });
  if (app.preview) m.append(h('p', { class: 'badge-preview' }, app.T('previewBadge')));
  m.append(node);
  root.append(m);
}

const TABS = [
  ['today', 'calendar', 'navToday'],
  ['deadlines', 'target', 'navDl'],
  ['library', 'folder', 'navLib'],
  ['me', null, 'navMe'],
];

function tabOf(name) {
  if (['today', 'reminders', 'reminder', 'reminder-done', ''].includes(name)) return 'today';
  if (['deadlines', 'deadline', 'deadline-alerts'].includes(name)) return 'deadlines';
  if (['library', 'file'].includes(name)) return 'library';
  if (name === 'me') return 'me';
  return null;
}

function renderNav(active) {
  const T = app.T;
  clear(navEl);
  navEl.setAttribute('aria-label', T('navLabel'));
  navEl.append(h('div', { class: 'brand', 'aria-hidden': 'true' }, h('img', { src: '/app/img/mascot-sm.jpg', alt: '' }), 'Jai', h('span', { class: 'ja' }, 'Ja')));
  for (const [name, ic, label] of TABS) {
    navEl.append(h('a', {
      class: 'navb', href: `#/${name}`, 'aria-current': active === name ? 'page' : null,
    }, ic ? icon(ic, { size: 26 }) : glyph('me', { size: 26 }), h('span', null, T(label))));
  }
}

// --------------------------------------------------------------- router

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'today', parts: parts.slice(1), query: new URLSearchParams(qs || '') };
}

let lastHash = location.hash;
let skipNextHash = false;
window.addEventListener('hashchange', () => {
  if (skipNextHash) { skipNextHash = false; lastHash = location.hash; return; }
  if (app.guard && app.guard() && location.hash !== lastHash) {
    const target = location.hash;
    skipNextHash = true;
    history.replaceState(null, '', lastHash);
    leaveDialog().then((leave) => {
      if (!leave) return;
      app.guard = null;
      location.hash = target;
    });
    return;
  }
  lastHash = location.hash;
  render();
});
window.addEventListener('beforeunload', (e) => {
  if (app.guard && app.guard()) { e.preventDefault(); e.returnValue = ''; }
});

function leaveDialog() {
  const T = app.T;
  return confirm({ title: T('leaveTitle'), body: T('leaveBody'), no: T('leaveNo'), yes: T('leaveYes'), danger: true });
}

const VIEWS = {
  today: renderToday,
  reminders: (a, r) => renderToday(a, r, { seg: 'list' }),
  reminder: (a, r) => (r.parts[0] === 'done' ? renderDone(a, r) : renderEditor(a, r)),
  deadlines: renderDeadlines,
  deadline: renderDeadline,
  'deadline-alerts': renderAlertSettings,
  library: renderLibrary,
  file: renderFile,
  me: (a, r) => ({ lang: renderLang, tone: renderTone, help: renderHelp, privacy: renderPrivacy }[r.parts[0]] || renderMe)(a, r),
  welcome: renderWelcome,
};

function render() {
  if (!app.session || !mainEl) return;
  app.route = parseRoute();
  lastHash = location.hash;
  app.view?.destroy?.();
  app.view = null;
  app.guard = null;
  const fn = VIEWS[app.route.name] || renderToday;
  const welcome = app.route.name === 'welcome';
  mainEl.className = `main${welcome ? ' no-nav' : ''}${['deadlines', 'deadline'].includes(app.route.name) || app.route.name === 'today' ? ' wide' : ''}`;
  navEl.hidden = welcome;
  if (!welcome) renderNav(tabOf(app.route.name));
  clear(mainEl);
  clear(fabSlot);
  if (app.preview) mainEl.append(h('p', { class: 'badge-preview' }, app.T('previewBadge')));
  const view = fn(app, app.route) || {};
  app.view = view;
  if (view.el) mainEl.append(view.el);
  if (view.fab) fabSlot.append(view.fab);
  // Move focus to the new screen's heading so screen readers hear the change.
  const heading = mainEl.querySelector('[data-autofocus]');
  if (heading && document.activeElement !== document.body) heading.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

// --------------------------------------------------------------- toast

let toastTimer = null;
function toast(text, { actionLabel, action, ms } = {}) {
  clearTimeout(toastTimer);
  clear(toastEl);
  const el = h('div', { class: 'toast', role: 'status' }, h('span', null, text),
    action ? h('button', { class: 'btn sm', type: 'button', onclick: () => { clear(toastEl); action(); } }, actionLabel) : null);
  toastEl.append(el);
  toastTimer = setTimeout(() => clear(toastEl), ms || (action ? 8000 : 4000));
}

// --------------------------------------------------------------- dialogs

function modal(build, { sheet: asSheet = false, labelId } = {}) {
  return new Promise((resolve) => {
    const scrim = h('div', { class: `scrim${asSheet ? ' sheet-wrap' : ''}` });
    let release = () => {};
    const close = (v) => { release(); scrim.remove(); resolve(v); };
    const box = h('div', { class: `dlg${asSheet ? ' sheet' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelId });
    box.append(build(close));
    scrim.append(box);
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(false); });
    document.body.append(scrim);
    release = trapFocus(box, { onEscape: () => close(false) });
  });
}

let dlgSeq = 0;
/** Yes / no question. `run` (optional) performs the action and keeps the dialog open with a busy label until it settles. */
function confirm({ title, body, yes, no, danger = false, run }) {
  const id = `dlg-${++dlgSeq}`;
  return modal((close) => {
    const yesBtn = h('button', { class: `btn ${danger ? 'dan' : 'pri'}`, type: 'button', style: { flex: '1' } }, yes);
    const noBtn = h('button', { class: 'btn', type: 'button', style: { flex: '1' }, onclick: () => close(false) }, no);
    const err = h('p', { class: 'err-t', role: 'alert', hidden: true });
    yesBtn.addEventListener('click', async () => {
      if (!run) return close(true);
      yesBtn.disabled = true;
      noBtn.disabled = true;
      yesBtn.textContent = app.T('saving');
      try {
        await run();
        close(true);
      } catch (e) {
        yesBtn.disabled = false;
        noBtn.disabled = false;
        yesBtn.textContent = yes;
        err.hidden = false;
        err.textContent = e instanceof ApiError && e.isNetwork ? app.T('tOpFailNet') : app.T('tOpFail');
      }
    });
    return h('div', { class: 'stack', style: { gap: '10px' } },
      h('h2', { id }, title), body ? h('p', null, body) : null, err,
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, noBtn, yesBtn));
  }, { labelId: id });
}

/** Bottom sheet; build(close) returns its content. */
function sheet(build, { title } = {}) {
  const id = `dlg-${++dlgSeq}`;
  return modal((close) => h('div', { class: 'stack', style: { gap: '8px' } },
    h('div', { class: 'top' }, h('h2', { id, class: 'grow', style: { fontSize: '16px' } }, title),
      h('button', { class: 'btn ico', type: 'button', 'aria-label': app.T('close'), onclick: () => close(false) }, glyph('close'))),
    build(close)), { sheet: true, labelId: id });
}

// ------------------------------------------------------- simple screens

function waitBlock(key) {
  const m = createMotion({ T: app.T, kind: 'loading' });
  m.start();
  m.el.querySelector('.status').textContent = app.T(key);
  return m.el;
}

function infoScreen(hKey, bKey) {
  const T = app.T;
  return h('div', { class: 'empty solid', role: 'alert' },
    h('img', { class: 'face', src: '/app/img/mascot-sm.jpg', alt: '' }),
    h('h1', { style: { fontSize: '20px' } }, T(hKey)), h('p', { class: 'sm' }, T(bKey)));
}

function loginScreen(hKey = 'openInLine', bKey = 'openInLineB') {
  const T = app.T;
  return h('div', { class: 'empty solid' },
    h('img', { class: 'face', src: '/app/img/mascot-sm.jpg', alt: '' }),
    h('h1', { style: { fontSize: '20px' } }, T(hKey)), h('p', { class: 'sm' }, T(bKey)),
    h('button', {
      class: 'btn pri blk', type: 'button',
      onclick: async () => {
        try { const liff = await liffInit(); liff.login({ redirectUri: location.href }); } catch (err) { renderBare(fatal(err, signIn)); }
      },
    }, T('loginLine')));
}

function fatal(err, retry) {
  const T = app.T;
  const net = err instanceof ApiError && err.isNetwork;
  return h('div', { class: 'empty bad', role: 'alert' },
    h('img', { src: '/app/img/alert.svg', alt: '', width: 44, height: 44 }),
    h('h1', { style: { fontSize: '20px' } }, T('errLoad')), h('p', { class: 'sm' }, net ? T('errWhyNet') : T('errWhyServer')),
    h('button', { class: 'btn pri blk', type: 'button', onclick: retry }, T('retry')), h('p', { class: 'xs' }, T('reopen')));
}

boot();
