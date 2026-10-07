// Shared widgets: headers, empty / error states, the loading block with the
// mini JaiJa, deadline stubs and planner markers.

import { h, glyph, icon, clear } from './dom.js';
import { createMotion } from './motion.js';
import { ApiError } from './api.js';
import { stubOf } from './model.js';

export function topBar(app, title, { back, extra } = {}) {
  return h('div', { class: 'top' },
    back ? h('button', { class: 'btn ico', type: 'button', 'aria-label': app.T('back'), onclick: () => (typeof back === 'function' ? back() : app.go(back)) }, glyph('back')) : null,
    h('h1', { tabindex: '-1', 'data-autofocus': '' }, title),
    extra || null);
}

export function mascotFace() {
  return h('img', { class: 'face', src: '/app/img/mascot-sm.jpg', alt: '', width: 60, height: 60 });
}

export function emptyState({ title, ex, action }) {
  return h('div', { class: 'empty' }, mascotFace(), h('p', null, h('b', null, title)), ex ? h('p', { class: 'ex' }, ex) : null, action || null);
}

/** The screen for a failed load. Never an empty list. */
export function errorState(app, err, { retry } = {}) {
  const T = app.T;
  const e = err instanceof ApiError ? err : new ApiError('network');
  if (e.status === 409 && e.code === 'not_connected') {
    return h('div', { class: 'empty solid', role: 'alert' },
      h('img', { src: '/app/img/drive.svg', alt: '', width: 48, height: 48 }),
      h('h2', null, T('notConnectedH')), h('p', { class: 'sm muted' }, T('notConnectedB')));
  }
  if (e.status === 409 && e.code === 'drive_disconnected') {
    const url = app.connectUrl;
    return h('div', { class: 'empty solid', role: 'alert' },
      h('img', { src: '/app/img/drive.svg', alt: '', width: 48, height: 48 }),
      h('h2', null, T('driveOffH')), h('p', { class: 'sm muted' }, T('driveOffB')),
      url ? h('a', { class: 'btn pri blk', href: url, target: '_blank', rel: 'noopener' }, T('reconnect')) : h('p', { class: 'xs' }, T('reopen')));
  }
  if (e.status === 404 || e.status === 410) {
    return h('div', { class: 'empty solid', role: 'alert' }, mascotFace(), h('h2', null, T('gone')), h('a', { class: 'btn', href: '#/today' }, T('navToday')));
  }
  if (e.status === 403) {
    return h('div', { class: 'empty solid', role: 'alert' },
      h('img', { src: '/app/img/privacy.svg', alt: '', width: 44, height: 44 }),
      h('h2', null, T('unauthH')), h('p', { class: 'sm' }, T('unauthB')));
  }
  return h('div', { class: 'empty bad', role: 'alert' },
    h('img', { src: '/app/img/alert.svg', alt: '', width: 44, height: 44 }),
    h('h2', null, T('errLoad')),
    h('p', { class: 'sm' }, e.isNetwork ? T('errWhyNet') : T('errWhyServer')),
    retry ? h('button', { class: 'btn pri blk', type: 'button', onclick: retry }, T('retry')) : null,
    h('p', { class: 'xs' }, T('reopen')));
}

/**
 * Load data into a slot with the motion + skeleton, then render it.
 * Re-running cancels the previous request; results from a superseded
 * request are dropped, and destroy() stops everything (navigation).
 */
export function loader(app, { fetch, render, kind = 'loading', skeletons = 3 }) {
  const slot = h('div', { class: 'stack', style: { gap: '14px' } });
  let ctrl = null;
  let motion = null;
  let seq = 0;
  let dead = false;

  const stop = () => {
    ctrl?.abort();
    ctrl = null;
    motion?.destroy();
    motion = null;
  };

  async function run({ quiet = false } = {}) {
    if (dead) return;
    stop();
    const my = ++seq;
    ctrl = new AbortController();
    if (!quiet) {
      clear(slot);
      slot.setAttribute('aria-busy', 'true');
      motion = createMotion({ T: app.T, kind });
      slot.append(motion.el, ...Array.from({ length: skeletons }, () => h('div', { class: 'skel', 'aria-hidden': 'true' })));
      motion.start();
    }
    try {
      const data = await fetch(ctrl.signal);
      if (dead || my !== seq) return;
      motion?.destroy();
      motion = null;
      slot.removeAttribute('aria-busy');
      clear(slot);
      slot.append(render(data, { reload: run }));
    } catch (err) {
      if (dead || my !== seq) return;
      if (err instanceof ApiError && err.kind === 'aborted') return;
      motion?.destroy();
      motion = null;
      slot.removeAttribute('aria-busy');
      if (err instanceof ApiError && err.status === 401) return; // the app re-authenticates
      clear(slot);
      slot.append(errorState(app, err, { retry: () => run() }));
    }
  }

  return { el: slot, run, destroy() { dead = true; stop(); } };
}

export function stubEl(item, app) {
  const s = stubOf(item, app.lang, app.T);
  return h('div', { class: `stub t-${s.tone}`, 'aria-hidden': 'true' },
    h('div', { class: 'b' }, toneMark(s.tone, true)),
    h('div', { class: 'dd' }, s.dd), h('div', { class: 'mm' }, s.mm));
}

const SVGNS = 'http://www.w3.org/2000/svg';
/** Shape icons so urgency never relies on colour alone. */
export function toneMark(tone, onBand = false, size = 14) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const stroke = onBand && tone === 'urgent' ? '#FFFFFF' : tone === 'urgent' && !onBand ? '#B5482F' : (tone === 'closed' || tone === 'nodate') ? '#686458' : '#3B3B3B';
  const paths = {
    urgent: '<path d="M8 1.8 15 14H1z M8 6.2v3.6M8 11.9v.1"/>',
    soon: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.6"/>',
    later: '<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/>',
    applied: '<path d="M3 8.5 6.5 12 13 4.5"/>',
    closed: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    nodate: '<circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.6.3-.8.7-.8 1.3M8 11.6v.1"/>',
  };
  svg.innerHTML = `<g fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[tone] || paths.later}</g>`;
  return svg;
}

export function countdownEl(item, tone, text) {
  return h('span', { class: `cd ${tone}` }, toneMark(item.status === 'applied' ? 'applied' : tone, false, 16), text);
}

export function markers({ r, d, e, f }) {
  return h('span', { class: 'mk', 'aria-hidden': 'true' }, r ? h('i', { class: 'mr' }) : null, d ? h('i', { class: 'md' }) : null, e ? h('i', { class: 'me' }) : null, f ? h('i', { class: 'mf' }) : null);
}

export function legend(T) {
  return h('div', { class: 'legend', 'aria-label': T('legend') },
    h('span', null, h('i', { class: 'mr lg-i' }), T('lgRem')),
    h('span', null, h('i', { class: 'md lg-i' }), 'Deadline'),
    h('span', null, h('i', { class: 'me lg-i' }), T('lgEv')),
    h('span', null, h('i', { class: 'mf lg-i' }), T('lgSaved')));
}

export function banner(kind, { iconSrc, title, body }) {
  return h('div', { class: `banner ${kind}`, role: kind === 'err' ? 'alert' : 'status' },
    iconSrc ? h('img', { src: iconSrc, alt: '' }) : h('span'),
    h('div', null, title ? h('b', null, title) : null, body ? h('p', { class: 'sm' }, body) : null));
}

export { icon, glyph };
