/**
 * Hand-drawn style icon set for JaiJa's cards, matching the mascot: thick
 * dark outlines, cream fills, olive accents, slightly wobbly rounded shapes.
 * Each entry is the inner SVG of a 100x100 viewBox.
 */
export const C = { stroke: '#3B3B3B', cream: '#F4EFE4', cream2: '#EFE8D8', olive: '#8B9270', olive2: '#6F7658', red: '#B5482F', orange: '#C98A2B', white: '#FFFFFF' };
const S = `fill="none" stroke="${C.stroke}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"`;

export const ICONS = {
  // folder with a little tab, slightly tilted papers inside
  folder: `
    <path d="M14 34 q0 -8 8 -8 h18 l8 8 h30 q8 0 8 8 v34 q0 8 -8 8 h-56 q-8 0 -8 -8 z" fill="${C.olive}" ${S}/>
    <path d="M12 48 q2 -6 8 -6 h60 q8 0 7 8 l-3 26 q-1 8 -9 8 h-52 q-8 0 -8 -8 z" fill="${C.cream}" ${S}/>`,
  // picture frame with hill and sun
  gallery: `
    <rect x="14" y="20" width="72" height="60" rx="10" fill="${C.cream}" ${S}/>
    <circle cx="36" cy="40" r="7" fill="${C.orange}" ${S}/>
    <path d="M20 74 l18 -20 l12 12 l10 -9 l20 17" fill="${C.olive}" ${S}/>
    <path d="M14 70 h72" ${S}/>`,
  // bell
  bell: `
    <path d="M50 18 q22 0 22 24 v14 q0 8 8 14 h-60 q8 -6 8 -14 v-14 q0 -24 22 -24 z" fill="${C.cream}" ${S}/>
    <path d="M42 74 q0 10 8 10 q8 0 8 -10" fill="${C.olive}" ${S}/>
    <circle cx="50" cy="14" r="4" fill="${C.stroke}"/>
    <path d="M22 26 q-4 6 -5 14 M78 26 q4 6 5 14" ${S}/>`,
  // calendar
  calendar: `
    <rect x="14" y="24" width="72" height="60" rx="10" fill="${C.cream}" ${S}/>
    <path d="M14 42 h72" ${S}/>
    <path d="M14 34 q0 -10 10 -10 h52 q10 0 10 10 v8 h-72 z" fill="${C.olive}" ${S}/>
    <path d="M34 14 v16 M66 14 v16" ${S}/>
    <rect x="30" y="52" width="12" height="10" rx="3" fill="${C.olive2}" stroke="none"/>
    <rect x="48" y="52" width="12" height="10" rx="3" fill="${C.olive2}" stroke="none"/>
    <rect x="30" y="66" width="12" height="10" rx="3" fill="${C.olive2}" stroke="none"/>`,
  // target with flag (deadline)
  target: `
    <circle cx="50" cy="56" r="30" fill="${C.cream}" ${S}/>
    <circle cx="50" cy="56" r="18" fill="${C.olive}" ${S}/>
    <circle cx="50" cy="56" r="6" fill="${C.red}" ${S}/>
    <path d="M50 56 l22 -32" ${S}/>
    <path d="M72 24 l16 -4 l-8 10 l8 6 l-16 -2 z" fill="${C.red}" ${S}/>`,
  // note pad with pencil
  note: `
    <path d="M24 16 h44 q8 0 8 8 v54 q0 8 -8 8 h-44 q-8 0 -8 -8 v-54 q0 -8 8 -8 z" fill="${C.cream}" ${S}/>
    <path d="M30 38 h32 M30 50 h32 M30 62 h20" ${S}/>
    <path d="M62 78 l22 -30 l8 6 l-22 30 l-10 3 z" fill="${C.olive}" ${S}/>`,
  // chain link
  link: `
    <path d="M42 62 l-8 8 q-10 10 -20 0 q-10 -10 0 -20 l14 -14 q10 -10 20 0" fill="${C.cream}" ${S}/>
    <path d="M58 38 l8 -8 q10 -10 20 0 q10 10 0 20 l-14 14 q-10 10 -20 0" fill="${C.olive}" ${S}/>
    <path d="M40 60 l20 -20" ${S}/>`,
  // gear: eight rounded teeth, a body on top hides their inner ends
  settings: `
    <rect x="39" y="9" width="22" height="24" rx="8" fill="${C.cream}" ${S} transform="rotate(0 50 52)"/><rect x="39" y="9" width="22" height="24" rx="8" fill="${C.cream}" ${S} transform="rotate(45 50 52)"/><rect x="39" y="9" width="22" height="24" rx="8" fill="${C.cream}" ${S} transform="rotate(90 50 52)"/><rect x="39" y="9" width="22" height="24" rx="8" fill="${C.cream}" ${S} transform="rotate(135 50 52)"/><rect x="39" y="9" width="22" height="24" rx="8" fill="${C.cream}" ${S} transform="rotate(180 50 52)"/><rect x="39" y="9" width="22" height="24" rx="8" fill="${C.cream}" ${S} transform="rotate(225 50 52)"/><rect x="39" y="9" width="22" height="24" rx="8" fill="${C.cream}" ${S} transform="rotate(270 50 52)"/><rect x="39" y="9" width="22" height="24" rx="8" fill="${C.cream}" ${S} transform="rotate(315 50 52)"/>
    <circle cx="50" cy="52" r="28" fill="${C.cream}" ${S}/>
    <circle cx="50" cy="52" r="11" fill="${C.olive}" ${S}/>`,
  // little robot head (AI)
  ai: `
    <rect x="18" y="30" width="64" height="50" rx="14" fill="${C.cream}" ${S}/>
    <path d="M50 30 v-10" ${S}/><circle cx="50" cy="16" r="5" fill="${C.olive}" ${S}/>
    <circle cx="37" cy="52" r="6" fill="${C.stroke}"/><circle cx="63" cy="52" r="6" fill="${C.stroke}"/>
    <path d="M38 68 q12 8 24 0" ${S}/>
    <path d="M10 50 h8 M82 50 h8" ${S}/>`,
  // two people
  group: `
    <circle cx="36" cy="36" r="12" fill="${C.cream}" ${S}/>
    <path d="M12 82 q0 -26 24 -26 q24 0 24 26 z" fill="${C.olive}" ${S}/>
    <circle cx="66" cy="40" r="10" fill="${C.cream}" ${S}/>
    <path d="M60 82 q4 -18 6 -22 q22 0 24 22 z" fill="${C.cream2}" ${S}/>`,
  // map pin
  pin: `
    <path d="M50 88 q-26 -30 -26 -48 q0 -26 26 -26 q26 0 26 26 q0 18 -26 48 z" fill="${C.olive}" ${S}/>
    <circle cx="50" cy="40" r="10" fill="${C.cream}" ${S}/>`,
  // magnifier
  search: `
    <circle cx="42" cy="42" r="24" fill="${C.cream}" ${S}/>
    <path d="M60 60 l24 24" stroke="${C.stroke}" stroke-width="9" stroke-linecap="round"/>
    <path d="M30 34 q4 -8 12 -10" ${S}/>`,
  // alarm clock
  clock: `
    <circle cx="50" cy="54" r="30" fill="${C.cream}" ${S}/>
    <path d="M50 36 v18 l12 8" ${S}/>
    <path d="M24 28 l10 -10 M76 28 l-10 -10" ${S}/>`,
  // document
  doc: `
    <path d="M26 12 h32 l18 18 v54 q0 6 -6 6 h-44 q-6 0 -6 -6 v-66 q0 -6 6 -6 z" fill="${C.cream}" ${S}/>
    <path d="M58 12 v18 h18" fill="${C.cream2}" ${S}/>
    <path d="M34 50 h32 M34 62 h32 M34 74 h20" ${S}/>`,
  // pdf: document with red band
  pdf: `
    <path d="M26 12 h32 l18 18 v54 q0 6 -6 6 h-44 q-6 0 -6 -6 v-66 q0 -6 6 -6 z" fill="${C.cream}" ${S}/>
    <path d="M58 12 v18 h18" fill="${C.cream2}" ${S}/>
    <rect x="16" y="50" width="60" height="24" rx="6" fill="${C.red}" ${S}/>
    <text x="46" y="68" font-family="Arial, sans-serif" font-weight="700" font-size="16" fill="${C.white}" text-anchor="middle">PDF</text>`,
  // paperclip
  clip: `
    <path d="M62 30 l-26 26 q-8 8 0 16 q8 8 16 0 l28 -28 q12 -12 0 -24 q-12 -12 -24 0 l-30 30 q-16 16 0 32 q16 16 32 0 l24 -24" fill="none" stroke="${C.stroke}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`,
  // film clapper
  video: `
    <rect x="14" y="36" width="72" height="46" rx="8" fill="${C.cream}" ${S}/>
    <path d="M14 36 l6 -18 l66 8 l-4 10 z" fill="${C.olive}" ${S}/>
    <path d="M30 20 l8 12 M48 22 l8 12 M66 24 l8 12" ${S}/>
    <path d="M44 50 l18 10 l-18 10 z" fill="${C.olive2}" ${S}/>`,
  // microphone
  audio: `
    <rect x="36" y="12" width="28" height="46" rx="14" fill="${C.olive}" ${S}/>
    <path d="M24 46 q0 26 26 26 q26 0 26 -26" ${S}/>
    <path d="M50 72 v14 M36 86 h28" ${S}/>`,
  // check in circle
  check: `
    <circle cx="50" cy="50" r="34" fill="${C.olive}" ${S}/>
    <path d="M32 52 l12 12 l24 -26" stroke="${C.white}" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  // waving hand-ish sparkle for "welcome"
  wave: `
    <path d="M30 50 v-18 q0 -6 6 -6 q6 0 6 6 v10 v-22 q0 -6 6 -6 q6 0 6 6 v22 v-14 q0 -6 6 -6 q6 0 6 6 v20 v-8 q0 -6 6 -6 q6 0 6 6 v22 q0 26 -24 26 q-14 0 -20 -12 l-12 -18 q-3 -6 3 -9 q5 -2 9 3 z" fill="${C.cream}" ${S}/>`,
};

export function svgOf(name, size = 128) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${ICONS[name]}</svg>`;
}

/** 4:3 placeholder "hero" for files without a thumbnail. */
export function placeholderSvg(name, w = 480, h = 360) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="${C.cream2}"/>
    <g transform="translate(${w / 2 - 80} ${h / 2 - 80}) scale(1.6)">${ICONS[name]}</g>
  </svg>`;
}
