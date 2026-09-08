import { GoogleGenAI } from '@google/genai';
import { withRetry } from './errors.js';

/**
 * Gemini provider (Google AI Studio key, free tier is enough for one user).
 *
 * complete({ system, messages, tools, runTool }) runs the model, executes any
 * function calls through runTool, and returns the final text.
 *   messages: [{ role: 'user'|'assistant', text }]   (last one is the new turn)
 *   tools:    Anthropic-style { name, description, input_schema } definitions
 */
export class GeminiProvider {
  constructor({ apiKey, model = 'gemini-3.6-flash' }) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is required');
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
    this.label = `Gemini ${model}`;
  }

  async complete({ system, messages, tools, runTool, maxIters = 6 }) {
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));
    const functionDeclarations = tools.map(toFunctionDeclaration);

    for (let i = 0; i < maxIters; i++) {
      const resp = await withRetry(() => this.ai.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations }],
          temperature: 0.7,
        },
      }));

      const calls = resp.functionCalls || [];
      if (calls.length === 0) return { text: (resp.text || '').trim() };

      const modelTurn = resp.candidates?.[0]?.content;
      if (modelTurn) contents.push(modelTurn);

      const parts = [];
      for (const call of calls) {
        let result;
        try {
          result = await runTool(call.name, call.args || {});
        } catch (err) {
          result = { error: String(err?.message || err) };
        }
        parts.push({ functionResponse: { id: call.id, name: call.name, response: { result } } });
      }
      contents.push({ role: 'user', parts });
    }
    return { text: '' };
  }
}

/**
 * Structured extraction: returns an object matching `schema` (JSON Schema).
 * `parts` may include { text } and { inlineData: { mimeType, data(base64) } }.
 */
GeminiProvider.prototype.extract = async function extract({ system, parts, schema }) {
  const resp = await withRetry(() => this.ai.models.generateContent({
    model: this.model,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      temperature: 0.2,
    },
  }));
  const text = resp.text || '';
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('model returned non-JSON: ' + text.slice(0, 200));
  }
};

/** Convert an Anthropic-style tool definition to a Gemini function declaration. */
export function toFunctionDeclaration(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.input_schema,
  };
}
