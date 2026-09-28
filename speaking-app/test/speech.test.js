import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceSession, recentMessages, commandOf } from '../public/speech.js';

// Minimal browser surface for the voice loop (no speechSynthesis: speaking resolves at once).
const wake = { held: 0, requests: 0 };
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    wakeLock: {
      async request() {
        wake.requests += 1;
        wake.held += 1;
        let released = false;
        return {
          addEventListener() {},
          async release() {
            if (!released) wake.held -= 1;
            released = true;
          },
        };
      },
    },
  },
});

const recs = [];
class FakeRecognition {
  constructor() {
    recs.push(this);
    this.started = false;
  }

  start() {
    this.started = true;
  }

  abort() {
    this.started = false;
  }
}

beforeEach(() => {
  wake.held = 0;
  wake.requests = 0;
  recs.length = 0;
  globalThis.SpeechRecognition = FakeRecognition;
});

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const history = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', text: `m${i}` }));

function session({ messages = [], chat, summary, hooks = {} } = {}) {
  const seen = { chat: [], summary: [], notices: [], warnings: [], finished: [] };
  const s = new VoiceSession({
    day: 3,
    messages,
    api: {
      chat: async (day, msgs) => {
        seen.chat.push(msgs);
        return chat ? chat(msgs) : '好的！';
      },
      summary: async (day, msgs) => {
        seen.summary.push(msgs);
        return summary ? summary(msgs) : { id: 'x', day };
      },
    },
    hooks: {
      notice: (text) => seen.notices.push(text),
      voiceWarning: (reason) => seen.warnings.push(reason),
      finished: (entry) => seen.finished.push(entry),
      ...hooks,
    },
  });
  return { s, seen };
}

test('commands ignore punctuation and spaces', () => {
  assert.equal(commandOf(' 总结。'), 'finish');
  assert.equal(commandOf('再说一遍！'), 'repeat');
  assert.equal(commandOf('我叫小明'), null);
});

test('recentMessages keeps the newest messages within count and text limits', () => {
  const msgs = history(250);
  const recent = recentMessages(msgs, 200);
  assert.equal(recent.length, 200);
  assert.deepEqual(recent.at(-1), msgs.at(-1));
  assert.deepEqual(recent[0], msgs[50]);
  const big = [{ role: 'user', text: 'a'.repeat(10) }, { role: 'assistant', text: 'b'.repeat(10) }, { role: 'user', text: 'c'.repeat(10) }];
  assert.deepEqual(recentMessages(big, 10, 25).map((m) => m.text[0]), ['b', 'c']);
  assert.equal(recentMessages([{ role: 'user', text: 'x'.repeat(50) }], 10, 5).length, 1, 'the last message is always kept');
});

test('a long session sends at most 200 messages per chat and 600 per summary', async () => {
  const { s, seen } = session({ messages: history(700) }); // ends on a user message
  s.start();
  await flush();
  assert.equal(seen.chat.length, 1);
  assert.equal(seen.chat[0].length, 200);
  assert.equal(seen.chat[0].at(-1).role, 'user');
  assert.equal(seen.chat[0].at(-1).text, 'm699');
  await s.finish();
  assert.equal(seen.summary[0].length, 600);
  assert.equal(seen.summary[0].at(-1).text, '好的！');
  assert.ok(seen.summary[0].some((m) => m.role === 'user'));
  assert.equal(seen.finished.length, 1);
});

test('a failed summary speaks a notice, listens again with the wake lock, and 总结 retries', async () => {
  let fail = true;
  const { s, seen } = session({
    messages: [{ role: 'assistant', text: '你好' }, { role: 'user', text: '我叫小明' }, { role: 'assistant', text: '好的' }],
    summary: () => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error('busy'), { code: 'busy' });
      }
      return { id: 'e1', day: 3 };
    },
  });
  s.start();
  await flush();
  assert.equal(s.state, 'listening');
  assert.equal(wake.held, 1);

  await s.finish();
  await flush();
  assert.deepEqual(seen.notices, ['AI is busy, try again in a moment']);
  assert.equal(s.state, 'listening', 'back to the hands-free loop');
  assert.ok(recs.at(-1).started, 'recognition restarted');
  assert.equal(wake.held, 1, 'screen wake lock taken again');
  assert.equal(seen.finished.length, 0);

  assert.equal(s.input('总结'), true);
  await flush();
  assert.equal(seen.summary.length, 2);
  assert.deepEqual(seen.finished, [{ id: 'e1', day: 3 }]);
  assert.equal(wake.held, 0);
});

test('the mic warning clears once the microphone works again', async () => {
  const { s, seen } = session({ messages: [{ role: 'assistant', text: '你好' }] });
  s.start();
  await flush();
  recs.at(-1).onerror({ error: 'not-allowed' });
  assert.equal(s.state, 'error');
  assert.deepEqual(seen.warnings, ['not-allowed']);

  s.resume();
  assert.equal(s.state, 'listening');
  assert.deepEqual(seen.warnings, ['not-allowed'], 'still shown until audio really starts');
  recs.at(-1).onaudiostart();
  assert.deepEqual(seen.warnings, ['not-allowed', null]);
  s.destroy();
});

test('the unsupported warning stays: nothing can clear it', async () => {
  globalThis.SpeechRecognition = undefined;
  const { s, seen } = session({ messages: [{ role: 'assistant', text: '你好' }] });
  s.start();
  await flush();
  assert.deepEqual(seen.warnings, ['unsupported']);
  assert.equal(s.state, 'idle');
  s.destroy();
});
