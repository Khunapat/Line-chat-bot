# Speaking Partner

A hands-free Mandarin speaking partner for your phone. Put in your earbuds,
open the page, tap **Start speaking**, and talk. The partner speaks, then
listens, then speaks again, with no tapping between turns, so you can practice
while climbing stairs, walking or cooking.

Each session follows one day of a 36-day plan built on the 30 lessons of
*HSK Standard Course* 1 and 2 (HSK标准教程). Say **总结** at the
end and you get the words you practiced (with pinyin), your most repeated
mistakes and one sentence to practice tomorrow. Every summary is saved to a
history log.

It is a small Node.js app: an Express server that talks to the AI (Gemini or
Claude) and a plain HTML/JS page that uses the browser's own speech
recognition and text-to-speech. It lives next to the LINE bot but shares no
code or settings with it.

## 5-minute setup

1. **Get a free Gemini key**: open <https://aistudio.google.com/apikey>, sign in
   and click *Create API key*. The free tier is plenty for one person.
2. **Install** (Node.js 20 or newer):

   ```bash
   cd speaking-app
   npm install
   cp .env.example .env     # then paste your key after GEMINI_API_KEY=
   ```

3. **Start**:

   ```bash
   npm start
   ```

   Open <http://localhost:8090> on your computer. Chrome or Edge work best
   (Safari works too; Firefox has no speech recognition, so use the text box).
4. **Open it on your phone.** The browser only allows the microphone on
   `https://` pages (or on `localhost`), so a plain `http://192.168.x.x:8090`
   address from your phone will not hear you. Pick one:
   * **Deploy to Cloud Run** (recommended; same as the LINE bot, free tier is
     enough). From this folder:

     ```bash
     gcloud run deploy speaking-partner --source . --region asia-southeast1 \
       --allow-unauthenticated \
       --set-env-vars GEMINI_API_KEY=<your key>,APP_PASSWORD=<pick one>,EXPLAIN_LANG=en
     ```

     Open the `https://...run.app` URL it prints. Always set `APP_PASSWORD` on
     a public URL so strangers cannot use your AI quota. Cloud Run disks are
     temporary, so the history log resets when the service restarts; the plan
     and the app still work.
   * **Use a tunnel** to your computer, for example
     `cloudflared tunnel --url http://localhost:8090` or `ngrok http 8090`,
     and open the `https://` address it prints on your phone.

   On the phone, use *Add to Home Screen* so it opens like an app.

## How the 36-day plan works

* Lesson days follow *HSK Standard Course* 1 and 2 (HSK标准教程, Beijing
  Language and Culture University Press), lessons 1-15 of each book, in the
  books' order and with their lesson titles and grammar points: book 1 on days
  1-17, book 2 on days 19-35.
* Every target word is on an official HSK level 1-2 word list (HSK 2.0, which
  the books are built on, or the HSK 3.0 standard of 2021). The words for each
  lesson were picked from those lists to fit the lesson topic; they are not a
  copy of the books' vocabulary tables. `test/plan.test.js` checks every word
  and its pinyin against the lists in `lib/hsk-words.js`, which
  `node scripts/build-hsk-words.mjs` regenerates from
  [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary)
  (MIT). The role-play scenes are this app's own.

* Pick a day on the home screen (it suggests the day after the last one you
  finished) and tap **Start speaking**. Finished days are marked.
* Each session goes: warm-up (questions reusing the last days' words), teach
  (today's words one at a time: listen, repeat, use), role-play (the day's
  scene, the partner plays the other person), then free talk.
* Days 6, 12, 18, 24, 30 and 36 are review days: no new words, a mix of the
  week's scenes and a quiz. Day 36 reviews everything.
* Replies are short (1-2 sentences), mostly Chinese, and always end with a
  question or "repeat after me" so you keep talking.

Voice commands you can say at any time:

| Say | What happens |
|---|---|
| 总结 or 结束 | Finish the session and show the summary |
| 再说一遍 | Repeat the last reply |
| 慢一点 | Slower speech and simpler sentences |
| 累了 | Switch to shadowing: the partner says a short sentence, you repeat it |
| 暂停 | Pause (tap Resume to continue) |

The buttons on screen do the same, and you can always type instead of
speaking. The back arrow at the top leaves without a summary; the conversation
is kept and home offers to resume it.

## Environment variables

Put them in `speaking-app/.env` (see `.env.example`) or set them in Cloud Run.

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | auto | `gemini`, `anthropic` or `mock`. Auto: Gemini if `GEMINI_API_KEY` is set, else Claude if `ANTHROPIC_API_KEY` is set, else mock |
| `GEMINI_API_KEY` | | Google AI Studio key |
| `GEMINI_MODEL` | `gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite` | Comma list; later models are used when the first one's quota runs out |
| `ANTHROPIC_API_KEY` | | Claude API key (paid) |
| `CLAUDE_MODEL` | `claude-opus-5` | Claude model |
| `CLAUDE_EFFORT` | `low` | Claude effort level (low keeps replies fast) |
| `EXPLAIN_LANG` | `en` | `en` or `th`: language used when the partner explains something and for word meanings in the summary |
| `APP_PASSWORD` | | When set, the page asks for it once and every API call needs it (any language; the page sends it percent-encoded in `x-app-password`) |
| `PORT` | `8090` | Port to listen on |
| `DATA_DIR` | `speaking-app/data` | Folder for `log.json` (the history) |

When the AI's free quota is used up the page says "AI is busy, try again in a
moment" and keeps listening; nothing you said is lost. That includes the
summary: say 总结 again to retry. Long sessions are fine: each reply uses the
newest 200 messages as context and the summary covers the newest 600.

## Demo / mock mode

With no AI key (or `LLM_PROVIDER=mock`) the app runs in demo mode: the page
shows a *demo mode* badge and the partner answers with fixed offline replies.
Use it to try the voice loop and the screens without a key. The tests and the
browser check use it too.

## Development

```bash
npm test        # unit + API tests (no network, no browser)
npm run lint    # eslint
npm run check   # node --check on every file
npm run e2e     # clicks through the real page in headless Chromium (mock AI, fake mic)
npm run dev     # restart on file changes
```

Layout: `server.js` starts the app; `lib/` has the Express app (`app.js`), the
36-day plan (`plan.js`) and the HSK word lists (`hsk-words.js`), the AI prompts (`prompt.js`), the AI providers
(`providers.js`) and the history log (`store.js`); `public/` is the page;
`test/` and `e2e/` are the checks.

API (all JSON): `GET /api/health`, `GET /api/plan`, `POST /api/chat`
`{ day, messages }` → `{ reply }`, `POST /api/summary` `{ day, messages }` →
`{ entry }`, `GET /api/log` → `{ entries }` (newest first).
