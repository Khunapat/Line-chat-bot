/**
 * End-to-end + visual harness for the speaking partner.
 *   node e2e/run.mjs
 * Spawns `node server.js` (mock provider, temp DATA_DIR, free port), drives the
 * page in headless Chromium with fake SpeechRecognition / speechSynthesis,
 * takes screenshots into e2e/screenshots/ and checks the layout. Prints a
 * PASS/FAIL line per assertion and exits 1 if any failed.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(APP_DIR, 'e2e', 'screenshots');
const VIEWPORTS = [[1920, 900], [1366, 900], [1280, 900], [1024, 900], [390, 844]];
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const TIMEOUT = 10000;
const PASSWORD = 'e2e-ม้า-马-horse'; // non-Latin-1 on purpose: header values must be encoded
const WRONG_PASSWORD = 'ผิด-wrong';
const DAY_IDS = Array.from({ length: 30 }, (_, i) => `day-${i + 1}`);
const SESSION_CONTROLS = ['leave', 'pause', 'repeat', 'slower', 'end', 'text-input', 'send'];

// ---------------------------------------------------------------- reporting

const results = [];
const cleanups = [];
const children = new Set();

// Last resort if the harness dies mid-run: never leave a server behind.
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
});
// A closed stdout pipe (e.g. `| head`) must not crash the run before cleanup.
process.stdout.on('error', () => {});

/** A failed must-have step; aborts the current scenario (already reported). */
class Abort extends Error {}

function record(ok, name, detail = '') {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  return ok;
}

function must(ok, name, detail) {
  if (!record(ok, name, detail)) throw new Abort(name);
}

async function diag(page) {
  try {
    return await page.evaluate(() => JSON.stringify({
      screens: window.__e2e.screens(),
      state: window.__e2e.state(),
      msgs: window.__e2e.msgs().slice(-4),
      fake: {
        queue: window.__fakeSpeech.queue,
        starts: window.__fakeSpeech.starts,
        active: window.__fakeSpeech.active,
        emptyRounds: window.__fakeSpeech.emptyRounds,
        states: window.__fakeSpeech.states.slice(-8),
        spoken: window.__fakeSpeech.spoken.slice(-3).map((s) => s.text),
      },
    }));
  } catch (err) {
    return `(diag unavailable: ${err.message.split('\n')[0]})`;
  }
}

/** Poll a browser predicate; PASS/FAIL it. Hard failures abort the scenario. */
async function waitUntil(page, name, fn, arg, { timeout = TIMEOUT, hard = true } = {}) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 25 });
    return record(true, name);
  } catch (err) {
    record(false, name, `${err.message.split('\n')[0]}\n        state: ${await diag(page)}`);
    if (hard) throw new Abort(name);
    return false;
  }
}

/** Poll a Node-side predicate until truthy or timeout; returns the last value. */
async function pollUntil(fn, timeout = TIMEOUT) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await delay(25);
  }
}

// ------------------------------------------------------- in-browser fakes

/**
 * Runs in the page before any app script (addInitScript). Installs the fake
 * speech APIs, a status-transition recorder and small helpers on window.__e2e.
 */
function installFakes({ recognition }) {
  const fake = {
    queue: [], spoken: [], states: [], interimSeen: [], config: null,
    starts: 0, active: 0, doubleStarts: 0, concurrent: 0, startedWhileSpeaking: 0,
    emptyRounds: 0, noSpeechErrors: 0, silentEnds: 0, results: 0, startsAtLastEmpty: 0,
    holdMs: 300, deny: 0, wakeHeld: 0,
  };
  window.__fakeSpeech = fake;

  class FakeTarget extends EventTarget {}

  /** Dispatch `type` on target: listeners plus the on<type> property. */
  function fire(target, type, props = {}) {
    const ev = new Event(type);
    for (const [k, v] of Object.entries(props)) Object.defineProperty(ev, k, { value: v, enumerable: true });
    target.dispatchEvent(ev);
    if (target instanceof FakeTarget && typeof target[`on${type}`] === 'function') target[`on${type}`].call(target, ev);
  }

  // --- speechSynthesis
  const VOICES = [
    { name: 'E2E Chinese', lang: 'zh-CN', voiceURI: 'e2e-zh', localService: true, default: false },
    { name: 'E2E English', lang: 'en-US', voiceURI: 'e2e-en', localService: true, default: true },
    { name: 'E2E Thai', lang: 'th-TH', voiceURI: 'e2e-th', localService: true, default: false },
  ];

  class FakeUtterance extends FakeTarget {
    constructor(text = '') {
      super();
      Object.assign(this, { text: String(text), lang: '', voice: null, rate: 1, pitch: 1, volume: 1 });
      for (const t of ['start', 'end', 'error', 'pause', 'resume', 'boundary', 'mark']) this[`on${t}`] = null;
    }
  }

  class FakeSynthesis extends FakeTarget {
    constructor() {
      super();
      Object.assign(this, { speaking: false, pending: false, paused: false, onvoiceschanged: null });
      this._queue = [];
      this._current = null;
      this._timer = null;
      this._held = false;
    }

    getVoices() { return VOICES.map((v) => ({ ...v })); }

    speak(u) {
      if (!u || typeof u !== 'object') throw new TypeError('speak() needs an utterance');
      this._queue.push(u);
      this._pump();
    }

    _pump() {
      this.pending = this._queue.length > 0 && Boolean(this._current);
      if (this._current || this.paused || !this._queue.length) return;
      const u = this._current = this._queue.shift();
      this.speaking = true;
      this.pending = this._queue.length > 0;
      fake.spoken.push({
        text: String(u.text ?? ''), lang: String(u.lang || ''), rate: Number(u.rate),
        voice: u.voice ? { name: String(u.voice.name), lang: String(u.voice.lang) } : null,
      });
      this._timer = setTimeout(() => {
        fire(u, 'start', { utterance: u, charIndex: 0, elapsedTime: 0 });
        this._timer = setTimeout(() => this._finish(u), 30);
      }, 5);
    }

    _finish(u) {
      this._timer = null;
      this._current = null;
      this.speaking = this._queue.length > 0;
      this.pending = this._queue.length > 1;
      fire(u, 'end', { utterance: u, charIndex: u.text.length, elapsedTime: 35 });
      this._pump();
    }

    cancel() {
      clearTimeout(this._timer);
      const cur = this._current;
      const dropped = this._queue.splice(0);
      Object.assign(this, { _timer: null, _current: null, _held: false, speaking: false, pending: false });
      setTimeout(() => {
        if (cur) fire(cur, 'error', { utterance: cur, error: 'interrupted' });
        for (const u of dropped) fire(u, 'error', { utterance: u, error: 'canceled' });
      }, 0);
    }

    pause() {
      if (this.paused) return;
      this.paused = true;
      if (this._current && this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
        this._held = true;
      }
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      if (this._held) {
        this._held = false;
        const u = this._current;
        this._timer = setTimeout(() => this._finish(u), 30);
      } else {
        this._pump();
      }
    }
  }

  const synth = new FakeSynthesis();
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: FakeUtterance });
  setTimeout(() => fire(synth, 'voiceschanged'), 50);

  // --- screen wake lock: count the locks held
  const wakeLock = {
    async request() {
      fake.wakeHeld++;
      let held = true;
      return {
        released: false,
        addEventListener() {},
        async release() {
          if (held) fake.wakeHeld--;
          held = false;
        },
      };
    },
  };
  Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true, get: () => wakeLock });

  // --- SpeechRecognition
  class FakeRecognition extends FakeTarget {
    constructor() {
      super();
      Object.assign(this, { lang: '', interimResults: false, continuous: false, maxAlternatives: 1 });
      for (const t of ['start', 'end', 'error', 'result', 'nomatch', 'audiostart', 'audioend', 'soundstart', 'soundend', 'speechstart', 'speechend']) this[`on${t}`] = null;
      this._running = false;
      this._timers = [];
      this._pendingText = null;
    }

    _later(ms, fn) { this._timers.push(setTimeout(fn, ms)); }

    start() {
      if (this._running) {
        fake.doubleStarts++;
        throw new DOMException('recognition has already started.', 'InvalidStateError');
      }
      if (fake.active > 0) fake.concurrent++;
      this._running = true;
      fake.active++;
      fake.starts++;
      if (synth.speaking) fake.startedWhileSpeaking++;
      fake.config = { lang: this.lang, interimResults: this.interimResults, continuous: this.continuous };
      if (fake.deny > 0) {
        // Mic permission denied: an error and an end, no audio ever starts.
        fake.deny--;
        this._later(10, () => this._end('not-allowed'));
        return;
      }
      this._since = Date.now();
      this._later(10, () => { fire(this, 'start'); fire(this, 'audiostart'); });
      this._later(50, () => this._poll());
    }

    _poll() {
      if (!this._running) return;
      if (fake.queue.length) return this._deliver(fake.queue.shift());
      if (Date.now() - this._since < fake.holdMs) return this._later(25, () => this._poll());
      // Nothing said: alternate Chrome's two silent endings (error no-speech + end, or a bare end).
      fake.emptyRounds++;
      fake.startsAtLastEmpty = fake.starts;
      if (fake.emptyRounds % 2 === 1) {
        fake.noSpeechErrors++;
        this._end('no-speech');
      } else {
        fake.silentEnds++;
        this._end(null);
      }
    }

    _deliver(text) {
      this._pendingText = text;
      if (this.interimResults) {
        const chars = [...text];
        this._result(chars.slice(0, Math.ceil(chars.length / 2)).join(''), false);
        this._later(20, () => {
          const el = document.querySelector('[data-testid=interim]');
          fake.interimSeen.push(el ? el.textContent : null);
        });
      }
      this._later(50, () => {
        if (!this._running) return;
        this._pendingText = null;
        fake.results++;
        this._result(text, true);
        this._later(10, () => this._end(null));
      });
    }

    _result(transcript, isFinal) {
      const alt = { transcript, confidence: 0.92 };
      const res = [alt];
      res.isFinal = isFinal;
      res.item = (i) => res[i];
      const results = [res];
      results.item = (i) => results[i];
      fire(this, 'result', { results, resultIndex: 0 });
    }

    _halt() {
      for (const t of this._timers.splice(0)) clearTimeout(t);
      if (this._pendingText != null) fake.queue.unshift(this._pendingText);
      this._pendingText = null;
    }

    _end(error) {
      if (!this._running) return;
      this._running = false;
      fake.active--;
      if (error) fire(this, 'error', { error, message: '' });
      setTimeout(() => fire(this, 'end'), 5);
    }

    stop() {
      if (!this._running) return;
      this._halt();
      this._end(null);
    }

    abort() {
      if (!this._running) return;
      this._halt();
      this._end('aborted');
    }
  }

  for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
    if (recognition) {
      Object.defineProperty(window, name, { configurable: true, writable: true, value: FakeRecognition });
    } else {
      delete window[name];
      if (window[name]) Object.defineProperty(window, name, { configurable: true, writable: true, value: undefined });
    }
  }

  // --- status transitions (oldValue keeps short-lived states like "speaking")
  const pushState = (s) => { if (s != null && fake.states.at(-1) !== s) fake.states.push(s); };
  new MutationObserver((records) => {
    let el = null;
    for (const r of records) {
      if (r.target.getAttribute?.('data-testid') !== 'status') continue;
      pushState(r.oldValue);
      el = r.target;
    }
    if (el) pushState(el.getAttribute('data-state'));
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-state'], attributeOldValue: true });

  // --- helpers for waitForFunction predicates
  const vis = (el) => Boolean(el) && el.getClientRects().length > 0
    && (!el.checkVisibility || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  const q = (id) => document.querySelector(`[data-testid="${id}"]`);
  window.__e2e = {
    q,
    vis,
    visible: (id) => vis(q(id)),
    text: (id) => (q(id)?.textContent ?? '').trim(),
    screens: () => ['screen-home', 'screen-session', 'screen-summary', 'screen-log']
      .filter((id) => vis(document.getElementById(id))),
    state: () => q('status')?.getAttribute('data-state') ?? null,
    msgs: () => [...document.querySelectorAll('[data-testid=transcript] .msg')].map((m) => ({
      role: m.classList.contains('user') ? 'user' : m.classList.contains('bot') ? 'bot' : '?',
      text: m.textContent.trim(),
    })),
    dayButtons: () => [...document.querySelectorAll('[data-testid=day-grid] [data-testid]')]
      .filter((el) => /^day-\d+$/.test(el.getAttribute('data-testid'))),
    norm: (s) => [...String(s).normalize('NFC')].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join(''),
    /** True if `seq` appears in order in the recorded states from index `from`. */
    hasSeq: (seq, from = 0) => {
      let i = 0;
      for (const s of fake.states.slice(from)) if (s === seq[i] && ++i === seq.length) return true;
      return false;
    },
    spokenSince: (from) => fake.spoken.slice(from).map((s) => s.text).join(''),
  };
}

// --------------------------------------------------------- layout checks

/** Runs in the page: returns a list of layout problems for the current viewport. */
function layoutReport({ required, overlap }) {
  const W = window.innerWidth;
  const problems = [];
  const { vis, q } = window.__e2e;
  const label = (el) => (el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]`
    : `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].map((c) => `.${c}`).join('')}`);
  const de = document.documentElement;
  if (de.scrollWidth > W) problems.push(`page scrolls sideways: documentElement.scrollWidth ${de.scrollWidth} > ${W}`);
  if (document.body.scrollWidth > W) problems.push(`page scrolls sideways: body.scrollWidth ${document.body.scrollWidth} > ${W}`);

  for (const id of required) if (!vis(q(id))) problems.push(`[${id}] is not visible`);

  for (const el of document.querySelectorAll('[data-testid], .msg')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.left < -1 || r.right > W + 1) {
      problems.push(`${label(el)} cut off by viewport: x ${Math.round(r.left)}..${Math.round(r.right)}, width ${W}`);
      continue;
    }
    for (let a = el.parentElement; a && a !== document.body && a !== de; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (r.left < ar.left - 1 || r.right > ar.right + 1) {
        problems.push(`${label(el)} clipped horizontally by ${label(a)}`);
        break;
      }
    }
  }

  const controls = overlap.map(q).filter(vis);
  for (const el of controls) {
    if (el.tagName === 'BUTTON' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
      problems.push(`${label(el)} content overflows its box (${el.scrollWidth}x${el.scrollHeight} > ${el.clientWidth}x${el.clientHeight})`);
    }
  }
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i];
      const b = controls[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ix > 1 && iy > 1) problems.push(`${label(a)} overlaps ${label(b)} (${Math.round(ix)}x${Math.round(iy)}px)`);
    }
  }
  // Nothing else may sit on top of a control: hit-test its centre.
  for (const el of controls) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) problems.push(`${label(el)} is covered by ${label(hit)}`);
  }
  window.scrollTo(0, 0);
  return problems;
}

/** Runs in the page: is the newest message fully readable (inside the transcript, not under the dock) and the input on screen? */
function newestInView() {
  const t = document.querySelector('[data-testid=transcript]');
  const last = [...t.querySelectorAll('.msg')].at(-1);
  const input = document.querySelector('[data-testid=text-input]').getBoundingClientRect();
  if (!last) return { ok: false, why: 'no message' };
  const tr = t.getBoundingClientRect();
  const r = last.getBoundingClientRect();
  const bottom = Math.min(tr.bottom, window.innerHeight);
  const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(r.bottom, bottom) - 3);
  const inBox = r.top >= Math.max(tr.top, 0) - 1 && r.bottom <= bottom + 1;
  const uncovered = Boolean(hit) && (hit === last || last.contains(hit));
  const inputOn = input.top >= 0 && input.bottom <= window.innerHeight + 1;
  return {
    ok: inBox && uncovered && inputOn,
    why: `vh ${window.innerHeight}, last ${Math.round(r.top)}..${Math.round(r.bottom)}, transcript ${Math.round(tr.top)}..${Math.round(tr.bottom)}, `
      + `hit ${hit ? hit.className || hit.tagName : null}, input ${Math.round(input.top)}..${Math.round(input.bottom)}`,
  };
}

/** Runs in the page: WCAG contrast of the first `selector` element's text on its own background. */
function textContrast(selector) {
  const el = document.querySelector(selector);
  const cs = getComputedStyle(el);
  const lum = (c) => {
    const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => Number(v) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(cs.color), lum(cs.backgroundColor)].sort((x, y) => y - x);
  return { ratio: (a + 0.05) / (b + 0.05), px: parseFloat(cs.fontSize), color: cs.color, bg: cs.backgroundColor };
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Screenshot `screen` at every viewport width and check its layout there. */
async function shootAll(page, screen, { required, overlap }) {
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await settle(page);
    const problems = await page.evaluate(layoutReport, { required, overlap });
    record(problems.length === 0, `layout ${screen} @${width}px: no sideways scroll, clipping or overlap`,
      problems.slice(0, 8).join('\n        '));
    await settle(page);
    await page.screenshot({ path: path.join(SHOTS, `${screen}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize(DEFAULT_VIEWPORT);
  await settle(page);
}

// ----------------------------------------------------------- speech checks

const norm = (s) => [...String(s).normalize('NFC')].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');

/** Each chunk: one script only, matching lang + voice, and the expected rate. */
function checkChunks(name, chunks, { rate, needLatin = false }) {
  const bad = [];
  let latin = 0;
  for (const c of chunks) {
    const han = /\p{Script=Han}/u.test(c.text);
    const lat = /\p{Script=Latin}/u.test(c.text);
    const thai = /\p{Script=Thai}/u.test(c.text);
    if (!han && !lat && !thai) continue;
    if (han + lat + thai > 1) {
      bad.push(`mixed scripts in one utterance: "${c.text}"`);
      continue;
    }
    if (lat) latin++;
    const want = han ? 'zh' : lat ? 'en' : 'th';
    if (!c.lang.toLowerCase().startsWith(want)) bad.push(`"${c.text}" lang ${c.lang || '(none)'}, want ${want}-*`);
    if (!c.voice || !c.voice.lang.toLowerCase().startsWith(want)) bad.push(`"${c.text}" voice ${c.voice ? c.voice.lang : '(none)'}, want a ${want} voice`);
    if (!(Math.abs(c.rate - rate) <= 0.011)) bad.push(`"${c.text}" rate ${c.rate}, want ${rate}`);
  }
  if (needLatin && !latin) bad.push('no Latin-script utterance although the reply contains English');
  if (!chunks.length) bad.push('nothing spoken');
  return record(bad.length === 0, name, bad.slice(0, 5).join('\n        '));
}

const spokenFrom = (page, from) => page.evaluate((i) => window.__fakeSpeech.spoken.slice(i).filter((s) => s.text.trim()), from);
const spokenCount = (page) => page.evaluate(() => window.__fakeSpeech.spoken.length);
const stateMark = (page) => page.evaluate(() => window.__fakeSpeech.states.length);
const say = (page, text) => page.evaluate((t) => window.__fakeSpeech.queue.push(t), text);

// ------------------------------------------------------------ infrastructure

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn `node server.js` with the mock provider and a fresh DATA_DIR; wait for /api/health. */
async function startServer({ password = '' } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'speaking-e2e-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, LLM_PROVIDER: 'mock', DATA_DIR: dataDir, PORT: String(port), APP_PASSWORD: password, EXPLAIN_LANG: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const running = () => child.exitCode === null && child.signalCode === null;
  const stop = async () => {
    if (running()) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      if (await Promise.race([exited.then(() => true), delay(3000).then(() => false)]) === false) child.kill('SIGKILL');
    }
    await rm(dataDir, { recursive: true, force: true });
  };
  cleanups.push(stop);

  const base = `http://127.0.0.1:${port}`;
  const health = await pollUntil(async () => {
    if (!running()) return null;
    try {
      const res = await fetch(`${base}/api/health`);
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }, 15000);
  if (!health) throw new Error(`server did not become healthy on ${base}\n${output}`);
  return { base, health, output: () => output };
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    console.log(`default chromium launch failed (${err.message.split('\n')[0]}), using /opt/pw-browsers/chromium`);
    return chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
  }
}

/** New context + page with fakes installed and request/error tracking. */
async function openPage(browser, { recognition }) {
  const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT, deviceScaleFactor: 1, locale: 'en-US' });
  await context.addInitScript(installFakes, { recognition });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const track = { chat: [], summary: [], apiErrors: [], pageErrors: [] };
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const p = new URL(req.url()).pathname;
    let body = null;
    try { body = req.postDataJSON(); } catch { /* not JSON */ }
    if (p === '/api/chat') track.chat.push(body);
    else if (p === '/api/summary') track.summary.push(body);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && new URL(res.url()).pathname.startsWith('/api/')) track.apiErrors.push(`${res.status()} ${new URL(res.url()).pathname}`);
  });
  page.on('pageerror', (err) => track.pageErrors.push(err.message));
  return { context, page, track };
}

async function scenario(name, fn) {
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (err) {
    if (err instanceof Abort) record(false, `${name}: aborted after failed step "${err.message}"`);
    else record(false, `${name}: crashed`, err.stack);
  }
}

// ---------------------------------------------------------------- scenarios

const screenIs = (page, id) => waitUntil(page, `only #${id} is visible`,
  (want) => { const s = window.__e2e.screens(); return s.length === 1 && s[0] === want; }, id);

async function mainScenario(browser, server, plan) {
  const day = (n) => plan.find((d) => d.day === n);
  const d3 = day(3);
  const { context, page, track } = await openPage(browser, { recognition: true });
  try {
    await page.goto(`${server.base}/`);

    // Home
    await screenIs(page, 'screen-home');
    await waitUntil(page, 'home shows 30 day buttons day-1..day-30',
      () => { const ids = window.__e2e.dayButtons().map((b) => b.getAttribute('data-testid')); return ids.length === 30 && Array.from({ length: 30 }, (_, i) => `day-${i + 1}`).every((id) => ids.includes(id)); });
    await waitUntil(page, 'fresh log: Day 1 is the only selected day',
      () => { const p = window.__e2e.dayButtons().filter((b) => b.getAttribute('aria-pressed') === 'true'); return p.length === 1 && p[0].getAttribute('data-testid') === 'day-1'; });
    await waitUntil(page, 'title shows Day 1 and its topic',
      (topic) => /\bDay\s*1\b/.test(window.__e2e.text('selected-day-title')) && window.__e2e.text('selected-day-title').includes(topic), day(1).topic);
    await waitUntil(page, 'no day is marked done yet', () => !window.__e2e.dayButtons().some((b) => b.classList.contains('done')));
    await waitUntil(page, 'provider badge says demo mode', () => /demo mode/i.test(window.__e2e.text('provider-badge')) && window.__e2e.visible('provider-badge'), null, { hard: false });

    // Empty history
    await page.click('[data-testid=nav-log]');
    await screenIs(page, 'screen-log');
    await waitUntil(page, 'empty history lists no entry', () => !/\bDay\s*\d/.test(window.__e2e.text('log-list')), null, { hard: false });
    const emptyLines = await page.evaluate(() => document.getElementById('screen-log').innerText.split('\n').map((l) => l.trim()).filter(Boolean));
    await page.click('[data-testid=back]');
    await screenIs(page, 'screen-home');

    // Pick day 3
    await page.click('[data-testid=day-3]');
    await waitUntil(page, 'clicking day 3 selects it (and only it)',
      () => { const p = window.__e2e.dayButtons().filter((b) => b.getAttribute('aria-pressed') === 'true'); return p.length === 1 && p[0].getAttribute('data-testid') === 'day-3'; });
    await waitUntil(page, 'title updates to Day 3 and its topic',
      (topic) => /\bDay\s*3\b/.test(window.__e2e.text('selected-day-title')) && window.__e2e.text('selected-day-title').includes(topic), d3.topic);
    await waitUntil(page, 'day details list Day 3 words and scene',
      ({ words, scene }) => { const t = window.__e2e.text('day-details'); return words.every((w) => t.includes(w)) && t.includes(scene); },
      { words: d3.words, scene: d3.scene }, { hard: false });

    // Start: opening
    await page.click('[data-testid=start]');
    await screenIs(page, 'screen-session');
    const opening = `你好！今天是第3天：${d3.topic}。我们开始吧！你今天怎么样？`;
    await waitUntil(page, 'bot opening appears in the transcript',
      (want) => { const m = window.__e2e.msgs(); return m.length >= 1 && m[0].role === 'bot' && m[0].text === want; }, opening);
    must(track.chat.length === 1 && track.chat[0]?.day === 3 && Array.isArray(track.chat[0]?.messages) && track.chat[0].messages.length === 0,
      'opening is one POST /api/chat with day 3 and messages []', JSON.stringify(track.chat));
    await waitUntil(page, 'opening is spoken completely', (want) => window.__e2e.norm(window.__e2e.spokenSince(0)) === want, norm(opening));
    await waitUntil(page, 'status goes speaking -> listening', () => window.__e2e.hasSeq(['speaking', 'listening']) && window.__e2e.state() === 'listening');
    checkChunks('opening split by script: zh-CN voice for Chinese, en-US for English, rate 0.9', await spokenFrom(page, 0), { rate: 0.9, needLatin: true });
    record(await page.evaluate(() => window.__e2e.text('status').length > 0), 'status has a human-readable label');
    const cfg = await page.evaluate(() => window.__fakeSpeech.config);
    record(cfg?.lang === 'zh-CN' && cfg.interimResults === true && cfg.continuous === false,
      'recognition configured zh-CN, interimResults, not continuous', JSON.stringify(cfg));
    record(await page.evaluate(() => !window.__e2e.visible('voice-warning')), 'voice warning hidden when speech is supported');

    // Voice turn
    let mark = await stateMark(page);
    await say(page, '我叫小明');
    await waitUntil(page, 'spoken "我叫小明" appears as a user message',
      () => window.__e2e.msgs().some((m) => m.role === 'user' && m.text === '我叫小明'));
    await waitUntil(page, 'bot answers the voice turn', () => window.__e2e.msgs().some((m) => m.role === 'bot' && m.text.startsWith('好的！你说：「我叫小明」。')));
    await waitUntil(page, 'status goes thinking -> speaking -> listening after a voice turn',
      (from) => window.__e2e.hasSeq(['thinking', 'speaking', 'listening'], from) && window.__e2e.state() === 'listening', mark);
    const interim = await page.evaluate(() => window.__fakeSpeech.interimSeen);
    record(interim.some((t) => t && t.includes('我叫')), 'interim text shows the partial transcript', JSON.stringify(interim));
    const t2 = track.chat.at(-1);
    record(track.chat.length === 2 && t2?.day === 3 && t2.messages.at(-1)?.role === 'user' && t2.messages.at(-1)?.text === '我叫小明' && t2.messages[0]?.text === opening,
      'voice turn sends the history with the user text last', JSON.stringify(t2));

    // Typed turn
    mark = await stateMark(page);
    await page.fill('[data-testid=text-input]', '我是泰国人');
    await page.click('[data-testid=send]');
    await waitUntil(page, 'typed "我是泰国人" appears as a user message', () => window.__e2e.msgs().some((m) => m.role === 'user' && m.text === '我是泰国人'));
    await waitUntil(page, 'bot answers the typed turn', () => window.__e2e.msgs().some((m) => m.role === 'bot' && m.text.startsWith('好的！你说：「我是泰国人」。')));
    await waitUntil(page, 'back to listening after the typed turn',
      (from) => window.__e2e.hasSeq(['speaking', 'listening'], from) && window.__e2e.state() === 'listening', mark);
    record(track.chat.length === 3 && track.chat.at(-1)?.messages.at(-1)?.text === '我是泰国人', 'typed turn is exactly one more POST /api/chat', `chat calls: ${track.chat.length}`);
    const expectedOrder = await page.evaluate(() => window.__e2e.msgs().slice(0, 5).map((m) => m.role).join(','));
    record(expectedOrder === 'bot,user,bot,user,bot', 'transcript order is bot,user,bot,user,bot', expectedOrder);

    // 再说一遍: local repeat
    const lastBot = await page.evaluate(() => window.__e2e.msgs().filter((m) => m.role === 'bot').at(-1).text);
    let chatBefore = track.chat.length;
    let spokeFrom = await spokenCount(page);
    mark = await stateMark(page);
    await say(page, '再说一遍');
    await waitUntil(page, '"再说一遍" speaks the last reply again', ({ from, want }) => window.__e2e.norm(window.__e2e.spokenSince(from)) === want, { from: spokeFrom, want: norm(lastBot) });
    await waitUntil(page, 'back to listening after the repeat',
      (from) => window.__e2e.hasSeq(['speaking', 'listening'], from) && window.__e2e.state() === 'listening', mark);
    await delay(300);
    record(track.chat.length === chatBefore, '"再说一遍" makes no API call', `chat calls ${chatBefore} -> ${track.chat.length}`);

    // Slower
    await page.click('[data-testid=slower]');
    await waitUntil(page, 'slower toggle is aria-pressed=true', () => window.__e2e.q('slower')?.getAttribute('aria-pressed') === 'true');

    // Pause
    await page.click('[data-testid=pause]');
    await waitUntil(page, 'pause: status paused', () => window.__e2e.state() === 'paused');
    await waitUntil(page, 'pause: recognition stopped and speech silent', () => window.__fakeSpeech.active === 0 && !window.speechSynthesis.speaking);
    record(/resume/i.test(await page.evaluate(() => window.__e2e.text('pause'))), 'pause button now reads Resume');
    const startsPaused = await page.evaluate(() => window.__fakeSpeech.starts);
    await delay(600);
    record(await page.evaluate((s) => window.__fakeSpeech.starts === s && window.__e2e.state() === 'paused', startsPaused), 'paused: no listening restarts');

    await shootAll(page, 'session', { required: ['status', 'transcript', ...SESSION_CONTROLS], overlap: SESSION_CONTROLS });
    for (const [width, height] of [[390, 844], [390, 500], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await settle(page);
      const view = await page.evaluate(newestInView);
      record(view.ok, `resize to ${width}x${height}: newest message still fully visible, input on screen`, view.why);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await settle(page);
      for (const sel of ['.msg.user', '.msg.bot']) {
        const c = await page.evaluate(textContrast, sel);
        record(c.ratio >= 4.5, `${colorScheme} mode @390px: ${sel} text contrast >= 4.5:1 (${c.ratio.toFixed(2)})`, `${c.color} on ${c.bg}, ${c.px}px`);
      }
    }
    await page.emulateMedia({ colorScheme: null });
    await page.setViewportSize(DEFAULT_VIEWPORT);
    await settle(page);

    // Resume + silent rounds (no-speech error, then bare onend) must keep the loop alive
    const e0 = await page.evaluate(() => ({ empty: window.__fakeSpeech.emptyRounds, noSpeech: window.__fakeSpeech.noSpeechErrors, silent: window.__fakeSpeech.silentEnds }));
    mark = await stateMark(page);
    await page.click('[data-testid=pause]');
    await waitUntil(page, 'resume: status listening again', () => window.__e2e.state() === 'listening' && window.__fakeSpeech.active === 1);
    record(/pause/i.test(await page.evaluate(() => window.__e2e.text('pause'))), 'pause button reads Pause again');
    await waitUntil(page, 'silence (no-speech error and bare end) restarts listening',
      (e) => { const f = window.__fakeSpeech; return f.emptyRounds >= e.empty + 2 && f.noSpeechErrors > e.noSpeech && f.silentEnds > e.silent && f.starts > f.startsAtLastEmpty && f.active === 1; }, e0);
    record(await page.evaluate((from) => !window.__fakeSpeech.states.slice(from).includes('error') && window.__e2e.state() === 'listening' && !window.__e2e.visible('voice-warning'), mark),
      'silence does not put the session into error');

    spokeFrom = await spokenCount(page);
    chatBefore = track.chat.length;
    await say(page, '我喜欢爬楼梯');
    await waitUntil(page, 'voice turn after silence is heard', () => window.__e2e.msgs().some((m) => m.role === 'user' && m.text === '我喜欢爬楼梯'));
    await waitUntil(page, 'bot answers after resume', () => window.__e2e.msgs().some((m) => m.role === 'bot' && m.text.startsWith('好的！你说：「我喜欢爬楼梯」。')));
    const reply4 = await page.evaluate(() => window.__e2e.msgs().filter((m) => m.role === 'bot').at(-1).text);
    await waitUntil(page, 'reply after resume is spoken', ({ from, want }) => window.__e2e.norm(window.__e2e.spokenSince(from)) === want, { from: spokeFrom, want: norm(reply4) });
    checkChunks('slower on: reply spoken at rate 0.7', await spokenFrom(page, spokeFrom), { rate: 0.7 });
    record(track.chat.length === chatBefore + 1, 'one API call for the turn after resume', `${chatBefore} -> ${track.chat.length}`);
    await waitUntil(page, 'listening again before finishing', () => window.__e2e.state() === 'listening');

    // 总结
    chatBefore = track.chat.length;
    await say(page, '总结');
    await screenIs(page, 'screen-summary');
    await waitUntil(page, 'summary lists the Day 3 words', (words) => {
      const items = window.__e2e.q('summary-words')?.querySelectorAll('li') ?? [];
      const t = window.__e2e.text('summary-words');
      return items.length >= 1 && words.every((w) => t.includes(w));
    }, d3.words);
    await waitUntil(page, 'summary lists mistakes', () => (window.__e2e.q('summary-mistakes')?.querySelectorAll('li').length ?? 0) >= 1 && window.__e2e.text('summary-mistakes').includes('(mock)'));
    await waitUntil(page, 'summary shows the practice sentence', (want) => window.__e2e.text('summary-practice').includes(want), `我今天练习了${d3.topic}。`);
    record(track.chat.length === chatBefore, '"总结" is a command, not a chat turn', `${chatBefore} -> ${track.chat.length}`);
    const sum = track.summary;
    const userTexts = (sum[0]?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.text);
    record(sum.length === 1 && sum[0].day === 3 && ['我叫小明', '我是泰国人', '我喜欢爬楼梯'].every((t) => userTexts.includes(t)),
      'one POST /api/summary with day 3 and the whole conversation', JSON.stringify(sum));
    await waitUntil(page, 'finish stops listening and speaking', () => window.__fakeSpeech.active === 0 && !window.speechSynthesis.speaking);
    await shootAll(page, 'summary', { required: ['summary-words', 'summary-mistakes', 'summary-practice', 'home'], overlap: ['summary-words', 'summary-mistakes', 'summary-practice', 'home'] });

    // Home again
    await page.click('[data-testid=home]');
    await screenIs(page, 'screen-home');
    await waitUntil(page, 'day 3 is marked done (and only day 3)',
      () => { const d = window.__e2e.dayButtons().filter((b) => b.classList.contains('done')); return d.length === 1 && d[0].getAttribute('data-testid') === 'day-3'; });
    await waitUntil(page, 'selected day moves to 4',
      () => { const p = window.__e2e.dayButtons().filter((b) => b.getAttribute('aria-pressed') === 'true'); return p.length === 1 && p[0].getAttribute('data-testid') === 'day-4' && /\bDay\s*4\b/.test(window.__e2e.text('selected-day-title')); });
    await shootAll(page, 'home', { required: ['selected-day-title', 'day-details', 'start', 'day-grid', 'nav-log', ...DAY_IDS], overlap: ['start', 'nav-log', ...DAY_IDS] });

    // History
    await page.click('[data-testid=nav-log]');
    await screenIs(page, 'screen-log');
    await waitUntil(page, 'history shows exactly 1 entry for Day 3', (topic) => {
      const list = window.__e2e.q('log-list');
      if (!list) return false;
      const lis = list.querySelectorAll('li');
      const items = (lis.length ? [...lis] : [...list.children]).filter(window.__e2e.vis);
      return items.length === 1 && items[0].textContent.includes(topic) && /\b3\b/.test(items[0].textContent);
    }, d3.topic);
    const fullLines = await page.evaluate(() => document.getElementById('screen-log').innerText.split('\n').map((l) => l.trim()));
    record(emptyLines.some((l) => !fullLines.includes(l)), 'history had an empty-state text that is gone once there is an entry', JSON.stringify(emptyLines));
    await shootAll(page, 'history', { required: ['log-list', 'back'], overlap: ['log-list', 'back'] });
    await page.click('[data-testid=back]');
    await screenIs(page, 'screen-home');

    const log = await (await fetch(`${server.base}/api/log`)).json();
    record(log.entries?.length === 1 && log.entries[0].day === 3 && log.entries[0].turns >= 3, 'server log has one Day 3 entry with the user turns', JSON.stringify(log));

    const fake = await page.evaluate(() => window.__fakeSpeech);
    record(fake.startedWhileSpeaking === 0, 'never listened while speaking', `${fake.startedWhileSpeaking} starts while speaking`);
    record(fake.doubleStarts === 0 && fake.concurrent === 0, 'recognition never double-started', `double ${fake.doubleStarts}, concurrent ${fake.concurrent}`);
    record(!fake.states.includes('error'), 'status never entered error', fake.states.join(' > '));
  } finally {
    record(track.apiErrors.length === 0, 'main run: no API errors', track.apiErrors.join(', '));
    record(track.pageErrors.length === 0, 'main run: no uncaught page errors', track.pageErrors.join(' | '));
    await context.close();
  }
}

async function unsupportedScenario(browser, server) {
  const { context, page, track } = await openPage(browser, { recognition: false });
  try {
    await page.goto(`${server.base}/`);
    must(await page.evaluate(() => !(window.SpeechRecognition || window.webkitSpeechRecognition)), 'SpeechRecognition removed for this run');
    await waitUntil(page, 'home loads', () => window.__e2e.dayButtons().length === 30);
    await waitUntil(page, 'day 4 is selected from the log', () => window.__e2e.q('day-4')?.getAttribute('aria-pressed') === 'true', null, { hard: false });
    await page.click('[data-testid=start]');
    await screenIs(page, 'screen-session');
    await waitUntil(page, 'opening still arrives without speech recognition',
      () => window.__e2e.msgs().some((m) => m.role === 'bot' && m.text.includes('第4天')));
    await waitUntil(page, 'voice warning is visible', () => window.__e2e.visible('voice-warning') && window.__e2e.text('voice-warning').length > 0);
    await page.fill('[data-testid=text-input]', '你好');
    await page.click('[data-testid=send]');
    await waitUntil(page, 'typed message is sent', () => window.__e2e.msgs().some((m) => m.role === 'user' && m.text === '你好'));
    await waitUntil(page, 'typed message gets a reply', () => window.__e2e.msgs().some((m) => m.role === 'bot' && m.text.startsWith('好的！你说：「你好」。')));
    record(track.chat.length === 2, 'two chat calls (opening + typed)', `${track.chat.length}`);
  } finally {
    record(track.pageErrors.length === 0, 'unsupported run: no uncaught page errors', track.pageErrors.join(' | '));
    await context.close();
  }
}

/** Voice commands 慢一点 / 暂停, busy + network errors, reload-resume, finish without turns. */
async function resilienceScenario(browser, server, plan) {
  const d6 = plan.find((d) => d.day === 6);
  const { context, page, track } = await openPage(browser, { recognition: true });
  const botCount = () => page.evaluate(() => window.__e2e.msgs().filter((m) => m.role === 'bot').length);
  try {
    await page.goto(`${server.base}/`);
    await waitUntil(page, 'home loads', () => window.__e2e.dayButtons().length === 30);
    await page.click('[data-testid=day-6]');
    await page.click('[data-testid=start]');
    await screenIs(page, 'screen-session');
    await waitUntil(page, 'day 6 opening arrives and the loop listens',
      () => window.__e2e.msgs().some((m) => m.role === 'bot' && m.text.includes('第6天')) && window.__e2e.state() === 'listening');

    // 慢一点: slower on AND sent to the partner
    let spokeFrom = await spokenCount(page);
    await say(page, '慢一点');
    await waitUntil(page, '"慢一点" turns slower on', () => window.__e2e.q('slower')?.getAttribute('aria-pressed') === 'true');
    await waitUntil(page, '"慢一点" is also sent to the partner',
      () => window.__e2e.msgs().some((m) => m.role === 'bot' && m.text.startsWith('好的！你说：「慢一点」。')) && window.__e2e.state() === 'listening');
    record(track.chat.at(-1)?.messages.at(-1)?.text === '慢一点', '"慢一点" chat request carries the text', JSON.stringify(track.chat.at(-1)));
    checkChunks('"慢一点" reply spoken at rate 0.7', await spokenFrom(page, spokeFrom), { rate: 0.7 });

    // 503 busy: notice, transcript kept, back to listening
    await page.route('**/api/chat', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' }), { times: 1 });
    let bots = await botCount(page);
    await say(page, '我很忙');
    await waitUntil(page, 'busy: notice "AI is busy" appears in the transcript',
      () => [...document.querySelectorAll('[data-testid=transcript] .msg.notice')].some((m) => /AI is busy/i.test(m.textContent)));
    await waitUntil(page, 'busy: back to listening, user text kept',
      () => window.__e2e.state() === 'listening' && window.__e2e.msgs().some((m) => m.role === 'user' && m.text === '我很忙'));
    record(await botCount(page) === bots, 'busy: no fake bot reply added', `${bots} -> ${await botCount(page)}`);
    await say(page, '你呢');
    await waitUntil(page, 'after busy the next turn gets a reply',
      () => window.__e2e.msgs().some((m) => m.role === 'bot' && m.text.startsWith('好的！你说：「你呢」。')) && window.__e2e.state() === 'listening');
    const afterBusy = track.chat.at(-1)?.messages.filter((m) => m.role === 'user').map((m) => m.text) ?? [];
    record(afterBusy.includes('我很忙') && afterBusy.at(-1) === '你呢', 'the unanswered turn is kept in the history sent to the server', JSON.stringify(afterBusy));

    // Network failure once: retried, reply still arrives
    await page.route('**/api/chat', (route) => route.abort('failed'), { times: 1 });
    const chatBefore = track.chat.length;
    bots = await botCount(page);
    await say(page, '我喝茶');
    await waitUntil(page, 'network error: retried and answered',
      () => window.__e2e.msgs().some((m) => m.role === 'bot' && m.text.startsWith('好的！你说：「我喝茶」。')) && window.__e2e.state() === 'listening');
    record(track.chat.length === chatBefore + 2 && await botCount(page) === bots + 1, 'network error: exactly one retry, one reply', `${chatBefore} -> ${track.chat.length}`);

    // 暂停: pauses, no API call
    const beforePause = track.chat.length;
    await say(page, '暂停');
    await waitUntil(page, '"暂停" pauses the session', () => window.__e2e.state() === 'paused' && window.__fakeSpeech.active === 0);
    record(track.chat.length === beforePause, '"暂停" makes no API call', `${beforePause} -> ${track.chat.length}`);

    // Accidental reload: resume banner restores the conversation
    const before = await page.evaluate(() => window.__e2e.msgs().filter((m) => m.role !== '?'));
    await page.reload();
    await screenIs(page, 'screen-home');
    await waitUntil(page, 'after reload the resume banner offers Day 6',
      () => window.__e2e.visible('resume-banner') && /Day\s*6\b/.test(window.__e2e.text('resume-banner')));
    await shootAll(page, 'home-resume', { required: ['resume-banner', 'resume', 'discard', 'start'], overlap: ['resume', 'discard', 'start', 'nav-log'] });
    const chatBeforeResume = track.chat.length;
    await page.click('[data-testid=resume]');
    await screenIs(page, 'screen-session');
    await waitUntil(page, 'resume restores the transcript', (want) => {
      const got = window.__e2e.msgs();
      return got.length === want.length && got.every((m, i) => m.role === want[i].role && m.text === want[i].text);
    }, before);
    await waitUntil(page, 'resume re-speaks the last reply, then listens', () => window.__e2e.state() === 'listening');
    record(track.chat.length === chatBeforeResume, 'resume makes no API call when the last message is a reply', `${chatBeforeResume} -> ${track.chat.length}`);

    // Finish: day 6 done, next suggested day is 7, banner gone
    await page.click('[data-testid=end]');
    await screenIs(page, 'screen-summary');
    await waitUntil(page, 'day 6 summary lists its words', (words) => words.every((w) => window.__e2e.text('summary-words').includes(w)), d6.words);
    await page.click('[data-testid=home]');
    await screenIs(page, 'screen-home');
    await waitUntil(page, 'days 3 and 6 done, Day 7 suggested, no resume banner', () => {
      const done = window.__e2e.dayButtons().filter((b) => b.classList.contains('done')).map((b) => b.getAttribute('data-testid'));
      return done.join() === 'day-3,day-6' && window.__e2e.q('day-7')?.getAttribute('aria-pressed') === 'true' && !window.__e2e.visible('resume-banner');
    });

    // Finish with no user turn: straight home, no summary call
    const summaries = track.summary.length;
    await page.click('[data-testid=start]');
    await waitUntil(page, 'day 7 session listening', () => window.__e2e.state() === 'listening' && window.__e2e.msgs().length === 1);
    await page.click('[data-testid=end]');
    await screenIs(page, 'screen-home');
    record(track.summary.length === summaries, 'finish without speaking makes no summary call', `${summaries} -> ${track.summary.length}`);
    await waitUntil(page, 'no speech or listening left running', () => window.__fakeSpeech.active === 0 && !window.speechSynthesis.speaking);
  } finally {
    const unexpected = track.apiErrors.filter((e) => e !== '503 /api/chat');
    record(unexpected.length === 0, 'resilience run: no unexpected API errors', unexpected.join(', '));
    record(track.pageErrors.length === 0, 'resilience run: no uncaught page errors', track.pageErrors.join(' | '));
    await context.close();
  }
}

/** An hour-long session (650 messages), mic denied then allowed, phone keyboard, failed summary, leave + resume. */
async function longSessionScenario(browser, server) {
  const { context, page, track } = await openPage(browser, { recognition: true });
  const noticeCount = () => page.evaluate(() => document.querySelectorAll('[data-testid=transcript] .msg.notice').length);
  try {
    await page.goto(`${server.base}/`);
    await waitUntil(page, 'home loads', () => window.__e2e.dayButtons().length === 30);
    // 325 turns, newest message a partner reply (resume re-speaks it, no API call).
    const seeded = Array.from({ length: 650 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: i % 2 ? `很好！第${i}句。` : `我走了${i}步` }));
    await page.evaluate((messages) => localStorage.setItem('speaking.session', JSON.stringify({ day: 8, messages, at: Date.now() })), seeded);
    await page.reload();
    await waitUntil(page, 'resume banner offers the long Day 8 session', () => window.__e2e.visible('resume-banner') && /Day\s*8\b/.test(window.__e2e.text('resume-banner')));
    await page.click('[data-testid=resume]');
    await screenIs(page, 'screen-session');
    await waitUntil(page, 'long session resumes and listens', () => window.__e2e.state() === 'listening' && window.__e2e.msgs().length === 650);
    await waitUntil(page, 'wake lock held while the loop runs', () => window.__fakeSpeech.wakeHeld === 1);

    // Mic denied: error, warning, typed input focused; allowed again: Resume clears the warning.
    await page.evaluate(() => { window.__fakeSpeech.deny = 1; });
    await waitUntil(page, 'mic denied: status error and the warning shows',
      () => window.__e2e.state() === 'error' && window.__e2e.visible('voice-warning') && /blocked/i.test(window.__e2e.text('voice-warning')));
    record(await page.evaluate(() => document.activeElement === window.__e2e.q('text-input')), 'mic denied: typed input has focus');
    record(/resume/i.test(await page.evaluate(() => window.__e2e.text('pause'))), 'mic denied: pause button reads Resume');
    await page.click('[data-testid=pause]');
    await waitUntil(page, 'mic allowed + Resume: listening and the warning is gone',
      () => window.__e2e.state() === 'listening' && window.__fakeSpeech.active === 1 && !window.__e2e.visible('voice-warning'));

    // Turn 326 by voice: the chat request carries only the newest 200 messages.
    const chatBefore = track.chat.length;
    await say(page, '我叫小明');
    await waitUntil(page, 'turn 326 gets a reply (history over the 200-message limit)',
      () => window.__e2e.msgs().some((m) => m.role === 'bot' && m.text.startsWith('好的！你说：「我叫小明」。')) && window.__e2e.state() === 'listening');
    const sent = track.chat.at(-1)?.messages ?? [];
    record(track.chat.length === chatBefore + 1 && sent.length === 200 && sent.at(-1)?.text === '我叫小明',
      'chat sends the newest 200 messages, ending with the user turn', `${sent.length} messages, last ${JSON.stringify(sent.at(-1))}`);

    // Phone keyboard open (viewport shrinks to 500px): the reply stays readable above the dock.
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await page.focus('[data-testid=text-input]');
    await page.setViewportSize({ width: 390, height: 500 });
    await settle(page);
    let view = await page.evaluate(newestInView);
    record(view.ok, 'keyboard open (390x500): newest message and input visible', view.why);
    await page.fill('[data-testid=text-input]', '我今天很好');
    await page.press('[data-testid=text-input]', 'Enter');
    await waitUntil(page, 'keyboard open: typed turn gets a reply',
      () => window.__e2e.msgs().at(-1)?.role === 'bot' && window.__e2e.msgs().at(-1).text.startsWith('好的！你说：「我今天很好」。'));
    await settle(page);
    view = await page.evaluate(newestInView);
    record(view.ok, 'keyboard open: the new reply is not under the controls and the input stays on screen', view.why);
    const layout = await page.evaluate(layoutReport, { required: ['status', 'transcript', ...SESSION_CONTROLS], overlap: SESSION_CONTROLS });
    record(layout.length === 0, 'keyboard open: no sideways scroll, clipping or overlap', layout.slice(0, 8).join('\n        '));
    await page.screenshot({ path: path.join(SHOTS, 'session-keyboard-390.png') });
    await page.setViewportSize(DEFAULT_VIEWPORT);
    await settle(page);

    // 总结 while the AI is busy: notice spoken, back to listening with the wake lock, transcript kept.
    await page.route('**/api/summary', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' }), { times: 1 });
    const msgCount = await page.evaluate(() => window.__e2e.msgs().length);
    const notices = await noticeCount();
    const spokeFrom = await spokenCount(page);
    await waitUntil(page, 'listening before 总结', () => window.__e2e.state() === 'listening');
    await say(page, '总结');
    await waitUntil(page, 'summary busy: notice in the transcript',
      (n) => document.querySelectorAll('[data-testid=transcript] .msg.notice').length === n + 1
        && /AI is busy/i.test([...document.querySelectorAll('[data-testid=transcript] .msg.notice')].at(-1).textContent), notices);
    await waitUntil(page, 'summary busy: notice spoken, then listening again',
      (from) => /AIisbusy/i.test(window.__e2e.norm(window.__e2e.spokenSince(from))) && window.__e2e.state() === 'listening' && window.__fakeSpeech.active === 1, spokeFrom);
    record(await page.evaluate(() => window.__fakeSpeech.wakeHeld) === 1, 'summary busy: wake lock taken again', `held ${await page.evaluate(() => window.__fakeSpeech.wakeHeld)}`);
    record(await page.evaluate(() => window.__e2e.msgs().filter((m) => m.role !== '?').length) === msgCount && await screenIs(page, 'screen-session'),
      'summary busy: transcript kept, still on the session');

    // Leave without a summary, then resume from home and finish.
    await page.click('[data-testid=leave]');
    await screenIs(page, 'screen-home');
    await waitUntil(page, 'leave: wake lock released, nothing listening', () => window.__fakeSpeech.wakeHeld === 0 && window.__fakeSpeech.active === 0);
    await waitUntil(page, 'leave: resume banner offers Day 8 again', () => window.__e2e.visible('resume-banner') && /Day\s*8\b/.test(window.__e2e.text('resume-banner')));
    await page.click('[data-testid=resume]');
    await screenIs(page, 'screen-session');
    await waitUntil(page, 'resumed session listens', () => window.__e2e.state() === 'listening');
    const summaries = track.summary.length;
    await say(page, '总结');
    await screenIs(page, 'screen-summary');
    const body = track.summary.at(-1);
    record(track.summary.length === summaries + 1 && body?.messages?.length === 600 && body.day === 8,
      'second 总结 sends the newest 600 messages and saves the summary', `${track.summary.length - summaries} calls, ${body?.messages?.length} messages`);
    await waitUntil(page, 'summary saved: wake lock released', () => window.__fakeSpeech.wakeHeld === 0);
  } finally {
    const unexpected = track.apiErrors.filter((e) => e !== '503 /api/summary');
    record(unexpected.length === 0, 'long run: no unexpected API errors (no 400 over the limit)', unexpected.join(', '));
    record(track.pageErrors.length === 0, 'long run: no uncaught page errors', track.pageErrors.join(' | '));
    await context.close();
  }
}

async function passwordScenario(browser) {
  const server = await startServer({ password: PASSWORD });
  must(server.health.passwordRequired === true, 'password server reports passwordRequired');
  const plain = await fetch(`${server.base}/api/plan`);
  record(plain.status === 401, 'API without password is 401', `${plain.status}`);

  const { context, page, track } = await openPage(browser, { recognition: true });
  try {
    await page.goto(`${server.base}/`);
    await waitUntil(page, 'password form is shown', () => window.__e2e.visible('password-form') && window.__e2e.visible('password') && window.__e2e.visible('password-submit'));
    await shootAll(page, 'password', { required: ['password-form', 'password', 'password-submit'], overlap: ['password', 'password-submit'] });

    const wrong = page.waitForResponse((res) => /^\/api\/(?!health)/.test(new URL(res.url()).pathname)
      && res.request().headers()['x-app-password'] === encodeURIComponent(WRONG_PASSWORD), { timeout: TIMEOUT });
    await page.fill('[data-testid=password]', WRONG_PASSWORD);
    await page.click('[data-testid=password-submit]');
    const res = await wrong.catch(() => null);
    must(res?.status() === 401, 'wrong (Thai) password is sent encoded and rejected with 401', res ? `${res.status()}` : 'no request carried the typed password');
    await delay(300);
    await waitUntil(page, 'wrong password: form stays', () => window.__e2e.visible('password-form') && window.__e2e.dayButtons().length === 0);
    await shootAll(page, 'password-wrong', { required: ['password-form', 'password', 'password-submit'], overlap: ['password', 'password-submit'] });

    await page.fill('[data-testid=password]', PASSWORD);
    await page.click('[data-testid=password-submit]');
    await waitUntil(page, 'right password (Thai + Chinese): form goes away and home loads',
      () => !window.__e2e.visible('password-form') && window.__e2e.visible('start') && window.__e2e.dayButtons().length === 30);
    await page.reload();
    await waitUntil(page, 'after reload the stored password is reused',
      () => window.__e2e.dayButtons().length === 30 && window.__e2e.visible('start'));
    record(await page.evaluate(() => !window.__e2e.visible('password-form')), 'after reload no password prompt');
  } finally {
    record(track.pageErrors.length === 0, 'password run: no uncaught page errors', track.pageErrors.join(' | '));
    await context.close();
  }
}

// --------------------------------------------------------------------- main

let cleaning = null;
function cleanup() {
  cleaning ??= (async () => {
    for (const fn of cleanups.reverse()) {
      try { await fn(); } catch (err) { console.error('cleanup failed:', err.message); }
    }
  })();
  return cleaning;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.log(`\n${signal}: shutting down`);
    cleanup().finally(() => process.exit(130));
  });
}

try {
  await mkdir(SHOTS, { recursive: true });
  const browser = await launchBrowser();
  cleanups.push(() => browser.close());

  const server = await startServer();
  record(server.health.provider === 'mock' && server.health.passwordRequired === false, 'server healthy: mock provider, no password', JSON.stringify(server.health));
  const { days: plan } = await (await fetch(`${server.base}/api/plan`)).json();
  must(Array.isArray(plan) && plan.length === 30, '/api/plan returns 30 days');

  await scenario('Main scenario', () => mainScenario(browser, server, plan));
  await scenario('Unsupported speech', () => unsupportedScenario(browser, server));
  await scenario('Commands, errors and resume', () => resilienceScenario(browser, server, plan));
  await scenario('Long session, mic recovery, keyboard and summary retry', () => longSessionScenario(browser, server));
  await scenario('Password gate', () => passwordScenario(browser));
} catch (err) {
  record(false, 'harness setup', err instanceof Abort ? err.message : err.stack);
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} FAILED:` : ''}`);
for (const f of failed) console.log(`  FAIL  ${f.name}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
