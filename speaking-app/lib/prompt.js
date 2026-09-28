import { getDay } from './plan.js';

const LANG_NAMES = { en: 'English', th: 'Thai' };

/** "en" | "th" → language name used in prompts (unknown values fall back to English). */
export function explainLanguage(code) {
  return LANG_NAMES[String(code || '').toLowerCase()] || LANG_NAMES.en;
}

function resolveDay(day) {
  const entry = typeof day === 'number' ? getDay(day) : day;
  if (!entry) throw new Error(`unknown plan day: ${day}`);
  return entry;
}

function describeDay(entry) {
  return `Day ${entry.day}: ${entry.topic}. Words / patterns: ${entry.words.join(', ')}. Scene: ${entry.scene}.`;
}

/** Words of the lesson days just before `entry`, for the warm-up. */
function previousWords(entry, count = 2) {
  const out = [];
  for (let d = entry.day - 1; d >= 1 && out.length < count; d--) {
    const prev = getDay(d);
    if (!prev.review) out.push(prev);
  }
  return out.reverse().flatMap((p) => p.words);
}

/**
 * System prompt for the live voice session. Replies are read aloud by the
 * browser's TTS, so they must be short plain sentences.
 */
export function buildSystemPrompt(day, { explainLang = 'en' } = {}) {
  const entry = resolveDay(day);
  const lang = explainLanguage(explainLang);

  const today = entry.review
    ? [
      `Today is Day ${entry.day} of a 30-day plan: ${entry.topic}. This is a REVIEW day: no new words.`,
      `Scene for today: ${entry.scene}.`,
      'Mix scenes from these earlier days and quiz me on their words:',
      ...entry.reviewOf.map((d) => `- ${describeDay(getDay(d))}`),
    ]
    : [
      `Today is Day ${entry.day} of a 30-day plan (week ${entry.week}: ${entry.weekTitle}).`,
      `Topic: ${entry.topic}.`,
      `Target words / patterns: ${entry.words.join(', ')}.`,
      `Role-play scene: ${entry.scene}.`,
    ];

  const warm = previousWords(entry);
  const structure = entry.review
    ? [
      '1. Warm-up: greet me and ask 3 quick questions that reuse words from the review days.',
      '2. Quiz: ask me to say or use the review words one at a time.',
      '3. Role-play: play the scene above. You are the other person. Push me to use the review words.',
      '4. Free talk: talk about my real life using these topics.',
    ]
    : [
      warm.length
        ? `1. Warm-up (about 3 min): ask me 3 quick questions that reuse words from the previous days: ${warm.join(', ')}.`
        : '1. Warm-up (about 3 min): greet me and ask 3 very easy questions.',
      '2. Teach (about 5 min): introduce the target words one at a time. Say the word, ask me to repeat it, then use it in a short sentence.',
      '3. Role-play (about 15 min): play the scene. You are the other person. Push me to use the target words and pattern.',
      '4. Free talk (the rest): talk about my real life using today\'s topic.',
    ];

  return [
    'You are my Mandarin speaking partner. I practice by voice while climbing stairs, with earbuds, hands-free.',
    '',
    ...today,
    '',
    'Session structure (move on naturally, one step at a time):',
    ...structure,
    '',
    'Voice rules (your reply is read aloud by text-to-speech):',
    '- Reply with 1-2 short, simple sentences.',
    '- Plain text only: no markdown, no emoji, no lists, no pinyin, no romanization.',
    `- Speak mostly Chinese (simplified characters). Explain in ${lang} only when I am stuck or ask; no parentheses translations unless you are explaining.`,
    '- Always end with a question or a "repeat after me" sentence (跟我说：...), so I keep talking.',
    '- When I make a mistake, say the correct sentence once and ask me to repeat it. No grammar lectures.',
    '- If I say 慢一点, use slower, shorter, simpler sentences from now on.',
    '- If I say 再说一遍, repeat your last sentence.',
    '- If I say 累了 (tired), switch to shadowing: you say one short sentence, I repeat it.',
    '- If a turn is too easy, add harder words; if it is too hard, slow down and use more shadowing.',
    '- My speech comes from speech recognition, so ignore small recognition errors and wrong homophones when the meaning is clear.',
  ].join('\n');
}

/** System prompt for the end-of-session 总结. */
export function buildSummaryPrompt(day, { explainLang = 'en' } = {}) {
  const entry = resolveDay(day);
  const lang = explainLanguage(explainLang);
  const focus = entry.review
    ? `It was a review day covering days ${entry.reviewOf.join(', ')}.`
    : `Target words: ${entry.words.join(', ')}.`;
  return [
    `You review a Mandarin speaking practice session (Day ${entry.day}: ${entry.topic}). ${focus}`,
    'The transcript is from speech recognition, so ignore obvious recognition glitches.',
    'Return:',
    `- words: the words that were taught or used in the session (target words first), each with hanzi, pinyin with tone marks, and a short meaning in ${lang}.`,
    `- mistakes: up to 3 of the learner's most repeated mistakes, each one short line in ${lang} with the corrected Chinese sentence. Empty if there were none.`,
    '- practice: one short Chinese sentence the learner should practice tomorrow.',
  ].join('\n');
}

/** JSON Schema for the summary object (used for structured output). */
export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    words: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hanzi: { type: 'string' },
          pinyin: { type: 'string' },
          meaning: { type: 'string' },
        },
        required: ['hanzi', 'pinyin', 'meaning'],
      },
    },
    mistakes: { type: 'array', items: { type: 'string' } },
    practice: { type: 'string' },
  },
  required: ['words', 'mistakes', 'practice'],
};
