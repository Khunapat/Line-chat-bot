import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { getDay } from './plan.js';
import { withRetry, isQuotaError } from './errors.js';

/**
 * LLM providers. Every provider has the same shape:
 *   name
 *   chat({ system, messages, day }) -> reply text
 *   summarize({ system, messages, schema, day }) -> object matching schema
 * messages: [{ role: 'user'|'assistant', text }]; `day` is the plan entry.
 */

export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite';
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

const START_CUE = '(The session starts now. Greet me, tell me today\'s topic, and start the warm-up.)';

/**
 * Normalize history for the APIs: it must start with a user turn and roles
 * must alternate (an unanswered turn after a "busy" error leaves two user
 * turns in a row, which we merge).
 */
export function toTurns(messages) {
  const turns = [];
  for (const m of messages) {
    const last = turns.at(-1);
    if (last && last.role === m.role) last.text += '\n' + m.text;
    else turns.push({ role: m.role, text: m.text });
  }
  if (!turns.length || turns[0].role !== 'user') turns.unshift({ role: 'user', text: START_CUE });
  return turns;
}

/** Plain transcript for the summary request. */
export function transcript(messages) {
  return messages.map((m) => `${m.role === 'user' ? 'Learner' : 'Partner'}: ${m.text}`).join('\n');
}

export class GeminiProvider {
  /** `model` may be a comma list; later models are fallbacks when quota runs out. */
  constructor({ apiKey, model = DEFAULT_GEMINI_MODEL }) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is required');
    this.name = 'gemini';
    this.ai = new GoogleGenAI({ apiKey });
    this.models = String(model).split(',').map((m) => m.trim()).filter(Boolean);
  }

  /** Call generateContent, walking down the model list on quota / missing-model errors. */
  async generate(request) {
    let lastErr;
    for (const model of this.models) {
      try {
        return await withRetry(() => this.ai.models.generateContent({ model, ...request }));
      } catch (err) {
        const missing = Number(err?.status) === 404 || /not found|not supported/i.test(String(err?.message || ''));
        if (!isQuotaError(err) && !missing) throw err;
        console.warn(`gemini ${model} ${missing ? 'unavailable' : 'quota hit'}`);
        if (!lastErr || isQuotaError(err)) lastErr = err;
      }
    }
    throw lastErr;
  }

  async chat({ system, messages }) {
    const resp = await this.generate({
      contents: toTurns(messages).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
      config: { systemInstruction: system, temperature: 0.7 },
    });
    return (resp.text || '').trim();
  }

  async summarize({ system, messages, schema }) {
    const resp = await this.generate({
      contents: [{ role: 'user', parts: [{ text: transcript(messages) }] }],
      config: {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
        temperature: 0.2,
      },
    });
    const text = resp.text || '';
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('model returned non-JSON: ' + text.slice(0, 200));
    }
  }
}

export class AnthropicProvider {
  constructor({ apiKey, model = DEFAULT_CLAUDE_MODEL, effort = 'low' }) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
    this.name = 'anthropic';
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.effort = effort;
  }

  create(params) {
    return withRetry(() => this.client.beta.messages.create({
      model: this.model,
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: this.effort },
      ...params,
    }));
  }

  async chat({ system, messages }) {
    const response = await this.create({
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: toTurns(messages).map((m) => ({ role: m.role, content: m.text })),
    });
    if (response.stop_reason === 'refusal') return '我们换个话题吧。你今天怎么样？';
    return response.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean).join(' ');
  }

  async summarize({ system, messages, schema }) {
    const response = await this.create({
      max_tokens: 2048,
      system,
      tools: [{ name: 'record', description: 'Record the session summary.', input_schema: schema, strict: true }],
      messages: [{ role: 'user', content: `${transcript(messages)}\n\nRecord the summary by calling the record tool exactly once.` }],
    });
    const call = response.content.find((b) => b.type === 'tool_use' && b.name === 'record');
    if (!call) throw new Error('model did not return structured output');
    return call.input;
  }
}

const MOCK_QUESTIONS = [
  '你叫什么名字？',
  '你是哪国人？',
  '你今天忙吗？',
  '你喜欢爬楼梯吗？',
  '你想喝茶吗？',
];

/** Deterministic offline partner for tests, e2e and demo mode. */
export class MockProvider {
  constructor() {
    this.name = 'mock';
  }

  async chat({ messages, day }) {
    const entry = typeof day === 'number' ? getDay(day) : day;
    if (!messages.length) return `你好！今天是第${entry.day}天：${entry.title || entry.topic}。我们开始吧！你今天怎么样？`;
    const userTurns = messages.filter((m) => m.role === 'user');
    const last = userTurns.at(-1)?.text ?? '';
    const said = [...last].slice(0, 40).join('');
    return `好的！你说：「${said}」。${MOCK_QUESTIONS[(userTurns.length - 1) % MOCK_QUESTIONS.length]}`;
  }

  async summarize({ day }) {
    const entry = typeof day === 'number' ? getDay(day) : day;
    const words = entry.review
      ? entry.reviewOf.flatMap((d) => getDay(d).glossary.slice(0, 3)).slice(0, 12)
      : entry.glossary;
    return {
      words: words.map(({ hanzi, pinyin, meaning }) => ({ hanzi, pinyin, meaning })),
      mistakes: ['(mock) no real analysis'],
      practice: `我今天练习了「${entry.title || entry.topic}」。`,
    };
  }
}

/**
 * Pick a provider from env: LLM_PROVIDER=gemini|anthropic|mock, or auto:
 * GEMINI_API_KEY → gemini, else ANTHROPIC_API_KEY → anthropic, else mock.
 */
export function createProvider(env = process.env) {
  const choice = String(env.LLM_PROVIDER || '').trim().toLowerCase()
    || (env.GEMINI_API_KEY ? 'gemini' : env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock');
  switch (choice) {
    case 'gemini':
      return new GeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL });
    case 'anthropic':
    case 'claude':
      return new AnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
        effort: env.CLAUDE_EFFORT || 'low',
      });
    case 'mock':
      return new MockProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER "${env.LLM_PROVIDER}" (use gemini, anthropic or mock)`);
  }
}
