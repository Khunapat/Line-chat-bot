// Tiny DOM helpers. Text always goes in as text nodes, never as HTML, so
// file names and saved facts cannot inject markup.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Hand-drawn PNG icon from /static/icons, decorative unless alt is given. */
export function icon(name, { size = 18, alt = '', cls } = {}) {
  return h('img', { src: `/static/icons/${name}.png`, alt, width: size, height: size, class: cls, style: { width: `${size}px`, height: `${size}px` } });
}

/** UI glyph SVG from /app/img. */
export function glyph(name, { size = 24, alt = '' } = {}) {
  return h('img', { src: `/app/img/${name}.svg`, alt, width: size, height: size, style: { width: `${size}px`, height: `${size}px` } });
}

export function srOnly(text) {
  return h('span', { class: 'sr' }, text);
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour for a dialog element: focus moves in, Tab stays inside,
 * Escape closes, focus returns to the opener. Returns a release function.
 */
export function trapFocus(dialog, { onEscape, initial } = {}) {
  const opener = document.activeElement;
  const items = () => [...dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
  const onKey = (e) => {
    if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(); return; }
    if (e.key !== 'Tab') return;
    const list = items();
    if (list.length === 0) { e.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  dialog.addEventListener('keydown', onKey);
  queueMicrotask(() => (initial || items()[0] || dialog).focus());
  return () => {
    dialog.removeEventListener('keydown', onKey);
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
  };
}

let seq = 0;
export const uid = (p = 'id') => `${p}-${++seq}`;
