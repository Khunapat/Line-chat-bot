// Reminder editor (new / change time) and the "reminder set" screen.
// Order: what → date and time → once or repeat (repeat options appear only
// when asked for). Nothing is saved until the summary is confirmed, and a
// failed save keeps every field; retries reuse the same idempotency key.

import { h, clear, glyph, icon, uid } from '../dom.js';
import { api, newKey, ApiError } from '../api.js';
import { addDays, formatDay, formatTime, formatDateTime, zoned, zonedToUtc, isDayKey, parseKey, WEEKDAY_NAMES } from '../../../shared/dates.js';
import { parseTime, parseNatural } from '../timeparse.js';
import { repeatSummary, nextLine, monthEndNote } from '../model.js';
import { topBar, banner, errorState } from '../ui.js';
import { createMotion } from '../motion.js';

export function renderEditor(app, route) {
  const T = app.T;
  const lang = app.lang;
  const today = app.today();
  const editId = route.parts[0] && route.parts[0] !== 'new' ? route.parts[0] : null;
  const el = h('div', { class: 'stack', style: { gap: '14px' } });
  let destroyed = false;
  let motion = null;

  const form = {
    text: '', day: '', timeRaw: '', hm: '', amb: null, dayImplicit: false,
    isRepeat: false, repeat: 'daily', errors: {}, dirty: false, key: newKey(), pending: false, failed: null, orig: null, nlMsg: '',
  };
  const qDay = route.query.get('day');
  if (isDayKey(qDay || '') && qDay >= today) form.day = qDay;

  app.setGuard(() => form.dirty && !form.pending);
  const leave = async () => {
    if (form.dirty) {
      const ok = await app.confirm({ title: T('leaveTitle'), body: T('leaveBody'), no: T('leaveNo'), yes: T('leaveYes'), danger: true });
      if (!ok) return;
    }
    app.setGuard(null);
    app.go('reminders');
  };

  el.append(topBar(app, editId ? T('edTime') : T('edNew'), { back: leave }));
  const body = h('div', { class: 'stack', style: { gap: '14px' } });
  el.append(body);

  function setField(patch) {
    Object.assign(form, patch, { dirty: true });
    refresh();
  }

  // Parts rebuilt on every change, without touching the inputs being typed in.
  const summarySlot = h('section', { class: 'card', 'aria-live': 'polite' });
  const bannerSlot = h('div', { class: 'stack' });
  const ambSlot = h('div');
  const whenErr = h('p', { class: 'err-t', hidden: true });
  const textErr = h('p', { class: 'err-t', hidden: true });
  const freqSlot = h('div', { class: 'stack' });
  const repeatSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': T('freq') });
  const dayChips = h('div', { class: 'chips' });
  const hmChips = h('div', { class: 'chips' });
  const submit = h('button', { class: 'btn pri blk big', type: 'button' });
  const statusSlot = h('div');
  const textId = uid('rem-text');
  const dayId = uid('rem-day');
  const hmId = uid('rem-hm');
  const textInp = h('input', { id: textId, class: 'inp', type: 'text', maxlength: 300, placeholder: T('taskPh'), autocomplete: 'off', 'aria-describedby': `${textId}-err` });
  textErr.id = `${textId}-err`;
  const dayInp = h('input', { id: dayId, class: 'inp', type: 'date', min: today });
  const hmInp = h('input', { id: hmId, class: 'inp', type: 'text', inputmode: 'text', placeholder: T('timePh'), autocomplete: 'off', 'aria-describedby': `${hmId}-err` });
  whenErr.id = `${hmId}-err`;

  function draft() {
    if (!form.day || !form.hm) return null;
    return { at: zonedToUtc(form.day, form.hm, app.tz), repeat: editId ? form.repeat : (form.isRepeat ? form.repeat : 'none'), anchorDay: parseKey(form.day).d };
  }

  function refresh() {
    if (destroyed) return;
    const d = draft();
    // Summary: exact date, time, zone, repeat and where it will be sent.
    clear(summarySlot);
    summarySlot.append(h('h2', { class: 'row', style: { gap: '6px', fontSize: '16px' } }, icon('check'), T('summary')));
    summarySlot.append(h('p', null, h('b', { style: { overflowWrap: 'anywhere' } }, `“${form.text.trim() || '…'}”`)));
    if (d) {
      summarySlot.append(h('p', null, repeatSummary(d, { lang, T, tz: app.tz })));
      const nl = d.repeat !== 'none' ? nextLine(d, { lang, T, tz: app.tz, now: app.now() }) : '';
      if (nl) summarySlot.append(h('p', { class: 'sm' }, nl));
      if (editId && form.orig) summarySlot.append(h('p', { class: 'sm' }, T('wasAt', { when: formatDateTime(form.orig.at, lang, app.tz) })));
      const note = monthEndNote(d, { T, tz: app.tz });
      if (note) summarySlot.append(h('p', { class: 'sm', style: { background: '#F6E7CB', borderRadius: '10px', padding: '6px 10px' } }, note));
      const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (device && device !== app.tz) summarySlot.append(h('p', { class: 'xs' }, T('localEq', { when: `${formatDateTime(d.at, lang, device)} (${device})` })));
    } else {
      summarySlot.append(h('p', { class: 'muted' }, T('sumEmpty')));
    }
    summarySlot.append(h('p', { class: 'xs muted' }, `${T('destPrivate')} · ${app.tz === 'Asia/Bangkok' ? T('tzLabel', { tz: app.tz }) : T('tzOther', { tz: app.tz })}`));

    // Errors.
    const E = form.errors;
    clear(bannerSlot);
    if (form.failed) bannerSlot.append(banner('err', { iconSrc: '/app/img/alert.svg', title: T('edFail'), body: form.failed === 'net' ? T('edFailNet') : T('edFailServer') }));
    if (Object.values(E).some(Boolean)) bannerSlot.append(banner('err', { iconSrc: '/app/img/alert.svg', title: T('edErrSum') }));
    textErr.hidden = !E.text;
    textErr.textContent = E.text ? `! ${T('errText')}` : '';
    textInp.setAttribute('aria-invalid', String(Boolean(E.text)));
    const whenMsg = E.past ? T('errPast') : E.time ? T('errTime') : E.when ? T('errWhen') : '';
    whenErr.hidden = !whenMsg;
    whenErr.textContent = whenMsg ? `! ${whenMsg}` : '';
    dayInp.setAttribute('aria-invalid', String(Boolean(E.when || E.past)));
    hmInp.setAttribute('aria-invalid', String(Boolean(E.when || E.past || E.time)));

    // Ambiguous time: ask, never guess.
    clear(ambSlot);
    if (form.amb) {
      const fs = h('fieldset', { class: 'panel' }, h('legend', { class: 'lg', style: { paddingTop: '2px' } }, T('ambQ', { word: form.amb.word })));
      const name = uid('amb');
      for (const o of form.amb.options) {
        const inp = h('input', { type: 'radio', name, checked: form.amb.chosen === o.hm });
        inp.addEventListener('change', () => {
          let day = form.day;
          // "เตือนโทรหาแม่ 2 โมง" without a day: today if still ahead, else tomorrow.
          if (form.dayImplicit && day === today && Date.parse(zonedToUtc(today, o.hm, app.tz)) <= app.now().getTime()) day = addDays(today, 1);
          dayInp.value = day;
          hmInp.value = o.hm;
          setField({ hm: o.hm, timeRaw: o.hm, day, amb: { ...form.amb, chosen: o.hm }, errors: { ...form.errors, amb: false, when: false, past: false, time: false } });
        });
        fs.append(h('label', { class: 'rc' }, inp, h('span', null, h('b', null, formatTime(o.hm, lang)), h('small', null, o.part === 'morning' ? T('ambMorning', { h: Number(o.hm.slice(0, 2)) }) : T('ambAfternoon')))));
      }
      if (E.amb) fs.append(h('p', { class: 'err-t' }, `! ${T('errAmb')}`));
      ambSlot.append(fs);
    }

    // Chips.
    clear(dayChips);
    for (const [k, label] of [[today, T('today')], [addDays(today, 1), T('tomorrow')]]) {
      dayChips.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(form.day === k), onclick: () => { dayInp.value = k; setField({ day: k, dayImplicit: false, errors: { ...form.errors, when: false, past: false } }); } }, label));
    }
    clear(hmChips);
    for (const x of ['09:00', '12:00', '18:00', '20:00']) {
      hmChips.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(form.hm === x && !form.amb), onclick: () => { hmInp.value = x; setField({ hm: x, timeRaw: x, amb: null, errors: { ...form.errors, when: false, past: false, time: false, amb: false } }); } }, formatTime(x, lang)));
    }

    // Once / repeat (new reminders only) with progressive options.
    clear(repeatSeg);
    clear(freqSlot);
    if (!editId) {
      for (const [on, label] of [[false, T('once')], [true, T('repeat')]]) {
        repeatSeg.append(h('button', { type: 'button', role: 'radio', class: form.isRepeat === on ? 'on' : '', 'aria-checked': String(form.isRepeat === on), onclick: () => setField({ isRepeat: on }) }, h('span', null, label)));
      }
      if (form.isRepeat) {
        const fs = h('fieldset', null, h('legend', { class: 'lg' }, T('howOften')));
        const name = uid('freq');
        const p = form.day ? parseKey(form.day) : null;
        const wd = p ? WEEKDAY_NAMES[lang === 'en' ? 'en' : 'th'][new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()] : '';
        const subs = {
          daily: T('dailySub'),
          weekly: p ? T('weeklySub', { wd }) : T('pickDateFirst'),
          monthly: p ? T('monthlySub', { d: p.d }) : T('pickDateFirst'),
          yearly: p ? T('yearlySub', { dm: formatDay(form.day, lang, 'dm') }) : T('pickDateFirst'),
        };
        for (const f of ['daily', 'weekly', 'monthly', 'yearly']) {
          const inp = h('input', { type: 'radio', name, checked: form.repeat === f });
          inp.addEventListener('change', () => setField({ repeat: f }));
          fs.append(h('label', { class: 'rc' }, inp, h('span', null, h('b', null, T(f)), h('small', null, subs[f]))));
        }
        freqSlot.append(fs);
      }
    }

    clear(statusSlot);
    submit.disabled = form.pending;
    submit.textContent = form.pending ? T('saving') : editId ? T('submitTime') : T('submit');
    if (form.pending && motion) statusSlot.append(motion.el);
  }

  function build() {
    clear(body);
    textInp.value = form.text;
    dayInp.value = form.day;
    hmInp.value = form.timeRaw;
    if (editId) textInp.readOnly = true;
    textInp.addEventListener('input', () => setField({ text: textInp.value, errors: { ...form.errors, text: false } }));
    dayInp.addEventListener('change', () => setField({ day: dayInp.value, dayImplicit: false, errors: { ...form.errors, when: false, past: false } }));
    hmInp.addEventListener('input', () => { form.timeRaw = hmInp.value; form.dirty = true; });
    hmInp.addEventListener('change', () => readTime(hmInp.value));

    body.append(bannerSlot, summarySlot);
    if (!editId) body.append(nlBlock());
    body.append(ambSlot,
      h('div', { class: 'field' }, h('label', { for: textId }, T('task')), textInp, textErr),
      h('fieldset', null, h('legend', { class: 'lg' }, T('when')), dayChips,
        h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-start' } },
          h('div', { class: 'field', style: { flex: '1 1 170px' } }, h('label', { for: dayId, class: 'sm' }, T('date')), dayInp),
          h('div', { class: 'field', style: { flex: '1 1 120px' } }, h('label', { for: hmId, class: 'sm' }, T('time')), hmInp)),
        hmChips, whenErr));
    if (!editId) body.append(h('fieldset', null, h('legend', { class: 'lg' }, T('freq')), repeatSeg), freqSlot);
    else body.append(h('p', { class: 'sm' }, repeatSummary(form.orig, { lang, T, tz: app.tz })));
    body.append(statusSlot, submit);
    submit.addEventListener('click', save);
    refresh();
  }

  function readTime(raw) {
    const v = String(raw || '').trim();
    if (!v) return setField({ hm: '', timeRaw: '', amb: null });
    const r = parseTime(v);
    if (!r) return setField({ hm: '', timeRaw: v, amb: null, errors: { ...form.errors, time: true } });
    if (r.ambiguous) return setField({ hm: '', timeRaw: v, amb: { word: r.word, options: r.options, chosen: null }, errors: { ...form.errors, time: false } });
    hmInp.value = r.hm;
    return setField({ hm: r.hm, timeRaw: r.hm, amb: null, errors: { ...form.errors, time: false, when: false, past: false, amb: false } });
  }

  function nlBlock() {
    const examples = lang === 'en'
      ? ['tomorrow 9am send the documents', 'remind me to call mom at 2', 'every day 9pm take medicine']
      : ['พรุ่งนี้ 9 โมง เตือนส่งเอกสาร', 'เตือนโทรหาแม่ 2 โมง', 'กินยา ทุกวัน 3 ทุ่ม'];
    const msg = h('p', { class: 'xs muted', role: 'status' });
    const nlId = uid('nl');
    const nl = h('input', { id: nlId, class: 'inp', type: 'text', placeholder: T('nlPh'), autocomplete: 'off' });
    const fill = (text) => {
      const r = parseNatural(text, { today });
      if (!r) { msg.textContent = T('nlNoMatch'); return; }
      const patch = { text: r.text || form.text, day: r.day, dayImplicit: r.dayImplicit, errors: {}, isRepeat: r.repeat !== 'none', repeat: r.repeat !== 'none' ? r.repeat : form.repeat, amb: null, hm: '', timeRaw: '' };
      if (r.time?.ambiguous) patch.amb = { word: r.time.word, options: r.time.options, chosen: null };
      else if (r.time?.hm) {
        patch.hm = r.time.hm;
        patch.timeRaw = r.time.hm;
        if (r.dayImplicit && Date.parse(zonedToUtc(r.day, r.time.hm, app.tz)) <= app.now().getTime()) patch.day = addDays(r.day, 1);
      }
      textInp.value = patch.text;
      dayInp.value = patch.day;
      hmInp.value = patch.timeRaw;
      setField(patch);
      msg.textContent = T('nlFilled');
    };
    return h('div', { class: 'field' },
      h('label', { for: nlId, class: 'lg' }, T('nlLabel')),
      h('div', { class: 'chips' }, examples.map((x) => h('button', { type: 'button', class: 'chip', onclick: () => { nl.value = x; fill(x); } }, `“${x}”`))),
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, nl, h('button', { class: 'btn', type: 'button', style: { whiteSpace: 'nowrap', flex: 'none' }, onclick: () => fill(nl.value) }, T('nlFill'))),
      msg);
  }

  async function save() {
    if (form.pending) return;
    if (hmInp.value.trim() && hmInp.value.trim() !== form.hm && !form.amb) readTime(hmInp.value);
    const E = {};
    if (!form.text.trim()) E.text = true;
    if (form.amb && !form.amb.chosen) E.amb = true;
    else if (!form.day || !form.hm) E.when = true;
    else if (Date.parse(zonedToUtc(form.day, form.hm, app.tz)) <= app.now().getTime()) E.past = true;
    if (Object.keys(E).length) {
      form.errors = E;
      form.failed = null;
      refresh();
      (E.text ? textInp : E.amb ? ambSlot.querySelector('input') : hmInp)?.focus();
      return;
    }
    form.pending = true;
    form.failed = null;
    motion = createMotion({ T, kind: 'saving', compact: true });
    motion.start();
    refresh();
    try {
      const res = editId
        ? await api.patch(`/reminders/${editId}`, { date: form.day, time: form.hm, expectAt: form.orig.at })
        : await api.post('/reminders', { text: form.text.trim(), date: form.day, time: form.hm, repeat: form.isRepeat ? form.repeat : 'none', key: form.key });
      if (destroyed) return;
      await motion.success();
      if (destroyed) return;
      motion.destroy();
      form.dirty = false;
      app.setGuard(null);
      app.lastDone = { mode: editId ? 'time' : 'new', reminder: res.reminder };
      app.go('reminder/done', { replace: true });
    } catch (err) {
      if (destroyed) return;
      form.pending = false;
      if (err instanceof ApiError && err.status === 400 && err.body?.fields) {
        motion.destroy();
        const f = err.body.fields;
        form.errors = { text: Boolean(f.text), past: f.when === 'past', time: f.time === 'invalid', when: f.date === 'invalid' };
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'changed') {
        motion.destroy();
        form.orig = err.body.reminder;
        form.failed = 'server';
        app.toast(T('gone'));
      } else {
        motion.failure(T('moFailure'));
        form.failed = err instanceof ApiError && err.isNetwork ? 'net' : 'server';
      }
      refresh();
      if (motion && !motion.destroyed && form.failed) statusSlot.append(motion.el);
    }
  }

  if (editId) {
    const m = createMotion({ T, kind: 'loading' });
    body.append(m.el);
    m.start();
    api.get('/reminders').then((data) => {
      if (destroyed) return;
      m.destroy();
      const r = data.items.find((x) => x.id === editId);
      if (!r) { body.append(banner('err', { iconSrc: '/app/img/alert.svg', title: T('gone') }), h('a', { class: 'btn', href: '#/reminders' }, T('seeRem'))); return; }
      const z = zoned(r.firedAt ? new Date(Math.max(Date.now(), Date.parse(r.at))) : r.at, app.tz);
      Object.assign(form, { orig: r, text: r.text, day: z.key < today ? today : z.key, timeRaw: z.hm, hm: z.hm, repeat: r.repeat, isRepeat: r.repeat !== 'none' });
      build();
    }).catch((err) => {
      if (destroyed) return;
      m.destroy();
      body.append(errorState(app, err, { retry: () => app.go(`reminder/${editId}`) }));
    });
  } else {
    build();
  }

  return {
    el,
    destroy() {
      destroyed = true;
      motion?.destroy();
    },
  };
}

export function renderDone(app) {
  const T = app.T;
  const lang = app.lang;
  const done = app.lastDone;
  if (!done) { app.go('reminders', { replace: true }); return { el: h('div') }; }
  const r = done.reminder;
  const motion = createMotion({ T, kind: 'saving' });
  // The save already succeeded on the server; this is the confirmation pose.
  motion.success(done.mode === 'time' ? T('okTime') : T('okTitle'));
  const el = h('div', { class: 'stack', style: { alignItems: 'center', textAlign: 'center', gap: '10px', paddingTop: '30px' } },
    motion.el,
    h('h1', { tabindex: '-1', 'data-autofocus': '' }, done.mode === 'time' ? T('okTime') : T('okTitle')),
    h('p', { style: { overflowWrap: 'anywhere' } }, T('okBody', { text: r.text, when: formatDateTime(r.at, lang, app.tz) })),
    h('p', { class: 'sm muted' }, repeatSummary(r, { lang, T, tz: app.tz })),
    h('a', { class: 'btn pri blk', href: '#/reminders' }, T('seeRem')),
    h('a', { class: 'btn blk', href: '#/reminder/new' }, T('another')));
  return { el, destroy: () => { motion.destroy(); app.lastDone = null; } };
}
