import Anthropic from '@anthropic-ai/sdk';

/**
 * Claude provider. Same interface as GeminiProvider:
 * complete({ system, messages, tools, runTool }) -> { text }
 */
export class AnthropicProvider {
  constructor({ apiKey, model = 'claude-opus-5', effort = 'low' }) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.effort = effort;
    this.label = `Claude ${model}`;
  }

  async complete({ system, messages, tools, runTool, maxIters = 6 }) {
    const history = messages.map((m) => ({ role: m.role, content: m.text }));

    for (let i = 0; i < maxIters; i++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 2048,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: this.effort },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools,
        messages: history,
      });

      if (response.stop_reason === 'refusal') return { text: 'ขอโทษนะ อันนี้ตอบให้ไม่ได้' };

      const textBlocks = response.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean);
      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0 || response.stop_reason === 'end_turn') return { text: textBlocks.join('\n') };

      history.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const tu of toolUses) {
        let result;
        try {
          result = await runTool(tu.name, tu.input);
        } catch (err) {
          result = { error: String(err?.message || err) };
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      history.push({ role: 'user', content: results });
    }
    return { text: '' };
  }
}
