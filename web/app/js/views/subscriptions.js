// ค่าสมาชิกและทดลองใช้: what keeps charging the card, free trials with their
// end dates, the questions about new charges, the editor, and how to let
// bank e-mails and SMS reach JaiJa (the private forwarding link).
// Personal only: the server refuses these routes for group libraries.

import { h, clear, glyph, icon, uid } from '../dom.js';
import { api, ApiError } from '../api.js';
import { formatDay, isDayKey } from '../../../shared/dates.js';
import { formatMoney, formatPrice } from '../../../shared/money.js';
import { topBar, loader, emptyState, banner } from '../ui.js';
import { gmailScript } from '../gmailScript.js';

const CURRENCIES = ['THB', 'USD', 'EUR', 'GBP', 'JPY', 'SGD'];

/** Urgency of a subscription's next date, the same scale as deadlines. */
export function subTone(x) {
  if (x.status === 'cancelled') return 'closed';
  if (x.daysLeft === null || x.daysLeft === undefined) return 'nodate';
  if (x.daysLeft <= 1) return 'urgent';
  if (x.daysLeft <= 3) return 'soon';
  return 'later';
}

/** "หมดพรุ่งนี้" / "Charges in 5 days" (bot wording, shared dictionary). */
export function subCountdownText(x, T) {
  const n = x.daysLeft;
  if (x.status === 'cancelled') return T('b_sub_secCancelled');
  if (n === null || n === undefined) return x.status === 'trial' ? T('b_sub_secTrials') : T('b_sub_noDate');
  if (x.status === 'trial') {
    if (n < 0) return T('b_sub_trialOver');
    if (n === 0) return T('b_sub_endsToday');
    if (n === 1) return T('b_sub_endsTomorrow');
    return T('b_sub_endsIn', { n });
  }
  if (n <= 0) return T('b_sub_chargesToday');
  if (n === 1) return T('b_sub_chargesTomorrow');
  return T('b_sub_chargesIn', { n });
}

const priceText = (x, lang, T) => formatPrice(x.amount, x.currency, x.cycle, lang) || T(`b_sub_cycle_${['monthly', 'yearly', 'weekly'].includes(x.cycle) ? x.cycle : 'unknown'}`);
const nextOn = (x) => (x.status === 'trial' ? x.trialEndsOn : x.status === 'active' ? x.nextChargeOn : '');

function stub(x, lang) {
  const on = nextOn(x);
  const tone = subTone(x);
  return h('div', { class: `stub t-${tone}`, 'aria-hidden': 'true' },
    h('div', { class: 'b' }, icon('card', { size: 16 })),
    h('div', { class: 'dd' }, on ? String(Number(on.slice(8))) : '?'),
    h('div', { class: 'mm' }, on ? formatDay(on, lang, 'mon') : '–'));
}

// ------------------------------------------------------------------ list

export function renderSubscriptions(app) {
  const T = app.T;
  const lang = app.lang;
  const el = h('div', { class: 'stack', style: { gap: '14px' } });
  el.append(topBar(app, T('subsTitle'), { back: 'me' }));
  const l = loader(app, { fetch: (signal) => api.get('/subscriptions', { signal }), render: (data) => body(data), skeletons: 3 });
  el.append(l.el);
  l.run();
  const fab = h('a', { class: 'btn pri fab', href: '#/subscription/new' }, glyph('plus', { size: 20 }), T('subsAdd'));
  fab.querySelector('img').style.filter = 'brightness(0) invert(1)';

  function body(data) {
    const wrap = h('div', { class: 'stack', style: { gap: '14px' } });
    wrap.append(h('p', null, T('subsIntro')));

    if (data.pending.length) {
      wrap.append(h('h2', null, T('subsPendingH')));
      for (const p of data.pending) wrap.append(pendingCard(p));
    }

    const trials = data.items.filter((x) => x.status === 'trial');
    const active = data.items.filter((x) => x.status === 'active');
    const cancelled = data.items.filter((x) => x.status === 'cancelled');
    const totals = Object.entries(data.totals || {});
    wrap.append(h('section', { class: 'card' },
      h('b', { style: { fontSize: '20px' } }, totals.length ? T('b_sub_total', { list: totals.map(([c, v]) => formatPrice(v, c, 'monthly', lang)).join(' + ') }) : T('subsCountLine', { t: trials.length, a: active.length })),
      totals.length ? h('p', { class: 'sm' }, T('subsCountLine', { t: trials.length, a: active.length })) : null,
      h('p', { class: 'xs muted' }, T('subsTotalNote'))));

    if (!data.items.length) wrap.append(emptyState({ title: T('b_sub_listEmpty'), ex: T('subsHowAdd'), action: h('a', { class: 'btn', href: '#/subscription/new' }, T('subsAdd')) }));
    if (trials.length) wrap.append(h('h2', null, T('b_sub_secTrials')), ...trials.map(row));
    if (active.length) wrap.append(h('h2', null, T('b_sub_secActive')), ...active.map(row));
    if (cancelled.length) {
      const list = h('div', { class: 'stack', hidden: true }, cancelled.map(row));
      const toggle = h('button', { class: 'btn sm', type: 'button', 'aria-expanded': 'false', onclick: () => {
        list.hidden = !list.hidden;
        toggle.setAttribute('aria-expanded', String(!list.hidden));
      } }, T('subsShowCancelled', { n: cancelled.length }));
      wrap.append(toggle, list);
    }
    if (data.items.length) wrap.append(h('p', { class: 'xs muted' }, T('subsHowAdd')));

    const on = data.hook?.enabled;
    wrap.append(h('section', { class: 'card' },
      h('h2', { class: 'row', style: { gap: '8px', fontSize: '17px' } }, icon('card', { size: 20 }), T('subsConnH'),
        on === null ? null : h('span', { class: `tag${on ? '' : ' plain'}` }, on ? T('subsConnOn') : T('subsConnOff'))),
      h('p', { class: 'sm' }, T('subsConnB')),
      h('a', { class: 'btn', href: '#/subscriptions/connect' }, T('subsConnSet'))));
    return wrap;
  }

  function row(x) {
    const tone = subTone(x);
    const remind = x.status === 'cancelled' ? '' : x.remind ? (x.status === 'trial' ? T('subsRemindTrial') : T('subsRemindOn')) : T('subsNoRemind');
    return h('a', { class: 'it', href: `#/subscription/${encodeURIComponent(x.id)}`, style: { textDecoration: 'none', gridTemplateColumns: '58px 1fr' } },
      stub(x, lang),
      h('div', { class: 'stack', style: { gap: '2px' } },
        h('b', { style: { overflowWrap: 'anywhere' } }, x.name),
        h('span', { class: `cd ${tone}` }, subCountdownText(x, T)),
        h('span', { class: 'sm' }, priceText(x, lang, T)),
        remind ? h('span', { class: 'xs muted' }, remind) : null));
  }

  function pendingCard(p) {
    const c = p.charge;
    const name = c.service || c.merchant;
    const reason = T(`b_sub_reason_${p.reason}`, { date: c.on ? formatDay(c.on, lang, 'dm') : '' });
    const facts = [c.on ? formatDay(c.on, lang, 'dm') : '', c.time, c.cardLast4 ? T('b_sub_card', { d: c.cardLast4 }) : ''].filter(Boolean).join(' · ');
    const actions = h('div', { class: 'row' });
    const status = h('p', { class: 'sm', role: 'status' });
    const answer = (action, cycle) => async (e) => {
      const btns = actions.querySelectorAll('button');
      btns.forEach((b) => { b.disabled = true; });
      const btn = e.currentTarget;
      const label = btn.textContent;
      btn.textContent = T('saving');
      try {
        const r = await api.post(`/subscriptions/pending/${encodeURIComponent(p.id)}`, cycle ? { action, cycle } : { action });
        if (action === 'track') app.toast(T('tSubTracked', { name: r.item?.name || name }));
        else if (action === 'once') app.toast(T('tSubOnce', { merchant: c.merchant }));
        else await advice(c);
        l.run({ quiet: true });
      } catch (err) {
        btns.forEach((b) => { b.disabled = false; });
        btn.textContent = label;
        if (err instanceof ApiError && err.status === 404) { app.toast(T('b_sub_gone')); l.run({ quiet: true }); return; }
        status.textContent = err instanceof ApiError && err.isNetwork ? T('tOpFailNet') : T('tOpFail');
      }
    };
    actions.append(
      h('button', { class: 'btn pri', type: 'button', onclick: answer('track', 'monthly') }, T('b_sub_btnMonthly')),
      h('button', { class: 'btn', type: 'button', onclick: answer('track', 'yearly') }, T('b_sub_btnYearly')),
      h('button', { class: 'btn', type: 'button', onclick: answer('once') }, T('b_sub_btnOnce')),
      h('button', { class: 'btn ghost', type: 'button', 'aria-haspopup': 'dialog', onclick: answer('unknown') }, T('b_sub_btnUnknown')));
    return h('article', { class: 'card', style: { boxShadow: 'inset 5px 0 0 var(--soon), 0 3px 0 var(--ink)' } },
      h('b', { style: { fontSize: '24px' } }, formatMoney(c.amount, c.currency, lang) || '–'),
      h('b', { style: { overflowWrap: 'anywhere' } }, name),
      facts ? h('p', { class: 'sm muted' }, facts) : null,
      reason ? h('p', { class: 'sm' }, reason) : null,
      h('p', { class: 'sm' }, T('b_sub_question')),
      actions, status);
  }

  function advice(c) {
    return app.sheet(() => h('div', { class: 'stack' },
      h('p', { style: { whiteSpace: 'pre-line' } }, T('b_sub_unknownAdvice', { price: formatMoney(c.amount, c.currency, lang), merchant: c.merchant }))), { title: T('subsAdviceH') });
  }

  return { el, fab, destroy: () => l.destroy() };
}

// ---------------------------------------------------------------- editor

export function renderSubEditor(app, route) {
  const T = app.T;
  const lang = app.lang;
  const id = route.parts[0] && route.parts[0] !== 'new' ? route.parts[0] : null;
  const el = h('div', { class: 'stack', style: { gap: '14px' } });
  const form = { name: '', status: 'trial', amount: '', currency: 'THB', cycle: 'monthly', trialEndsOn: '', nextChargeOn: '', remind: true, remindTouched: false, note: '', dirty: false, errors: {}, item: null };
  app.setGuard(() => form.dirty);
  const back = async () => {
    if (form.dirty) {
      const ok = await app.confirm({ title: T('leaveTitle'), body: T('leaveBody'), no: T('leaveNo'), yes: T('leaveYes'), danger: true });
      if (!ok) return;
    }
    app.setGuard(null);
    app.go('subscriptions');
  };
  el.append(topBar(app, id ? T('subEdEdit') : T('subEdNew'), { back }));
  const slot = h('div', { class: 'stack', style: { gap: '14px' } });
  el.append(slot);

  if (id) {
    const l = loader(app, {
      fetch: async (signal) => {
        const data = await api.get('/subscriptions', { signal });
        const item = data.items.find((x) => x.id === id);
        if (!item) throw new ApiError('http', { status: 404, code: 'not_found' });
        return item;
      },
      render: (item) => {
        Object.assign(form, {
          item, name: item.name, status: item.status, amount: item.amount ? String(item.amount) : '', currency: item.currency, cycle: item.cycle === 'unknown' ? 'monthly' : item.cycle,
          trialEndsOn: item.trialEndsOn, nextChargeOn: item.nextChargeOn, remind: item.remind, remindTouched: true, note: item.note || '',
        });
        return editor();
      },
    });
    slot.append(l.el);
    l.run();
    return { el, destroy: () => l.destroy() };
  }
  slot.append(editor());
  return { el };

  function editor() {
    const wrap = h('div', { class: 'stack', style: { gap: '14px' } });
    const err = (k) => h('p', { class: 'err-t', id: `${k}-err`, hidden: true });
    const errs = { name: err('sub-name'), amount: err('sub-amount'), trialEndsOn: err('sub-trial'), nextChargeOn: err('sub-next') };
    const bannerSlot = h('div');
    const nameId = uid('sub-name');
    const nameInp = h('input', { id: nameId, class: 'inp', type: 'text', maxlength: 60, placeholder: T('subNamePh'), value: form.name, autocomplete: 'off', 'aria-describedby': 'sub-name-err' });
    nameInp.addEventListener('input', () => { form.name = nameInp.value; form.dirty = true; });
    wrap.append(h('div', { class: 'field' }, h('label', { for: nameId }, T('subName')), nameInp, errs.name));

    // Status
    const statusSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': T('subStatus') });
    const states = id ? [['trial', 'subStTrial'], ['active', 'subStActive'], ['cancelled', 'subStCancelled']] : [['trial', 'subStTrial'], ['active', 'subStActive']];
    const paintStatus = () => {
      clear(statusSeg);
      for (const [k, label] of states) {
        statusSeg.append(h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(form.status === k), class: form.status === k ? 'on' : '',
          onclick: () => {
            form.status = k;
            form.dirty = true;
            if (!form.remindTouched) form.remind = k === 'trial' || form.cycle === 'yearly';
            paintStatus();
            paintDates();
          },
        }, h('span', null, T(label))));
      }
    };
    wrap.append(h('div', { class: 'field' }, h('span', { class: 'lg' }, T('subStatus')), statusSeg));

    // Price, currency, cycle
    const amtId = uid('sub-amount');
    const amtInp = h('input', { id: amtId, class: 'inp', type: 'text', inputmode: 'decimal', value: form.amount, placeholder: '0', 'aria-describedby': 'sub-amount-err', style: { flex: '1' } });
    amtInp.addEventListener('input', () => { form.amount = amtInp.value; form.dirty = true; });
    const curId = uid('sub-cur');
    const curSel = h('select', { id: curId, class: 'inp', 'aria-label': T('subCurrency'), style: { width: '110px', flex: 'none' } }, CURRENCIES.map((c) => h('option', { value: c, selected: form.currency === c }, c)));
    curSel.addEventListener('change', () => { form.currency = curSel.value; form.dirty = true; });
    wrap.append(h('div', { class: 'field' }, h('label', { for: amtId }, T('subPrice')), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, amtInp, curSel), errs.amount));
    const cycleChips = h('div', { class: 'chips wrap', role: 'radiogroup', 'aria-label': T('subCycle') });
    const paintCycle = () => {
      clear(cycleChips);
      for (const [k, label] of [['monthly', 'subCyMonthly'], ['yearly', 'subCyYearly'], ['weekly', 'subCyWeekly']]) {
        cycleChips.append(h('button', {
          type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(form.cycle === k),
          onclick: () => {
            form.cycle = k;
            form.dirty = true;
            if (!form.remindTouched) form.remind = form.status === 'trial' || k === 'yearly';
            paintCycle();
            paintDates();
          },
        }, T(label)));
      }
    };
    wrap.append(h('div', { class: 'field' }, h('span', { class: 'lg' }, T('subCycle')), cycleChips));

    // Dates and reminder (depend on status)
    const dateSlot = h('div', { class: 'stack', style: { gap: '14px' } });
    wrap.append(dateSlot);
    function paintDates() {
      clear(dateSlot);
      if (form.status === 'trial' || form.status === 'active') {
        const trial = form.status === 'trial';
        const key = trial ? 'trialEndsOn' : 'nextChargeOn';
        const dId = uid('sub-date');
        const dInp = h('input', { id: dId, class: 'inp', type: 'date', value: form[key], min: trial ? undefined : app.today(), 'aria-describedby': `${trial ? 'sub-trial' : 'sub-next'}-err` });
        dInp.addEventListener('input', () => { form[key] = dInp.value; form.dirty = true; });
        dateSlot.append(h('div', { class: 'field' }, h('label', { for: dId }, trial ? T('subTrialEnd') : T('subNextCharge')), dInp,
          h('p', { class: 'xs muted' }, trial ? T('subTrialEndHint') : T('subNextHint')), trial ? errs.trialEndsOn : errs.nextChargeOn));
        const rId = uid('sub-remind');
        const r = h('input', { id: rId, type: 'checkbox', checked: form.remind });
        r.addEventListener('change', () => { form.remind = r.checked; form.remindTouched = true; form.dirty = true; });
        dateSlot.append(h('label', { class: 'rc', for: rId }, r, h('span', null, h('b', null, trial ? T('subRemindTrial') : T('subRemind')), h('small', null, trial ? T('subTrialEndHint') : T('subRemindSub')))));
      }
      const noteId = uid('sub-note');
      const noteInp = h('input', { id: noteId, class: 'inp', type: 'text', maxlength: 200, value: form.note, autocomplete: 'off' });
      noteInp.addEventListener('input', () => { form.note = noteInp.value; form.dirty = true; });
      dateSlot.append(h('div', { class: 'field' }, h('label', { for: noteId }, T('subNote')), noteInp));
      if (form.item?.charges?.length) {
        dateSlot.append(h('section', { class: 'panel' }, h('b', null, T('subHistory')),
          ...form.item.charges.slice().reverse().map((c) => h('p', { class: 'sm' }, `${formatDay(c.on, lang, 'dmy')} · ${formatMoney(c.amount, c.currency, lang)}`))));
      }
    }

    const save = h('button', { class: 'btn pri blk big', type: 'button' }, T('save'));
    const status = h('p', { class: 'sm', role: 'status' });
    save.addEventListener('click', async () => {
      const E = validate();
      showErrors(E);
      if (Object.keys(E).length) return;
      save.disabled = true;
      save.textContent = T('saving');
      status.textContent = '';
      const body = {
        name: form.name.trim(), status: form.status, amount: Number(form.amount || 0), currency: form.currency, cycle: form.cycle, note: form.note,
        ...(form.status === 'trial' ? { trialEndsOn: form.trialEndsOn || '' } : {}),
        ...(form.status === 'active' ? { nextChargeOn: form.nextChargeOn || '' } : {}),
        ...(form.status !== 'cancelled' ? { remind: form.remind } : {}),
      };
      try {
        if (id) await api.patch(`/subscriptions/${encodeURIComponent(id)}`, body);
        else await api.post('/subscriptions', body);
        form.dirty = false;
        app.setGuard(null);
        app.toast(T('tSubSaved'));
        app.go('subscriptions');
      } catch (e) {
        save.disabled = false;
        save.textContent = T('save');
        if (e instanceof ApiError && e.status === 400 && e.body?.fields) { showErrors(Object.fromEntries(Object.keys(e.body.fields).map((k) => [k, true]))); return; }
        status.textContent = e instanceof ApiError && e.isNetwork ? T('tOpFailNet') : T('tOpFail');
      }
    });

    function validate() {
      const E = {};
      if (!form.name.trim()) E.name = true;
      const n = Number(String(form.amount || '0').replace(/,/g, ''));
      if (!Number.isFinite(n) || n < 0) E.amount = true;
      else form.amount = String(form.amount || '').replace(/,/g, '');
      if (form.status === 'trial' && form.trialEndsOn && !isDayKey(form.trialEndsOn)) E.trialEndsOn = true;
      if (form.status === 'active' && form.nextChargeOn && !isDayKey(form.nextChargeOn)) E.nextChargeOn = true;
      return E;
    }

    function showErrors(E) {
      const msg = { name: T('subErrName'), amount: T('subErrAmount'), trialEndsOn: T('subErrDate'), nextChargeOn: T('subErrDate') };
      for (const [k, p] of Object.entries(errs)) {
        p.hidden = !E[k];
        p.textContent = E[k] ? `! ${msg[k]}` : '';
      }
      nameInp.setAttribute('aria-invalid', String(Boolean(E.name)));
      amtInp.setAttribute('aria-invalid', String(Boolean(E.amount)));
      clear(bannerSlot);
      if (Object.keys(E).length) bannerSlot.append(banner('err', { iconSrc: '/app/img/alert.svg', title: T('edErrSum') }));
    }

    paintStatus();
    paintCycle();
    paintDates();
    wrap.prepend(bannerSlot);
    wrap.append(status, save);
    if (id) {
      const del = h('button', { class: 'btn dan', type: 'button', 'aria-haspopup': 'dialog' }, T('subDelete'));
      del.addEventListener('click', async () => {
        const ok = await app.confirm({ title: T('subDelQ', { name: form.item?.name || form.name }), body: T('subDelB'), no: T('cancelL'), yes: T('subDelete'), danger: true, run: () => api.del(`/subscriptions/${encodeURIComponent(id)}`) });
        if (ok) { form.dirty = false; app.setGuard(null); app.toast(T('tSubDeleted')); app.go('subscriptions'); }
      });
      wrap.append(del);
    }
    return wrap;
  }
}

// --------------------------------------------------------------- connect

export function renderConnect(app) {
  const T = app.T;
  const el = h('div', { class: 'stack', style: { gap: '14px' } });
  el.append(topBar(app, T('connTitle'), { back: 'subscriptions' }));
  el.append(h('section', { class: 'card' },
    h('ol', { class: 'stack', style: { gap: '6px', paddingLeft: '20px', margin: 0 } }, ['connHow1', 'connHow2', 'connHow3'].map((k) => h('li', { class: 'sm' }, T(k))))),
  h('section', { class: 'panel' }, h('b', null, T('connWhat')), h('p', { class: 'sm' }, T('connPrivacy'))));
  const l = loader(app, { fetch: (signal) => api.get('/money-hook', { signal }), render: (hook) => body(hook), skeletons: 2 });
  el.append(l.el);
  l.run();
  let tab = app.route.query.get('tab') || 'gmail';

  function copyField(label, value) {
    const fid = uid('copy');
    const inp = h('input', { id: fid, class: 'inp', type: 'text', readonly: true, value, style: { fontFamily: 'ui-monospace,monospace', fontSize: '13px' } });
    inp.addEventListener('focus', () => inp.select());
    return h('div', { class: 'field' }, h('label', { for: fid }, label), h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, inp, copyBtn(() => value)));
  }

  function copyBtn(get, label = T('connCopy')) {
    const b = h('button', { class: 'btn sm', type: 'button', style: { flex: 'none', whiteSpace: 'nowrap' } }, label);
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(get());
        app.toast(T('connCopied'));
      } catch {
        app.toast(T('connCopyFail'));
      }
    });
    return b;
  }

  function body(hook) {
    const wrap = h('div', { class: 'stack', style: { gap: '14px' } });
    const status = h('p', { class: 'sm', role: 'status' });
    const act = (action, confirmText) => async () => {
      if (confirmText) {
        const ok = await app.confirm({ ...confirmText, no: T('cancelL'), danger: action === 'disable', run: () => api.post('/money-hook', { action }) });
        if (ok) l.run({ quiet: true });
        return;
      }
      try {
        await api.post('/money-hook', { action });
        l.run({ quiet: true });
      } catch (e) {
        status.textContent = e instanceof ApiError && e.isNetwork ? T('tOpFailNet') : T('tOpFail');
      }
    };
    if (!hook.enabled) {
      wrap.append(h('section', { class: 'card' }, h('p', { class: 'sm' }, T('subsConnB')),
        h('button', { class: 'btn pri blk', type: 'button', onclick: act('enable') }, T('connEnable')), status));
      return wrap;
    }
    const test = h('button', { class: 'btn', type: 'button' }, T('connTest'));
    test.addEventListener('click', async () => {
      test.disabled = true;
      try {
        // Same origin as this page, so the check works whatever PUBLIC_URL is.
        const r = await fetch('/hooks/money', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hook.token}` }, body: JSON.stringify({ test: true }), credentials: 'omit' });
        const j = await r.json().catch(() => null);
        status.textContent = r.ok && j?.outcome === 'test' ? T('connTestOk') : T('connTestFail');
      } catch {
        status.textContent = T('connTestFail');
      } finally {
        test.disabled = false;
      }
    });
    wrap.append(h('section', { class: 'card' },
      h('h2', { class: 'row', style: { gap: '8px', fontSize: '17px' } }, icon('card', { size: 20 }), T('subsConnH'), h('span', { class: 'tag' }, T('subsConnOn'))),
      copyField(T('connUrl'), hook.url),
      copyField(T('connToken'), hook.token),
      copyField(T('connPathUrl'), hook.pathUrl),
      h('p', { class: 'xs', style: { background: 'var(--warn)', borderRadius: '10px', padding: '6px 10px' } }, T('connKeepSecret')),
      h('div', { class: 'row' }, test,
        h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'dialog', onclick: act('regenerate', { title: T('connRegenQ'), body: T('connRegenB'), yes: T('connRegen') }) }, T('connRegen')),
        h('button', { class: 'btn dan', type: 'button', 'aria-haspopup': 'dialog', onclick: act('disable', { title: T('connOffQ'), body: T('connOffB'), yes: T('connOff') }) }, T('connOff'))),
      status));

    // Setup steps per source.
    const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': T('connSetupH') });
    const panel = h('section', { class: 'card', role: 'tabpanel' });
    const paint = () => {
      clear(seg);
      for (const [k, label] of [['gmail', 'connTabGmail'], ['iphone', 'connTabIphone'], ['android', 'connTabAndroid']]) {
        seg.append(h('button', { role: 'tab', type: 'button', class: tab === k ? 'on' : '', 'aria-selected': String(tab === k), onclick: () => { tab = k; app.setQuery({ tab: k === 'gmail' ? null : k }); paint(); } }, h('span', null, T(label))));
      }
      clear(panel);
      const steps = { gmail: ['connGmail1', 'connGmail2', 'connGmail3', 'connGmail4'], iphone: ['connIphone1', 'connIphone2', 'connIphone3', 'connIphone4'], android: ['connAndroid1', 'connAndroid2', 'connAndroid3'] }[tab];
      panel.append(h('ol', { class: 'stack', style: { gap: '6px', paddingLeft: '20px', margin: 0 } }, steps.map((k) => h('li', { class: 'sm' }, T(k)))));
      if (tab === 'gmail') {
        const code = gmailScript({ url: hook.url, token: hook.token });
        panel.append(
          h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '12px', lineHeight: '1.45', background: '#FFFFFF', border: '2px solid var(--ink)', borderRadius: '10px', padding: '10px', margin: 0, maxHeight: '320px', overflow: 'auto' }, tabindex: '0', 'aria-label': 'Apps Script' }, code),
          copyBtn(() => code, T('connScriptCopy')),
          h('p', { class: 'xs muted' }, T('connGmailNote')));
      }
    };
    paint();
    wrap.append(h('h2', null, T('connSetupH')), seg, panel);
    return wrap;
  }

  return { el, destroy: () => l.destroy() };
}

/** Subscription rows for a planner day (Today). */
export function subsOnDay(data, k) {
  return (data.subscriptions?.items || []).filter((x) => x.on === k);
}
