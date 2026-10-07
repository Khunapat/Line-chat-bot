// Motion lifecycle of the web app's mini JaiJa, run against a tiny fake DOM
// with mocked timers: reveal at 400 ms, long wait at 8 s, success only when
// called, destroyed instances ignore late results, reduced motion respected.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

class FakeEl {
  constructor(tag) { this.tag = tag; this.className = ''; this.attrs = {}; this.children = []; this.textContent = ''; this.parent = null; }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean);
    const set = (list) => { this.className = list.join(' '); };
    return {
      add: (c) => { const l = get(); if (!l.includes(c)) set([...l, c]); },
      remove: (c) => set(get().filter((x) => x !== c)),
      toggle: (c, on) => { const l = get(); const want = on === undefined ? !l.includes(c) : on; set(want ? [...new Set([...l, c])] : l.filter((x) => x !== c)); },
      contains: (c) => get().includes(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...c) { for (const x of c) { x.parent = this; this.children.push(x); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  set innerHTML(_v) { /* artwork markup is static */ }
}

let reduce = false;
const mqListeners = [];
const docListeners = {};
globalThis.document = {
  hidden: false,
  createElement: (t) => new FakeEl(t),
  createElementNS: (_ns, t) => new FakeEl(t),
  addEventListener: (ev, fn) => { (docListeners[ev] ||= []).push(fn); },
};
globalThis.matchMedia = () => ({ get matches() { return reduce; }, addEventListener: (_e, fn) => mqListeners.push(fn) });
globalThis.localStorage = { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = v; } };

mock.timers.enable({ apis: ['setTimeout'] });
const { createMotion, liveCount, setUserReducedMotion } = await import('../web/app/js/motion.js');
const T = (k) => k;
const art = (m) => m.el.children[0];
const status = (m) => m.el.children[1];

test('art appears only after 400 ms; text shows at once', () => {
  const m = createMotion({ T }).start();
  assert.match(m.el.className, /is-pending/);
  assert.equal(status(m).textContent, 'loading');
  assert.ok(art(m).classList.contains('hide'));
  mock.timers.tick(399);
  assert.ok(art(m).classList.contains('hide'));
  mock.timers.tick(1);
  assert.ok(!art(m).classList.contains('hide'));
  m.destroy();
});

test('after 8 s the loop stops and says it is still working (not a timeout)', () => {
  const m = createMotion({ T, kind: 'saving' }).start();
  mock.timers.tick(7999);
  assert.equal(m.state, 'pending');
  mock.timers.tick(1);
  assert.equal(m.state, 'longwait');
  assert.equal(status(m).textContent, 'longWait');
  m.destroy();
});

test('success, partial and failure only when told; destroy ignores late results', async () => {
  const ok = createMotion({ T }).start();
  const done = ok.success();
  assert.equal(ok.state, 'success');
  mock.timers.tick(560);
  await done;
  ok.destroy();

  const part = createMotion({ T }).start();
  part.partial();
  assert.equal(part.state, 'partial');
  assert.equal(status(part).textContent, 'moPartial');
  part.destroy();

  const stale = createMotion({ T }).start();
  stale.destroy();
  stale.success();
  stale.failure();
  assert.equal(stale.state, 'pending', 'a superseded request never shows a result');
  assert.equal(liveCount(), 0, 'no instance left running');
});

test('destroy clears timers so nothing fires after navigation', () => {
  const m = createMotion({ T }).start();
  m.destroy();
  mock.timers.tick(10_000);
  assert.equal(m.state, 'pending');
  assert.equal(liveCount(), 0);
});

test('reduced motion: system setting and user setting both apply live', () => {
  const m = createMotion({ T }).start();
  assert.ok(!m.el.classList.contains('rm'));
  reduce = true;
  mqListeners.forEach((fn) => fn());
  assert.ok(m.el.classList.contains('rm'));
  reduce = false;
  mqListeners.forEach((fn) => fn());
  assert.ok(!m.el.classList.contains('rm'));
  setUserReducedMotion(true);
  assert.ok(m.el.classList.contains('rm'));
  setUserReducedMotion(false);
  m.destroy();
});

test('a hidden page pauses the loop', () => {
  const m = createMotion({ T }).start();
  document.hidden = true;
  docListeners.visibilitychange.forEach((fn) => fn());
  assert.ok(m.el.classList.contains('paused'));
  document.hidden = false;
  docListeners.visibilitychange.forEach((fn) => fn());
  assert.ok(!m.el.classList.contains('paused'));
  m.destroy();
});
