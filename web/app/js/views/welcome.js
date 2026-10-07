// First open: product promise, ไทย / English, short fictional chat demos and
// a brief wave. The choice is saved to the server for this LINE user.

import { h, uid } from '../dom.js';
import { api, ApiError } from '../api.js';
import { translator } from '../../../shared/i18n.js';
import { createMotion } from '../motion.js';

export function renderWelcome(app) {
  let lang = app.lang;
  let T = translator(lang);
  const el = h('div', { class: 'stack', style: { gap: '16px' } });
  const motion = createMotion({ T, kind: 'working' });
  const err = h('p', { class: 'err-t', role: 'alert', hidden: true });

  function paint() {
    el.replaceChildren();
    T = translator(lang);
    document.documentElement.lang = lang;
    el.append(h('div', { class: 'stack', style: { alignItems: 'center', textAlign: 'center', gap: '12px', paddingTop: '20px' } },
      h('img', { src: '/app/img/mascot.jpg', alt: 'JaiJa', width: 140, height: 140, style: { width: '140px', height: '140px', borderRadius: '50%', border: '3px solid #3B3B3B', boxShadow: '0 5px 0 #8B9270' } }),
      h('h1', { style: { fontSize: '28px' }, tabindex: '-1', 'data-autofocus': '' }, T('obHi')),
      h('p', { style: { fontSize: '22px', fontWeight: '700' } }, T('p1'), ' ', h('span', { style: { color: '#62694D' } }, T('p2')), ' ', T('p3')),
      h('p', { class: 'sm' }, T('obSub'))));

    const name = uid('oblang');
    const fs = h('fieldset', null, h('legend', { class: 'lg' }, T('obLang')));
    for (const [code, label] of [['th', 'ไทย'], ['en', 'English']]) {
      const inp = h('input', { type: 'radio', name, checked: lang === code });
      inp.addEventListener('change', () => { lang = code; paint(); el.querySelector(`input[name="${name}"]`)?.focus(); });
      fs.append(h('label', { class: 'rc', lang: code }, inp, h('span', null, h('b', null, label))));
    }
    el.append(fs);

    const demo = (q, a) => h('div', { class: 'demo' }, h('p', { class: 'bub me' }, q), h('div', { class: 'speech' }, h('img', { src: '/app/img/mascot-sm.jpg', alt: '' }), h('p', { class: 'bub' }, a)));
    el.append(h('section', { class: 'panel', 'aria-label': T('demoH') }, h('h2', { style: { fontSize: '16px' } }, T('demoH')),
      demo(T('demoFileQ'), T('demoFileA')), demo(T('demoFindQ'), T('demoFindA')), demo(T('demoMemQ'), T('demoMemA')), demo(T('demoDlQ'), T('demoDlA'))));

    const start = h('button', { class: 'btn pri blk big', type: 'button' }, T('obStart'));
    start.addEventListener('click', async () => {
      start.disabled = true;
      start.textContent = T('saving');
      err.hidden = true;
      try {
        const r = await api.put('/prefs', { lang });
        app.session.prefs = r.prefs;
        app.setLang(lang);
        app.go('today', { replace: true });
      } catch (e) {
        start.disabled = false;
        start.textContent = T('obStart');
        err.hidden = false;
        err.textContent = e instanceof ApiError && e.isNetwork ? T('tOpFailNet') : T('tOpFail');
      }
    });
    el.append(err, start, h('p', { class: 'xs muted' }, T('obNote')));
  }

  paint();
  // A short wave on first open only; static with reduced motion.
  const waveSlot = h('div', { 'aria-hidden': 'true' }, motion.el);
  el.insertBefore(waveSlot, el.children[1] || null);
  motion.wave();
  return { el, destroy: () => motion.destroy() };
}
