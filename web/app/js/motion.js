// "ใจ๋วิ่งไปจัดให้": mini JaiJa carries a note past three olive dots while a
// request is pending, then files it and shows a check on real success.
//
// Lifecycle (one instance per request):
//   const m = createMotion({ T, kind: 'loading' })   // element in m.el
//   m.start()            pending; art appears after 400 ms, static long-wait at 8 s
//   m.success() / m.partial(text) / m.failure(text)  only from real outcomes
//   m.destroy()          on navigation, a superseded request or unmount
// A destroyed instance ignores late calls, so a stale response can never
// show a check. Status text is a live region and reads fine with the art
// hidden. Reduced motion (OS or the user's setting) swaps to static poses.

const REVEAL_MS = 400;
const LONG_WAIT_MS = 8000;
const SUCCESS_MS = 560;

export const MOTION_DEFAULT_PATH = 'inplace'; // 'around' is the curved option from the Motion board

let userReduced = false;
try { userReduced = localStorage.getItem('jj.reduceMotion') === '1'; } catch { /* private mode */ }
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const live = new Set();

export function reducedMotion() {
  return userReduced || Boolean(mq?.matches);
}

export function setUserReducedMotion(on) {
  userReduced = Boolean(on);
  try { localStorage.setItem('jj.reduceMotion', on ? '1' : '0'); } catch { /* private mode */ }
  for (const m of live) m.refreshMotion();
}

export function userReducedMotion() {
  return userReduced;
}

mq?.addEventListener?.('change', () => { for (const m of live) m.refreshMotion(); });
document.addEventListener('visibilitychange', () => {
  for (const m of live) m.el.classList.toggle('paused', document.hidden);
});

const SVGNS = 'http://www.w3.org/2000/svg';

/** The mini JaiJa artwork (from the Motion board), built as SVG nodes. */
function artwork() {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 240 120');
  svg.setAttribute('width', '220');
  svg.setAttribute('height', '110');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('mo-art');
  // Static markup with no user data, so innerHTML is safe here.
  svg.innerHTML = `
    <path d="M8 106 H232" stroke="#CFC6B2" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 7" fill="none"/>
    <circle class="dot d1" cx="0" cy="100" r="6" fill="#8B9270" stroke="#3B3B3B" stroke-width="1.5"/>
    <circle class="dot d2" cx="0" cy="100" r="6" fill="#8B9270" stroke="#3B3B3B" stroke-width="1.5"/>
    <circle class="dot d3" cx="0" cy="100" r="6" fill="#8B9270" stroke="#3B3B3B" stroke-width="1.5"/>
    <g class="folder">
      <path d="M160 66 h20 l6 6 h30 a4 4 0 0 1 4 4 v26 a4 4 0 0 1 -4 4 h-56 a4 4 0 0 1 -4 -4 v-32 a4 4 0 0 1 4 -4 z" fill="#8B9270" stroke="#3B3B3B" stroke-width="2.4" stroke-linejoin="round"/>
      <rect class="fnote" x="170" y="62" width="22" height="20" rx="2" fill="#FBF8F1" stroke="#3B3B3B" stroke-width="2" transform="rotate(-6 181 72)"/>
      <path d="M156 80 h68 l-4 22 a4 4 0 0 1 -4 4 h-56 a4 4 0 0 1 -4 -4 z" fill="#EFE8D8" stroke="#3B3B3B" stroke-width="2.4" stroke-linejoin="round"/>
    </g>
    <g class="check"><circle cx="214" cy="60" r="12" fill="#62694D" stroke="#3B3B3B" stroke-width="2"/><path d="M208 60 l4.5 4.5 l8 -9" stroke="#FFFFFF" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>
    <g class="clock"><circle cx="120" cy="26" r="11" fill="#FBF8F1" stroke="#3B3B3B" stroke-width="2.2"/><path d="M120 19.5 v7 l4.5 3" stroke="#3B3B3B" stroke-width="2.2" fill="none" stroke-linecap="round"/></g>
    <g transform="translate(40 10)"><g class="actor"><g class="char">
      <path d="M13 47 C8 22 24 5 41 5 C60 5 73 20 67 47 C64 41 62 37 59 35 L21 35 C18 38 15 42 13 47 Z" fill="#4E4540" stroke="#3B3B3B" stroke-width="2.4" stroke-linejoin="round"/>
      <circle cx="19" cy="45" r="4.5" fill="#F8DCCB" stroke="#3B3B3B" stroke-width="2.2"/>
      <circle cx="61" cy="45" r="4.5" fill="#F8DCCB" stroke="#3B3B3B" stroke-width="2.2"/>
      <ellipse cx="40" cy="42" rx="21" ry="20" fill="#F8DCCB" stroke="#3B3B3B" stroke-width="2.4"/>
      <path d="M18.5 39 C18 22 29 13 41 13 C54 13 63 22 62 39 C58 34 54 30 49 28 C46 33 40 34 34 31 C30 33 24 35 18.5 39 Z" fill="#4E4540"/>
      <path d="M18.5 39 C24 35 30 33 34 31 C40 34 46 33 49 28 C54 30 58 34 62 39" stroke="#3B3B3B" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M28 37 q4 -2 7 0 M45 37 q3 -2 7 0" stroke="#3B3B3B" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <ellipse cx="32" cy="43" rx="2.4" ry="2.8" fill="#3B3B3B"/><ellipse cx="48" cy="43" rx="2.4" ry="2.8" fill="#3B3B3B"/>
      <ellipse cx="28" cy="50" rx="3.6" ry="2" fill="#F2B4A2"/><ellipse cx="52" cy="50" rx="3.6" ry="2" fill="#F2B4A2"/>
      <path d="M35 52 q5 4 10 0" stroke="#3B3B3B" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <path d="M23 81 L25 65 Q40 58 55 65 L57 81 Q40 85 23 81 Z" fill="#FFFFFF" stroke="#3B3B3B" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M35 61.5 L40 68 L45 61.5" stroke="#3B3B3B" stroke-width="1.8" fill="none"/>
      <rect x="46" y="69" width="6" height="5" rx="1" fill="#8B9270" stroke="#3B3B3B" stroke-width="1"/>
      <g class="leg ll"><path d="M34 80 L32 93 L27 94" stroke="#3B3B3B" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>
      <g class="leg lr"><path d="M46 80 L48 93 L53 94" stroke="#3B3B3B" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>
      <g class="arm"><path d="M55 66 Q62 58 66 49" stroke="#3B3B3B" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="66.5" cy="47" r="3.6" fill="#F8DCCB" stroke="#3B3B3B" stroke-width="2"/></g>
      <g class="note">
        <g transform="rotate(-8 62 72)"><rect x="52" y="60" width="20" height="24" rx="2.5" fill="#FBF8F1" stroke="#3B3B3B" stroke-width="2"/><path d="M56 67 h12 M56 72 h12 M56 77 h8" stroke="#8B9270" stroke-width="1.8" stroke-linecap="round"/></g>
        <path d="M27 67 Q36 76 51 75" stroke="#3B3B3B" stroke-width="2.6" fill="none" stroke-linecap="round"/>
        <circle cx="53" cy="75" r="3.2" fill="#F8DCCB" stroke="#3B3B3B" stroke-width="1.8"/>
        <g class="bad"><circle cx="72" cy="58" r="6" fill="#B5482F" stroke="#3B3B3B" stroke-width="1.5"/><path d="M72 54.5 v4.2 M72 61.2 v.2" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round"/></g>
        <g class="part"><circle cx="72" cy="58" r="6" fill="#C98A2B" stroke="#3B3B3B" stroke-width="1.5"/><path d="M69.8 56.2 q2.2 -2.4 4.4 0 q0 1.6 -2.2 2.4 v.8 M72 61.4 v.2" stroke="#3B3B3B" stroke-width="1.7" fill="none" stroke-linecap="round"/></g>
      </g>
    </g></g></g>`;
  return svg;
}

/**
 * @param T      translator
 * @param kind   'loading' | 'searching' | 'saving' | 'working'
 * @param path   'inplace' | 'around'
 * @param compact smaller art (inline in a form)
 */
export function createMotion({ T, kind = 'loading', path = MOTION_DEFAULT_PATH, compact = false } = {}) {
  const el = document.createElement('div');
  el.className = `mo is-idle${path === 'around' ? ' around' : ''}${compact ? ' compact' : ''}`;
  const art = artwork();
  art.classList.add('hide');
  const status = document.createElement('p');
  status.className = 'status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  el.append(art, status);

  const pendingText = { loading: T('loading'), searching: T('searchingL'), saving: T('saving'), working: T('working') }[kind] || T('loading');
  let timers = [];
  let state = 'idle';
  let dead = false;

  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const set = (s, text) => {
    if (dead) return;
    state = s;
    el.className = el.className.replace(/\bis-\w+\b/, `is-${s}`);
    status.textContent = text ?? '';
  };

  const api = {
    el,
    get state() { return state; },
    refreshMotion() { el.classList.toggle('rm', reducedMotion()); },
    start() {
      if (dead) return api;
      clearTimers();
      live.add(api);
      api.refreshMotion();
      el.classList.toggle('paused', document.hidden);
      art.classList.add('hide');
      set('pending', pendingText);
      // Fast requests never flash the runner; the text shows at once.
      timers.push(setTimeout(() => { if (!dead && state === 'pending') art.classList.remove('hide'); }, REVEAL_MS));
      // A long wait is not a timeout: the request is still running.
      timers.push(setTimeout(() => { if (!dead && state === 'pending') set('longwait', T('longWait')); }, LONG_WAIT_MS));
      return api;
    },
    /** Resolves after the ~560 ms settle (immediately with reduced motion). */
    success(text = T('moSuccess')) {
      if (dead) return Promise.resolve();
      clearTimers();
      art.classList.remove('hide');
      set('success', text);
      return new Promise((resolve) => { timers.push(setTimeout(resolve, reducedMotion() ? 0 : SUCCESS_MS)); });
    },
    partial(text = T('moPartial')) {
      if (dead) return;
      clearTimers();
      art.classList.remove('hide');
      set('partial', text);
    },
    failure(text = T('moFailure')) {
      if (dead) return;
      clearTimers();
      art.classList.remove('hide');
      set('failure', text);
    },
    wave() {
      if (dead) return api;
      live.add(api);
      api.refreshMotion();
      art.classList.remove('hide');
      set('wave', '');
      timers.push(setTimeout(() => { if (!dead && state === 'wave') set('idle', ''); }, 1400));
      return api;
    },
    destroy() {
      if (dead) return;
      clearTimers();
      dead = true;
      live.delete(api);
      el.remove();
    },
    get destroyed() { return dead; },
  };
  return api;
}

/** For tests and the handoff: how many instances are alive. */
export function liveCount() {
  return live.size;
}
