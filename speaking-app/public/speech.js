/**
 * Hands-free voice loop: the partner speaks, then we listen, then we ask the
 * server, then the partner speaks again, until the user pauses or finishes.
 *
 * Browser speech globals are read in start(), never at import time, so tests
 * can install fake SpeechRecognition / speechSynthesis before a session.
 */

const RESTART_MS = 350;
const RETRY_MS = 1500;
const MAX_START_FAILURES = 5;
const RATE_NORMAL = 0.9;
const RATE_SLOW = 0.7;
// Server limits (lib/app.js): messages per request, and the 1mb JSON body.
const CHAT_WINDOW = 200;
const SUMMARY_WINDOW = 600;
const WINDOW_CHARS = 200000;

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '.']);
const CLOSERS = new Set(['」', '』', '”', '"', '’', '\'', '）', ')', '】', '》']);
const BLOCKING_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);

const COMMANDS = new Map([
  ['总结', 'finish'], ['总结吧', 'finish'], ['总结一下', 'finish'],
  ['结束', 'finish'], ['结束吧', 'finish'],
  ['再说一遍', 'repeat'], ['请再说一遍', 'repeat'], ['再说一次', 'repeat'],
  ['慢一点', 'slower'], ['慢一点儿', 'slower'], ['请慢一点', 'slower'], ['说慢一点', 'slower'],
  ['暂停', 'pause'],
]);

/** Maps a final transcript to a voice command, ignoring punctuation and spaces. */
export function commandOf(text) {
  const key = String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
  return COMMANDS.get(key) || null;
}

/** The newest messages within `max` items and `maxChars` of text, oldest first. */
export function recentMessages(messages, max, maxChars = WINDOW_CHARS) {
  const out = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && out.length < max; i -= 1) {
    chars += String(messages[i].text).length;
    if (chars > maxChars && out.length) break;
    out.push(messages[i]);
  }
  return out.reverse();
}

/** Splits a reply into speakable chunks by sentence and by script (zh / en / th). */
export function splitForSpeech(text) {
  const chunks = [];
  for (const sentence of splitSentences(String(text ?? ''))) {
    for (const run of splitScripts(sentence)) {
      for (const piece of splitLong(run.text, run.lang === 'zh-CN' ? 40 : 160)) {
        chunks.push({ text: piece, lang: run.lang });
      }
    }
  }
  return chunks;
}

function splitSentences(text) {
  const chars = Array.from(text);
  const out = [];
  let cur = '';
  let ending = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '\n' || ch === '\r') {
      out.push(cur);
      cur = '';
      ending = false;
      continue;
    }
    if (ending && !SENTENCE_END.has(ch) && !CLOSERS.has(ch)) {
      out.push(cur);
      cur = '';
      ending = false;
    }
    cur += ch;
    // "3.5" is not a sentence end.
    if (SENTENCE_END.has(ch) && !(ch === '.' && /\d/.test(chars[i + 1] || ''))) ending = true;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function scriptOf(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x0e00 && c <= 0x0e7f) return 'th-TH';
  if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x2fa1f)) return 'zh-CN';
  if (/\p{L}/u.test(ch)) return 'en-US';
  return null; // digits, spaces, punctuation stick to the surrounding run
}

function splitScripts(sentence) {
  const runs = [];
  let cur = null;
  let lead = '';
  for (const ch of sentence) {
    const lang = scriptOf(ch);
    if (!lang) {
      if (cur) cur.text += ch;
      else lead += ch;
    } else if (!cur || cur.lang !== lang) {
      cur = { lang, text: lead + ch };
      lead = '';
      runs.push(cur);
    } else {
      cur.text += ch;
    }
  }
  if (!runs.length && /\p{N}/u.test(lead)) runs.push({ lang: 'zh-CN', text: lead });
  return runs
    .map((run) => ({ lang: run.lang, text: run.text.trim() }))
    .filter((run) => /[\p{L}\p{N}]/u.test(run.text));
}

function splitLong(text, max) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (const mark of ['，', ',', '、', ' ']) {
      const at = rest.lastIndexOf(mark, max);
      if (at > max / 3) {
        cut = at + 1;
        break;
      }
    }
    if (cut < 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts.filter(Boolean);
}

function pickVoice(synth, lang) {
  let voices = [];
  try {
    voices = synth.getVoices?.() || [];
  } catch {
    return null;
  }
  const norm = (v) => String(v.lang || '').replace('_', '-').toLowerCase();
  const want = lang.toLowerCase();
  const exact = voices.filter((v) => norm(v) === want);
  if (exact.length) return exact.find((v) => v.localService) || exact[0];
  if (want === 'zh-cn') {
    // Mandarin fallbacks only: zh-HK / yue voices speak Cantonese.
    return voices.find((v) => /^(zh-tw|cmn)/.test(norm(v))) || null;
  }
  const base = want.split('-')[0];
  return voices.find((v) => norm(v).startsWith(base)) || null;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Speaks chunked text one utterance at a time; cancel() resolves the current one. */
class Speaker {
  constructor(synth, Utterance) {
    this.synth = synth;
    this.Utterance = Utterance;
    this.stop = null;
    this.utterance = null; // keep a reference: Chrome may GC it and never fire onend
  }

  get busy() {
    return Boolean(this.stop);
  }

  make(text) {
    if (this.Utterance) {
      try {
        return new this.Utterance(text);
      } catch {
        // fall through to a plain object
      }
    }
    return { text };
  }

  /** iOS only allows speech after one speak() inside a user gesture. */
  prime() {
    if (!this.synth) return;
    try {
      this.synth.getVoices?.();
      const u = this.make('');
      u.volume = 0;
      this.synth.speak(u);
    } catch {
      // priming is best effort
    }
  }

  async say(text, { rate, live }) {
    if (!this.synth) return;
    for (const chunk of splitForSpeech(text)) {
      if (!live()) return;
      await this.utter(chunk, rate());
    }
  }

  utter({ text, lang }, rate) {
    return new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        clearTimeout(timer);
        if (this.stop === done) {
          this.stop = null;
          this.utterance = null;
        }
        resolve();
      };
      const u = this.make(text);
      u.lang = lang;
      u.rate = rate;
      const voice = pickVoice(this.synth, lang);
      if (voice) u.voice = voice;
      u.onend = done;
      u.onerror = done;
      this.stop = done;
      this.utterance = u;
      // Watchdog: some browsers never fire onend.
      timer = setTimeout(done, 2500 + (Array.from(text).length * 320) / rate);
      try {
        this.synth.resume?.();
        this.synth.speak(u);
      } catch {
        done();
      }
    });
  }

  cancel() {
    const stop = this.stop;
    if (!stop) return;
    this.stop = null;
    try {
      this.synth.cancel?.();
    } catch {
      // nothing to cancel
    }
    stop();
  }
}

let onceToken = 0;

/** Reads a text aloud outside a session (e.g. the practice sentence). */
export function speakOnce(text, { slower = false } = {}) {
  const synth = globalThis.speechSynthesis || null;
  if (!synth) return Promise.resolve(false);
  const token = ++onceToken;
  try {
    synth.cancel?.();
  } catch {
    // ignore
  }
  const speaker = new Speaker(synth, globalThis.SpeechSynthesisUtterance || null);
  return speaker
    .say(text, { rate: () => (slower ? RATE_SLOW : RATE_NORMAL), live: () => token === onceToken })
    .then(() => true);
}

export function canSpeak() {
  return Boolean(globalThis.speechSynthesis);
}

function createWakeLock() {
  let wanted = false;
  let pending = false;
  let sentinel = null;
  const request = async () => {
    const api = globalThis.navigator?.wakeLock;
    if (!wanted || sentinel || pending || !api || document.visibilityState !== 'visible') return;
    pending = true;
    try {
      const lock = await api.request('screen');
      if (!wanted) {
        Promise.resolve(lock.release?.()).catch(() => {});
        return;
      }
      sentinel = lock;
      lock.addEventListener?.('release', () => {
        if (sentinel === lock) sentinel = null;
      });
    } catch {
      // not allowed right now; retried on the next visibility change
    } finally {
      pending = false;
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') request();
  };
  return {
    acquire() {
      if (wanted) return;
      wanted = true;
      document.addEventListener('visibilitychange', onVisibility);
      request();
    },
    release() {
      wanted = false;
      document.removeEventListener('visibilitychange', onVisibility);
      const lock = sentinel;
      sentinel = null;
      if (lock) Promise.resolve(lock.release?.()).catch(() => {});
    },
  };
}

function readResults(event) {
  let final = '';
  let interim = '';
  const results = event?.results || [];
  for (let i = event?.resultIndex || 0; i < results.length; i += 1) {
    const result = results[i];
    const text = result?.[0]?.transcript ?? result?.transcript ?? '';
    if (result?.isFinal === false) interim += text;
    else final += text;
  }
  return { final: final.trim(), interim: interim.trim() };
}

function noticeFor(err, kind) {
  if (err?.code === 'busy') return 'AI is busy, try again in a moment';
  if (err?.network) return 'Connection problem. Check your signal and try again.';
  return kind === 'summary' ? 'Could not make the summary. Say 总结 to try again.' : 'Something went wrong. Say it again or type it.';
}

/**
 * One practice session. `api` = { chat(day, messages) → reply, summary(day, messages) → entry }.
 * `hooks` (all optional): state(state, detail), message(msg), notice(text), interim(text),
 * slower(on), voiceWarning(reason | null), persist(day, messages), finished(entry | null).
 * States: idle | listening | thinking | speaking | paused | error.
 */
export class VoiceSession {
  constructor({ day, messages = [], api, hooks = {} }) {
    this.day = day;
    this.messages = messages.map(({ role, text }) => ({ role, text }));
    this.api = api;
    this.hooks = hooks;
    this.state = 'idle';
    this.slower = false;
    this.ended = false; // finishing or finished: nothing may restart the loop
    this.closed = false;
    this.gen = 0; // bumped whenever pending speech / listening must be dropped
    this.askId = 0; // identifies the latest /api/chat request
    this.inflight = false;
    this.pendingReply = null; // reply that arrived while paused
    this.rec = null;
    this.restartTimer = 0;
    this.startFailures = 0;
    this.micBlocked = false;
    this.warning = null; // reason of the voice warning on screen
    this.Recognition = null;
    this.speaker = new Speaker(null, null);
    this.wake = createWakeLock();
    this.onVisible = () => {
      if (document.visibilityState === 'visible' && this.state === 'listening' && !this.rec) this.listen();
    };
  }

  emit(name, ...args) {
    try {
      this.hooks[name]?.(...args);
    } catch (err) {
      console.error(err);
    }
  }

  setState(state, detail) {
    this.state = state;
    this.emit('state', state, detail);
  }

  /** Call from a user gesture (click) so speech is unlocked on iOS. */
  start() {
    const g = globalThis;
    this.Recognition = g.SpeechRecognition || g.webkitSpeechRecognition || null;
    this.speaker = new Speaker(g.speechSynthesis || null, g.SpeechSynthesisUtterance || null);
    this.speaker.prime();
    this.wake.acquire();
    document.addEventListener('visibilitychange', this.onVisible);
    if (!this.Recognition) this.warn('unsupported');
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role === 'user') this.ask();
    else this.say(last.text);
  }

  /** A final voice result or typed text. Returns false when it cannot be taken right now. */
  input(raw) {
    const text = String(raw ?? '').trim();
    if (!text || this.ended || this.state === 'thinking') return false;
    const command = commandOf(text);
    if (command === 'finish') {
      this.finish();
      return true;
    }
    if (command === 'pause') {
      this.pause();
      return true;
    }
    if (command === 'repeat') {
      this.repeat();
      return true;
    }
    if (command === 'slower') this.setSlower(true);
    this.addMessage('user', text);
    this.ask();
    return true;
  }

  addMessage(role, text) {
    const msg = { role, text };
    this.messages.push(msg);
    this.emit('message', msg);
    this.emit('persist', this.day, this.messages.slice());
  }

  /** Drops pending speech, recognition and restart timers from the previous step. */
  halt() {
    this.gen += 1;
    clearTimeout(this.restartTimer);
    this.stopRecognition();
    this.speaker.cancel();
    this.emit('interim', '');
    return this.gen;
  }

  stopRecognition() {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    try {
      rec.abort();
    } catch {
      // already stopped
    }
  }

  async ask() {
    const id = ++this.askId;
    this.halt();
    this.pendingReply = null;
    this.inflight = true;
    this.setState('thinking');
    let reply;
    try {
      reply = await this.fetchReply(id);
    } catch (err) {
      if (this.ended || id !== this.askId) return;
      this.inflight = false;
      if (err?.code !== 'busy' && !err?.network) console.error(err);
      const notice = noticeFor(err, 'chat');
      this.emit('notice', notice);
      if (this.state !== 'paused') this.say(notice);
      return;
    }
    if (this.ended || id !== this.askId) return;
    this.inflight = false;
    this.addMessage('assistant', reply);
    if (this.state === 'paused') this.pendingReply = reply;
    else this.say(reply);
  }

  async fetchReply(id) {
    const snapshot = recentMessages(this.messages, CHAT_WINDOW);
    const once = async () => {
      const reply = await this.api.chat(this.day, snapshot);
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('empty reply');
      return reply.trim();
    };
    try {
      return await once();
    } catch (err) {
      if (!err?.network) throw err;
      await wait(RETRY_MS);
      if (this.ended || id !== this.askId) throw err;
      return once();
    }
  }

  /** Speaks `text`, then listens (or returns to paused). */
  async say(text, then = 'listen') {
    const gen = this.halt();
    this.pendingReply = null;
    this.setState('speaking');
    await this.speaker.say(text, {
      rate: () => (this.slower ? RATE_SLOW : RATE_NORMAL),
      live: () => gen === this.gen && !this.ended,
    });
    if (gen !== this.gen || this.ended) return;
    if (then === 'pause') this.setState('paused');
    else this.listen();
  }

  listen() {
    if (this.ended) return;
    clearTimeout(this.restartTimer);
    if (this.rec || this.speaker.busy) return; // never listen twice, never while speaking
    if (!this.Recognition || this.micBlocked) {
      this.setState('idle', 'Your turn — type your reply');
      return;
    }
    const gen = this.gen;
    if (document.visibilityState === 'hidden') {
      this.setState('listening'); // onVisible restarts once the page is back
      return;
    }
    let rec;
    try {
      rec = new this.Recognition();
    } catch {
      this.blockMic('unsupported');
      return;
    }
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    let settled = false;
    const live = () => !settled && this.rec === rec && gen === this.gen && !this.ended;
    const settle = () => {
      settled = true;
      if (this.rec === rec) this.rec = null;
      this.emit('interim', '');
    };
    const again = (ms) => {
      if (!live()) return;
      settle();
      this.restartTimer = setTimeout(() => {
        if (gen === this.gen && this.state === 'listening') this.listen();
      }, ms);
    };

    rec.onaudiostart = () => {
      if (live()) this.micWorks();
    };
    rec.onresult = (event) => {
      if (!live()) return;
      this.micWorks();
      const { final, interim } = readResults(event);
      if (final && /[\p{L}\p{N}]/u.test(final)) {
        settle();
        this.input(final);
      } else {
        this.emit('interim', interim);
      }
    };
    rec.onerror = (event) => {
      if (!live()) return;
      const code = event?.error || 'unknown';
      if (BLOCKING_ERRORS.has(code) && document.visibilityState !== 'hidden') {
        settle();
        this.blockMic(code);
        return;
      }
      again(code === 'network' ? RETRY_MS : RESTART_MS);
    };
    rec.onend = () => again(RESTART_MS);

    this.rec = rec;
    this.setState('listening');
    try {
      rec.start();
      this.startFailures = 0;
    } catch {
      if (!live()) return;
      settle();
      this.startFailures += 1;
      if (this.startFailures >= MAX_START_FAILURES) this.blockMic('start-failed');
      else this.restartTimer = setTimeout(() => {
        if (gen === this.gen && this.state === 'listening') this.listen();
      }, 1000);
    }
  }

  blockMic(reason) {
    this.micBlocked = true;
    this.setState('error', 'Microphone unavailable — type your reply');
    this.warn(reason);
  }

  warn(reason) {
    this.warning = reason;
    this.emit('voiceWarning', reason);
  }

  /** The mic delivers audio again: clear a stale "blocked" warning. */
  micWorks() {
    if (!this.warning) return;
    this.warning = null;
    this.emit('voiceWarning', null);
  }

  pause() {
    if (this.ended || this.state === 'paused') return;
    this.halt();
    this.setState('paused');
  }

  resume() {
    if (this.ended || (this.state !== 'paused' && this.state !== 'error')) return;
    this.micBlocked = false;
    this.startFailures = 0;
    this.wake.acquire();
    if (this.inflight) this.setState('thinking');
    else if (this.pendingReply) this.say(this.pendingReply);
    else {
      this.halt();
      this.listen();
    }
  }

  togglePause() {
    if (this.state === 'paused' || this.state === 'error') this.resume();
    else this.pause();
  }

  /** Repeats the last partner reply locally (no API call). */
  repeat() {
    if (this.ended || this.inflight || this.state === 'thinking') return;
    const last = [...this.messages].reverse().find((m) => m.role === 'assistant');
    const after = this.state === 'paused' ? 'pause' : 'listen';
    if (last) {
      this.say(last.text, after);
    } else if (after === 'listen') {
      this.halt();
      this.listen();
    }
  }

  setSlower(on) {
    this.slower = Boolean(on);
    this.emit('slower', this.slower);
  }

  toggleSlower() {
    this.setSlower(!this.slower);
  }

  /** Stops the loop and asks for the 总结. Without any user turn it just ends. */
  async finish() {
    if (this.ended) return;
    this.ended = true;
    this.askId += 1; // drop any in-flight chat reply
    this.inflight = false;
    this.halt();
    this.wake.release();
    document.removeEventListener('visibilitychange', this.onVisible);
    if (!this.messages.some((m) => m.role === 'user')) {
      this.setState('idle');
      this.emit('finished', null);
      return;
    }
    this.setState('thinking', 'Writing your summary…');
    try {
      const entry = await this.api.summary(this.day, recentMessages(this.messages, SUMMARY_WINDOW));
      if (!this.closed) this.emit('finished', entry);
    } catch (err) {
      if (this.closed) return;
      if (err?.code !== 'busy' && !err?.network) console.error(err);
      // Back to the hands-free loop; saying 总结 again retries.
      this.ended = false;
      this.wake.acquire();
      document.addEventListener('visibilitychange', this.onVisible);
      const notice = noticeFor(err, 'summary');
      this.emit('notice', notice);
      this.say(notice);
    }
  }

  /** Tears the session down without a summary (e.g. leaving the screen). */
  destroy() {
    this.closed = true;
    this.ended = true;
    this.askId += 1;
    this.halt();
    this.wake.release();
    document.removeEventListener('visibilitychange', this.onVisible);
  }
}
