import { VoiceSession, speakOnce, canSpeak } from './speech.js';

const PW_KEY = 'speaking.password';
const SESSION_KEY = 'speaking.session';
const SCREENS = ['home', 'session', 'summary', 'log', 'password'];
const STATE_LABELS = {
  idle: 'Ready',
  listening: 'Listening… 请说',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  paused: 'Paused',
  error: 'Something went wrong',
};
const WARNINGS = {
  unsupported: 'Voice input isn’t supported in this browser. Type your replies below — the partner still talks. (Chrome, Edge or Safari work best.)',
  denied: 'The microphone is blocked. Allow it in your browser’s site settings, then tap Resume — or type your replies below.',
};

/** localStorage is a per-device convenience; it may be unavailable. */
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // storage full or blocked
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // storage blocked
    }
  },
};

const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`);
const $ = (id) => document.getElementById(id);

const el = {
  badge: byTestId('provider-badge'),
  navLog: byTestId('nav-log'),
  loadError: $('load-error'),
  retryLoad: $('retry-load'),
  resumeBanner: byTestId('resume-banner'),
  resumeText: $('resume-text'),
  resume: byTestId('resume'),
  discard: byTestId('discard'),
  dayWeek: $('day-week'),
  dayTitle: byTestId('selected-day-title'),
  dayDetails: byTestId('day-details'),
  start: byTestId('start'),
  dayGrid: byTestId('day-grid'),
  progressText: $('progress-text'),
  progressBar: $('progress-bar'),
  sessionEyebrow: $('session-eyebrow'),
  sessionTitle: $('session-title'),
  leave: byTestId('leave'),
  timer: $('session-timer'),
  status: byTestId('status'),
  statusLabel: $('status-label'),
  interim: byTestId('interim'),
  voiceWarning: byTestId('voice-warning'),
  pause: byTestId('pause'),
  repeat: byTestId('repeat'),
  slower: byTestId('slower'),
  end: byTestId('end'),
  transcript: byTestId('transcript'),
  composer: $('composer'),
  textInput: byTestId('text-input'),
  send: byTestId('send'),
  summaryEyebrow: $('summary-eyebrow'),
  summaryWords: byTestId('summary-words'),
  summaryMistakes: byTestId('summary-mistakes'),
  summaryPractice: byTestId('summary-practice'),
  playPractice: $('play-practice'),
  home: byTestId('home'),
  logList: byTestId('log-list'),
  logEmpty: byTestId('log-empty'),
  back: byTestId('back'),
  passwordForm: byTestId('password-form'),
  password: byTestId('password'),
  passwordError: $('password-error'),
  passwordSubmit: byTestId('password-submit'),
};

const app = {
  plan: [],
  log: [],
  selectedDay: 1,
  session: null,
  screen: 'home',
  dayButtons: [],
  timer: 0,
  pinned: true, // transcript scrolled to the newest message
};

/* ---------- API + password gate ---------- */

class ApiError extends Error {
  constructor(status, code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = status;
    this.code = code;
    this.network = status === 0;
  }
}

let password = storage.get(PW_KEY) || '';
const gate = { promise: null, resolve: null, returnTo: 'home' };

function askPassword(wrong) {
  if (!gate.promise) {
    gate.promise = new Promise((resolve) => {
      gate.resolve = resolve;
    });
    if (app.screen !== 'password') gate.returnTo = app.screen;
    el.passwordError.hidden = true;
    show('password');
  }
  if (wrong) el.passwordError.hidden = false;
  el.passwordSubmit.disabled = false;
  if (wrong) el.password.value = '';
  el.password.focus({ preventScroll: true });
  return gate.promise;
}

/** Header values must be Latin-1: send the password percent-encoded (the server decodes it). */
function passwordHeader(value) {
  try {
    return encodeURIComponent(value);
  } catch {
    return encodeURIComponent(value.toWellFormed?.() ?? ''); // lone surrogate: can only mismatch
  }
}

function closeGate() {
  if (app.screen === 'password' && !gate.promise) show(gate.returnTo);
}

async function api(path, { method = 'GET', body } = {}) {
  for (;;) {
    const sent = password;
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (sent) headers['x-app-password'] = passwordHeader(sent);
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'network');
    }
    if (res.status === 401 && path !== '/api/health') {
      if (password === sent) {
        password = '';
        storage.remove(PW_KEY);
        await askPassword(Boolean(sent));
      }
      continue;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON body
    }
    if (!res.ok) throw new ApiError(res.status, data?.error || 'failed', data?.detail);
    closeGate();
    return data;
  }
}

el.passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = el.password.value;
  if (!value) {
    el.password.focus();
    return;
  }
  password = value;
  storage.set(PW_KEY, value);
  el.passwordError.hidden = true;
  el.passwordSubmit.disabled = true;
  const { resolve } = gate;
  gate.promise = null;
  gate.resolve = null;
  resolve?.();
});

/* ---------- Screens ---------- */

function show(name) {
  for (const screen of SCREENS) $(`screen-${screen}`).hidden = screen !== name;
  app.screen = name;
  window.scrollTo(0, 0);
  if (name !== 'password') $(`screen-${name}`).querySelector('h1')?.focus({ preventScroll: true });
}

const getDay = (n) => app.plan.find((d) => d.day === n) || null;
const doneDays = () => new Set(app.log.map((e) => e.day));
const titleOf = (day) => (day ? `Day ${day.day} · ${day.topic}` : '');

function defaultDay() {
  const done = [...doneDays()].filter((n) => Number.isInteger(n));
  return done.length ? Math.min(Math.max(...done) + 1, 30) : 1;
}

function node(tag, { className, text, lang, attrs } = {}, children = []) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  if (lang) n.lang = lang;
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  n.append(...children);
  return n;
}

/* ---------- Home ---------- */

function buildGrid() {
  el.dayGrid.replaceChildren();
  app.dayButtons = [];
  const weeks = new Map();
  for (const day of app.plan) {
    if (!weeks.has(day.week)) weeks.set(day.week, { title: day.weekTitle, days: [] });
    weeks.get(day.week).days.push(day);
  }
  for (const [week, { title, days }] of weeks) {
    const label = node('p', { className: 'week-label', attrs: { id: `week-${week}` } }, [
      node('span', { text: `Week ${week}` }),
      node('span', { text: title ? `· ${title}` : '' }),
    ]);
    const row = node('div', { className: 'week-days', attrs: { role: 'group', 'aria-labelledby': `week-${week}` } });
    for (const day of days) {
      const btn = node('button', {
        className: `day-btn${day.review ? ' review' : ''}`,
        text: String(day.day),
        attrs: { type: 'button', 'data-testid': `day-${day.day}`, 'aria-pressed': 'false' },
      });
      btn.addEventListener('click', () => {
        app.selectedDay = day.day;
        renderHome();
      });
      app.dayButtons[day.day] = btn;
      row.append(btn);
    }
    el.dayGrid.append(node('div', { className: 'week' }, [label, row]));
  }
}

function renderDetails(day) {
  const parts = [];
  if (day.review) {
    const refs = (day.reviewOf || []).map(getDay).filter(Boolean);
    parts.push(node('div', {}, [
      node('p', { className: 'detail-label', text: 'Review — no new words' }),
      refs.length > 6
        ? node('p', { className: 'scene', text: `Everything from Day ${refs[0].day} to Day ${refs[refs.length - 1].day}.` })
        : node('ul', { className: 'chips topics' }, refs.map((d) => node('li', { text: `${d.day} · ${d.topic}` }))),
    ]));
  } else if (day.words?.length) {
    parts.push(node('div', {}, [
      node('p', { className: 'detail-label', text: 'Target words' }),
      node('ul', { className: 'chips', lang: 'zh-CN' }, day.words.map((w) => node('li', { text: w }))),
    ]));
  }
  if (day.scene) {
    parts.push(node('div', {}, [
      node('p', { className: 'detail-label', text: 'Role-play' }),
      node('p', { className: 'scene', text: day.scene }),
    ]));
  }
  el.dayDetails.replaceChildren(...parts);
}

function renderHome() {
  const day = getDay(app.selectedDay);
  const done = doneDays();
  if (day) {
    el.dayWeek.textContent = `Week ${day.week}${day.weekTitle ? ` · ${day.weekTitle}` : ''}${done.has(day.day) ? ' · done ✓' : ''}`;
    el.dayTitle.textContent = titleOf(day);
    renderDetails(day);
  }
  el.start.disabled = !day;
  app.dayButtons.forEach((btn, n) => {
    if (!btn) return;
    const d = getDay(n);
    btn.classList.toggle('done', done.has(n));
    btn.setAttribute('aria-pressed', String(n === app.selectedDay));
    btn.setAttribute('aria-label', `Day ${n}: ${d?.topic || ''}${done.has(n) ? ', done' : ''}`);
  });
  const count = app.plan.filter((d) => done.has(d.day)).length;
  el.progressText.textContent = `${count} of ${app.plan.length || 30} days done`;
  el.progressBar.style.width = `${(count / (app.plan.length || 30)) * 100}%`;
  renderResume();
}

function savedSession() {
  try {
    const saved = JSON.parse(storage.get(SESSION_KEY) || 'null');
    if (!saved || !Number.isInteger(saved.day) || !getDay(saved.day) || !Array.isArray(saved.messages)) return null;
    const messages = saved.messages.filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.text === 'string');
    if (!messages.some((m) => m.role === 'user')) return null;
    return { day: saved.day, messages };
  } catch {
    return null;
  }
}

function renderResume() {
  const saved = savedSession();
  el.resumeBanner.hidden = !saved;
  if (!saved) return;
  const turns = saved.messages.filter((m) => m.role === 'user').length;
  el.resumeText.textContent = `Resume Day ${saved.day}? (${turns} ${turns === 1 ? 'turn' : 'turns'} so far)`;
}

function renderBadge(provider) {
  el.badge.hidden = !provider;
  if (provider === 'mock') {
    el.badge.textContent = 'demo mode';
    el.badge.title = 'Replies come from a built-in demo, not a real AI';
    el.badge.className = 'badge';
  } else if (provider) {
    el.badge.textContent = provider === 'anthropic' ? 'Claude' : provider[0].toUpperCase() + provider.slice(1);
    el.badge.title = 'AI provider';
    el.badge.className = 'badge live';
  }
}

async function load() {
  el.loadError.hidden = true;
  try {
    const health = await api('/api/health');
    renderBadge(health?.provider);
    if (health?.passwordRequired && !password) await askPassword(false);
    const [plan, log] = await Promise.all([api('/api/plan'), api('/api/log')]);
    app.plan = Array.isArray(plan?.days) ? plan.days : [];
    app.log = Array.isArray(log?.entries) ? log.entries : [];
    app.selectedDay = defaultDay();
    buildGrid();
    renderHome();
  } catch (err) {
    console.error(err);
    el.dayTitle.textContent = 'Not connected';
    el.loadError.hidden = false;
  }
}

/* ---------- Session ---------- */

function appendBubble(className, text, lang) {
  const bubble = node('div', { className, text, lang });
  el.transcript.append(bubble);
  el.transcript.scrollTop = el.transcript.scrollHeight;
  app.pinned = true;
  if (el.transcript.scrollHeight <= el.transcript.clientHeight) bubble.scrollIntoView?.({ block: 'nearest' });
}

// Keep the newest message in view when the transcript changes size (rotation, keyboard).
el.transcript.addEventListener('scroll', () => {
  const { scrollHeight, scrollTop, clientHeight } = el.transcript;
  app.pinned = scrollHeight - scrollTop - clientHeight < 24;
}, { passive: true });

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    if (app.pinned) el.transcript.scrollTop = el.transcript.scrollHeight;
  }).observe(el.transcript);
}

function appendMessage({ role, text }) {
  appendBubble(role === 'user' ? 'msg user' : 'msg bot', text, 'zh-CN');
}

function renderState(state, detail) {
  el.status.dataset.state = state;
  el.statusLabel.textContent = detail || STATE_LABELS[state] || state;
  const stopped = state === 'paused' || state === 'error';
  el.pause.querySelector('.label').textContent = stopped ? 'Resume' : 'Pause';
  el.pause.querySelector('use').setAttribute('href', stopped ? '#i-play' : '#i-pause');
  el.send.disabled = state === 'thinking';
  el.repeat.disabled = state === 'thinking';
}

function setSlowerButton(on) {
  el.slower.setAttribute('aria-pressed', String(on));
}

function startTimer() {
  clearInterval(app.timer);
  const started = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    el.timer.textContent = h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  tick();
  app.timer = setInterval(tick, 1000);
}

function stopTimer() {
  clearInterval(app.timer);
  app.timer = 0;
}

/** Must run inside the click handler: VoiceSession.start() unlocks speech on iOS. */
function startSession(dayNumber, messages = []) {
  app.session?.destroy();
  const day = getDay(dayNumber);
  if (!day) return;
  if (!messages.length) storage.remove(SESSION_KEY);
  el.transcript.replaceChildren();
  el.interim.textContent = '';
  el.voiceWarning.hidden = true;
  el.textInput.value = '';
  el.leave.disabled = false;
  el.sessionEyebrow.textContent = `Week ${day.week}${day.weekTitle ? ` · ${day.weekTitle}` : ''}`;
  el.sessionTitle.textContent = titleOf(day);
  setSlowerButton(false);
  renderState('idle');
  show('session');
  messages.forEach(appendMessage);

  const session = new VoiceSession({
    day: day.day,
    messages,
    api: {
      chat: (d, msgs) => api('/api/chat', { method: 'POST', body: { day: d, messages: msgs } }).then((r) => r?.reply),
      summary: (d, msgs) => api('/api/summary', { method: 'POST', body: { day: d, messages: msgs } }).then((r) => r?.entry),
    },
    hooks: {
      state: (state, detail) => {
        if (app.session !== session) return;
        renderState(state, detail);
        el.leave.disabled = session.ended; // no leaving while the summary is being saved
      },
      message: (msg) => appendMessage(msg),
      notice: (text) => appendBubble('msg notice', text),
      interim: (text) => {
        el.interim.textContent = text;
      },
      slower: (on) => setSlowerButton(on),
      voiceWarning: (reason) => {
        if (!reason) {
          el.voiceWarning.hidden = true;
          return;
        }
        el.voiceWarning.textContent = reason === 'unsupported' ? WARNINGS.unsupported : WARNINGS.denied;
        el.voiceWarning.hidden = false;
        el.textInput.focus({ preventScroll: true });
      },
      persist: (d, msgs) => storage.set(SESSION_KEY, JSON.stringify({ day: d, messages: msgs, at: Date.now() })),
      finished: (entry) => onFinished(session, entry),
    },
  });
  app.session = session;
  startTimer();
  session.start();
}

function onFinished(session, entry) {
  if (app.session !== session) return;
  app.session = null;
  stopTimer();
  storage.remove(SESSION_KEY);
  if (!entry) {
    goHome();
    return;
  }
  app.log = [entry, ...app.log.filter((e) => e.id !== entry.id)];
  renderSummary(entry);
  show('summary');
}

/** Leaves without a summary; the saved conversation can be resumed from home. */
function leaveSession() {
  app.session?.destroy();
  app.session = null;
  stopTimer();
  goHome();
}

function goHome() {
  app.selectedDay = defaultDay();
  renderHome();
  show('home');
}

/* ---------- Summary + history ---------- */

function renderSummary(entry) {
  const summary = entry?.summary || {};
  const day = getDay(entry.day);
  const turns = Number(entry.turns) || 0;
  el.summaryEyebrow.textContent = `${titleOf(day) || `Day ${entry.day}`} · ${turns} ${turns === 1 ? 'turn' : 'turns'}`;

  const words = Array.isArray(summary.words) ? summary.words : [];
  // Demo mode sends "-" placeholders: show those words as plain chips.
  const info = (s) => (typeof s === 'string' && s.trim() !== '-' ? s.trim() : '');
  const bare = words.length > 0 && words.every((w) => !info(w?.pinyin) && !info(w?.meaning));
  el.summaryWords.className = bare ? 'chips word-chips' : 'word-list';
  el.summaryWords.replaceChildren(...(words.length
    ? words.map((w) => (bare
      ? node('li', { text: w?.hanzi || '', lang: 'zh-CN' })
      : node('li', {}, [
        node('span', { className: 'hanzi', text: w?.hanzi || '', lang: 'zh-CN' }),
        node('span', { className: 'pinyin', text: info(w?.pinyin) }),
        node('span', { className: 'meaning', text: info(w?.meaning) }),
      ])))
    : [node('li', { className: 'muted', text: 'No new words this time.' })]));

  const mistakes = Array.isArray(summary.mistakes) ? summary.mistakes : [];
  el.summaryMistakes.replaceChildren(...(mistakes.length
    ? mistakes.map((m) => node('li', { text: String(m) }))
    : [node('li', { text: 'No repeated mistakes. Nice work!' })]));

  el.summaryPractice.textContent = summary.practice || '';
  el.playPractice.hidden = !summary.practice || !canSpeak();
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function renderLog() {
  const items = app.log.map((entry) => {
    const day = getDay(entry.day);
    const words = Array.isArray(entry.summary?.words) ? entry.summary.words : [];
    const turns = Number(entry.turns) || 0;
    const children = [
      node('div', { className: 'log-top' }, [
        node('span', { className: 'log-day', text: titleOf(day) || `Day ${entry.day}` }),
        node('time', { className: 'log-date', text: formatDate(entry.date), attrs: { datetime: String(entry.date || '') } }),
      ]),
      node('p', { className: 'log-meta', text: `${words.length} ${words.length === 1 ? 'word' : 'words'} · ${turns} ${turns === 1 ? 'turn' : 'turns'}` }),
    ];
    if (words.length) {
      children.push(node('p', { className: 'log-words', lang: 'zh-CN', text: words.map((w) => w?.hanzi).filter(Boolean).join(' · ') }));
    }
    return node('li', { className: 'log-item' }, children);
  });
  el.logList.replaceChildren(...items);
  el.logList.hidden = !items.length;
  el.logEmpty.hidden = items.length > 0;
}

/* ---------- Events ---------- */

el.start.addEventListener('click', () => startSession(app.selectedDay));

el.resume.addEventListener('click', () => {
  const saved = savedSession();
  if (saved) startSession(saved.day, saved.messages);
  else renderResume();
});

el.discard.addEventListener('click', () => {
  storage.remove(SESSION_KEY);
  renderResume();
});

el.navLog.addEventListener('click', () => {
  renderLog();
  show('log');
  api('/api/log')
    .then((data) => {
      if (!Array.isArray(data?.entries)) return;
      app.log = data.entries;
      if (app.screen === 'log') renderLog();
    })
    .catch(() => {});
});

el.back.addEventListener('click', () => {
  renderHome();
  show('home');
});

el.home.addEventListener('click', goHome);

el.retryLoad.addEventListener('click', load);

el.leave.addEventListener('click', leaveSession);
el.pause.addEventListener('click', () => app.session?.togglePause());
el.repeat.addEventListener('click', () => app.session?.repeat());
el.slower.addEventListener('click', () => app.session?.toggleSlower());
el.end.addEventListener('click', () => app.session?.finish());

el.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = el.textInput.value.trim();
  if (!text || !app.session) return;
  if (app.session.input(text)) el.textInput.value = '';
});

el.playPractice.addEventListener('click', () => speakOnce(el.summaryPractice.textContent));

load();
