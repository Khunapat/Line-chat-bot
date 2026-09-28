import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { PLAN, TOTAL_DAYS, getDay } from './plan.js';
import { buildSystemPrompt, buildSummaryPrompt, SUMMARY_SCHEMA } from './prompt.js';
import { isQuotaError } from './errors.js';
import { APP_DIR } from './env.js';

// A summary may cover a whole hour of talk; a chat turn only needs recent context.
export const LIMITS = { messages: 200, summaryMessages: 600, text: 2000 };
const ROLES = new Set(['user', 'assistant']);
const EMPTY_REPLY = '不好意思，我没听清楚。你可以再说一遍吗？';

class BadRequest extends Error {}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Constant-time password comparison (hashing first makes lengths equal). */
export function passwordMatches(given, expected) {
  return typeof given === 'string' && crypto.timingSafeEqual(sha256(given), sha256(expected));
}

/**
 * Checks the x-app-password header. Header values must be Latin-1, so the page
 * sends the password percent-encoded; a raw value (e.g. from curl) works too.
 */
export function headerPasswordMatches(header, expected) {
  if (typeof header !== 'string') return false;
  let decoded = null;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    // malformed escape: only the raw value can match
  }
  const raw = passwordMatches(header, expected);
  return (decoded !== null && passwordMatches(decoded, expected)) || raw;
}

/** Validate `{ day, messages }`; returns the plan entry and clean messages or throws BadRequest. */
function parseBody(body, maxMessages = LIMITS.messages) {
  const { day, messages } = body || {};
  const entry = getDay(day);
  if (!entry) throw new BadRequest(`day must be an integer from 1 to ${TOTAL_DAYS}`);
  if (!Array.isArray(messages)) throw new BadRequest('messages must be an array');
  if (messages.length > maxMessages) throw new BadRequest(`at most ${maxMessages} messages`);
  const clean = messages.map((m, i) => {
    if (!m || typeof m !== 'object' || !ROLES.has(m.role)) throw new BadRequest(`messages[${i}].role must be "user" or "assistant"`);
    if (typeof m.text !== 'string') throw new BadRequest(`messages[${i}].text must be a string`);
    if (m.text.length > LIMITS.text) throw new BadRequest(`messages[${i}].text is longer than ${LIMITS.text} characters`);
    return { role: m.role, text: m.text };
  });
  return { entry, messages: clean };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Coerce whatever the model returned into the summary shape the page expects. */
export function normalizeSummary(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const words = (Array.isArray(s.words) ? s.words : [])
    .filter((w) => w && typeof w === 'object' && str(w.hanzi))
    .slice(0, 30)
    .map((w) => ({ hanzi: str(w.hanzi), pinyin: str(w.pinyin), meaning: str(w.meaning) }));
  const mistakes = (Array.isArray(s.mistakes) ? s.mistakes : []).map(str).filter(Boolean).slice(0, 3);
  return { words, mistakes, practice: str(s.practice) };
}

/**
 * Build the Express app.
 *   provider    – { name, chat, summarize } from providers.js
 *   store       – LogStore
 *   password    – optional; required as x-app-password on /api/* except /api/health
 *   explainLang – 'en' | 'th'
 */
export function createApp({ provider, store, password = '', explainLang = 'en', publicDir = path.join(APP_DIR, 'public'), logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  const api = express.Router();

  api.get('/health', (req, res) => {
    res.json({ ok: true, provider: provider.name, passwordRequired: Boolean(password) });
  });

  api.use((req, res, next) => {
    if (!password || headerPasswordMatches(req.get('x-app-password'), password)) return next();
    res.status(401).json({ error: 'password' });
  });

  api.use(express.json({ limit: '1mb' }));

  api.get('/plan', (req, res) => {
    res.json({ days: PLAN });
  });

  api.post('/chat', async (req, res, next) => {
    try {
      const { entry, messages } = parseBody(req.body);
      if (messages.length) {
        const last = messages.at(-1);
        if (last.role !== 'user') throw new BadRequest('the last message must be from the user');
        if (!last.text.trim()) throw new BadRequest('the last message is empty');
      }
      const system = buildSystemPrompt(entry, { explainLang });
      const reply = String(await provider.chat({ system, messages, day: entry }) || '').trim();
      res.json({ reply: reply || EMPTY_REPLY });
    } catch (err) {
      next(err);
    }
  });

  api.post('/summary', async (req, res, next) => {
    try {
      const { entry, messages } = parseBody(req.body, LIMITS.summaryMessages);
      const turns = messages.filter((m) => m.role === 'user' && m.text.trim()).length;
      if (!turns) throw new BadRequest('messages must contain at least one user message');
      const system = buildSummaryPrompt(entry, { explainLang });
      const raw = await provider.summarize({ system, messages, schema: SUMMARY_SCHEMA, day: entry });
      const stored = await store.append({ day: entry.day, turns, summary: normalizeSummary(raw) });
      res.json({ entry: stored });
    } catch (err) {
      next(err);
    }
  });

  api.get('/log', async (req, res, next) => {
    try {
      res.json({ entries: await store.list() });
    } catch (err) {
      next(err);
    }
  });

  api.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  api.use((err, req, res, _next) => {
    if (err instanceof BadRequest) return res.status(400).json({ error: 'bad_request', detail: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request', detail: 'body is not valid JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
    if (isQuotaError(err)) {
      logger.warn(`${req.method} /api${req.path}: AI busy:`, err?.message || err);
      return res.status(503).json({ error: 'busy' });
    }
    logger.error(`${req.method} /api${req.path} failed:`, err);
    res.status(500).json({ error: 'failed' });
  });

  app.use('/api', api);
  app.use(express.static(publicDir));
  return app;
}
