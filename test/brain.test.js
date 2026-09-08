import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain, TOOLS } from '../src/brain.js';
import { toFunctionDeclaration } from '../src/providers/gemini.js';

/** A provider that calls one tool then answers, recording what it received. */
function fakeProvider(toolName, input, answer) {
  const seen = {};
  return {
    label: 'Fake',
    seen,
    async complete({ system, messages, tools, runTool }) {
      seen.system = system;
      seen.messages = messages;
      seen.tools = tools;
      seen.result = await runTool(toolName, input);
      return { text: answer };
    },
  };
}

test('Brain runs the tool handler with ctx and returns text + attachments', async () => {
  const calls = [];
  const provider = fakeProvider('remember', { text: 'ที่จอดรถ B12' }, 'จำให้แล้ว');
  const brain = new Brain({
    provider, botName: 'JaiJa', userName: 'Tonmai', timeZone: 'Asia/Bangkok',
    handlers: { remember: async (input, ctx) => { calls.push(input); ctx.attachments.push({ type: 'text', text: 'card' }); return { ok: true }; } },
  });

  const out = await brain.chat({ userId: 'U1', text: 'ช่วยจำ ที่จอดรถ B12', hint: 'extra' });
  assert.equal(out.text, 'จำให้แล้ว');
  assert.deepEqual(out.attachments, [{ type: 'text', text: 'card' }]);
  assert.deepEqual(calls, [{ text: 'ที่จอดรถ B12' }]);
  assert.deepEqual(provider.seen.result, { ok: true });
  assert.match(provider.seen.system, /JaiJa/);
  assert.match(provider.seen.messages.at(-1).text, /เวลาตอนนี้ .*\+07:00/);
  assert.match(provider.seen.messages.at(-1).text, /บริบท: extra/);
  assert.equal(provider.seen.tools, TOOLS);
});

test('Brain keeps a compact per-user history', async () => {
  const provider = { label: 'Fake', async complete() { return { text: 'ok' }; } };
  const brain = new Brain({ provider, botName: 'B', timeZone: 'UTC', handlers: {} });
  for (let i = 0; i < 10; i++) await brain.chat({ userId: 'U1', text: `m${i}` });
  const h = brain.history.get('U1');
  assert.equal(h.length, 12);
  assert.equal(h[0].role, 'user');
  assert.equal(h.at(-1).text, 'ok');
  assert.equal(brain.history.get('U2'), undefined);
});

test('unknown tool surfaces as an error to the provider, not a crash', async () => {
  const provider = fakeProvider('nope', {}, 'hm');
  const brain = new Brain({ provider, botName: 'B', timeZone: 'UTC', handlers: {} });
  await assert.rejects(() => brain.chat({ userId: 'U1', text: 'x' }), /unknown tool nope/);
});

test('Gemini function declarations keep the JSON schema and drop strict', () => {
  const decl = toFunctionDeclaration(TOOLS.find((t) => t.name === 'set_reminder'));
  assert.equal(decl.name, 'set_reminder');
  assert.ok(decl.description.length > 10);
  assert.equal(decl.parametersJsonSchema.type, 'object');
  assert.deepEqual(decl.parametersJsonSchema.required, ['text', 'at', 'repeat']);
  assert.equal('strict' in decl, false);
  assert.equal(TOOLS.length, 17);
});
