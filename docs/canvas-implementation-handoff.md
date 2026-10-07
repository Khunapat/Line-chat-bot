# JaiJa canvas → implementation handoff

Implementation of the Claude Design canvas
<https://claude.ai/artifact/FfQTeM1qddVwSXtPbSGD6t> (31 boards; "Interactive
prototype · start here (ไทย / English)" first) in this repository.
Date: 2026-10-07.

## 1. Inputs

| Input | Status |
| --- | --- |
| `design/JaiJa Design.html` export | **Not available.** No export file was provided. Nothing older was substituted. The canvas **source** was read through the artifact instead and saved in `design/canvas/` (31 `*.dc.html` boards + `canvas.json`), with its assets in `design/assets/` (named by asset id). |
| `docs/claude-design-brief.md`, `docs/abdul-browser-review-2026-10-07.md`, `docs/parnuan-reference-supplement.md` | Present, read. |
| `DESIGN.md`, `docs/jaija-design-template.md`, `docs/claude-artifact-review-2026-10-07.md`, `AGENTS.md` | **Not in the repository**, so not used. |
| Canvas runtime (`support.js`) | Part of the canvas host, not exported, so `Prototype.dc.html` cannot run outside it. The designer's fixes were verified by reading the prototype's source (markup + logic), then the behaviour was rebuilt and checked in a real browser against the implementation. |

### Designer's fixes, as found in the prototype source

| Claimed fix | Finding | In the implementation |
| --- | --- | --- |
| Profile help / privacy reachable | Partly: a "ข้อมูลอยู่ที่ไหน" card only; no help page | ของฉัน → วิธีใช้ and ความเป็นส่วนตัว pages (`#/me/help`, `#/me/privacy`) |
| Pinned nav and scrolling | Yes (nav outside the scroller, 112 px bottom padding) | Fixed nav + safe-area padding; checked at 320 / 390 / 1280 |
| Connected flows | Yes | Same flows on the real API |
| TH/EN switching + reload persistence | Only `localStorage` | Stored per verified LINE user on the server (`prefs.json` in the owner's Drive); survives reload, other devices and the chat |
| Automatic long-wait | Yes (8 s) | Same, in the motion controller |
| System reduced motion | Yes (`matchMedia`) | Same, plus a per-device "ลดการเคลื่อนไหว" setting |
| Consistent selected dates | Yes (overlay opens on the selected day) | Same; day and list segment kept in the URL (`#/today?day=…`, `#/reminders?cat=…`) |

### Prototype defects fixed without changing the visual direction

* Month overlay and dialogs had no focus management → focus moves in, Tab is trapped, Escape closes, focus returns to the opener; focus survives the grid reloading.
* Month cells had no Calendar-event marker → ▭ added.
* English "at 2" offered 08:00 / 14:00 (the Thai "2 โมง" reading) → English offers 02:00 / 14:00; Thai "2 โมง" keeps 08:00 / 14:00.
* Hard-coded `min` date, AI numbers, model names, account e-mail, group name and "J" avatar → all from the API.
* "Proposed" tags, the simulation panel and "ต้นแบบ · ข้อมูลสมมุติ" labels removed from production. The simulation panel exists only in the local preview.
* Disabled "Proposed" controls (weekday multi-select, month-end option) removed; month-end is now real behaviour (see §5).
* `#8A8578` out-of-month dates were 3.5:1 contrast → `#686458` (5.6:1).
* Segmented controls were 40 px tall → 44 px.

## 2. Architecture

No new framework. Vanilla ES modules, served by the existing Express app.

```
web/shared/   i18n.js (all TH/EN strings: app + bot), dates.js, recurrence.js
              — imported by Node (src/) and served to the browser at /shared
web/app/      index.html, app.css, js/{main,api,dom,ui,model,motion,timeparse}.js,
              js/views/{today,reminders,deadlines,library,me,welcome}.js, img/
src/appAuth.js   LIFF ID token → LINE /oauth2/v2.1/verify → HMAC session (12 h)
src/appApi.js    /api/app/* (tenant-scoped, see §3)
src/webApp.js    /app, /shared, /app/fonts with CSP + nosniff + no-referrer
src/prefs.js     language + tone per verified LINE user
src/lang.js      AsyncLocalStorage: the language of the chat being handled
scripts/preview-app.mjs   local preview with fictional data (no Google/LINE/AI)
scripts/verify-app.mjs    Playwright checks against the preview
```

### Security model

* The browser sends the **LIFF ID token**; the server verifies it with LINE (`aud` = LINE Login channel, `iss`, `exp`, `sub` format) and issues its own HMAC session token (Authorization header only, never a URL, `credentials: 'omit'`, `Cache-Control: no-store`).
* **No client-supplied user id is trusted.** Every route uses the session's user id; `?userId=` / body ids are ignored (tested).
* `ctx=me` → the user's own tenant. `ctx=<groupId>` → allowed only for the group's host or a current member, checked with LINE (`getGroupMemberProfile` / `getRoomMemberProfile`, 10 min cache). Unknown and forbidden groups get the same 403.
* Group context never shows the host's Calendar (`events.status: not_applicable`) and file detail only resolves files inside that library's own folder tree, so a member cannot open the host's personal files by id (tested).
* OAuth refresh tokens never leave the server; e-mail is masked (`j***@gmail.com`); thumbnails use the existing per-file signed URLs.
* A failed read returns an error (`502 upstream_failed`, `409 drive_disconnected`, …), never an empty list; extra counts that fail are `null` and shown as "–" / "นับไม่ได้".
* Reminder creation is idempotent per client key (`clientKey`, checked inside the document lock); edits carry `expectAt` and get `409 changed` instead of overwriting a change made in chat.

## 3. Actions → API → existing capability

| UI action | API | Backend |
| --- | --- | --- |
| Sign in | `POST /session {idToken}` | new (`appAuth.js`) |
| First-run language, ของฉัน › ภาษา | `PUT /prefs {lang}` | new `prefs.js`; links the matching rich menu by alias |
| Chat tone | `PUT /prefs {tone}` | new; used as a style hint for the AI in 1:1 chats only |
| Planner (week / month, up next, saved items) | `GET /planner?from&to` (≤ 62 days) | reminders, opportunities, `calendar.listRange` (new), `drive.allFiles`, links, memories |
| Reminder list | `GET /reminders` | `store.reminders` (deadline alerts excluded, counted) |
| New reminder | `POST /reminders {text,date,time,repeat,key}` | `reminders.json`; monthly/yearly store `anchorDay` |
| Change time | `PATCH /reminders/:id {date,time,expectAt}` | same as chat "reschedule" |
| Snooze 10 / 60 | `POST /reminders/:id/snooze {minutes}` | same semantics as the chat button (repeat → one-off copy) |
| Done (sent) | `POST /reminders/:id/done` | same as chat "done" |
| Cancel | `DELETE /reminders/:id` | same as chat "cancel" |
| Deadline list / detail | `GET /deadlines`, `GET /deadlines/:id` | `deadlineService`; schedule incl. past alerts |
| Applied / resume | `POST /deadlines/:id/applied {applied}` | `setApplied` |
| Per-item alerts | `PUT /deadlines/:id/alerts {preset}` | `setAlertSettings({oppId})` |
| Alert schedule | `GET/PUT /deadline-alerts` | `setAlertSettings` |
| Delete + undo | `DELETE /deadlines/:id`, `POST /deadlines/:id/restore` | same 5-item undo stack as chat |
| Split a merge | `POST /deadlines/:id/split` | `splitMerge` — only the latest merge in the chat (backend limit, stated in the UI) |
| Library list / search | `GET /library?ctx&tab&q&offset` | `drive.allFiles` + `files.json` captions/tags, links, memories |
| File detail / open original | `GET /files/:id?ctx` | Drive `webViewLink` |
| Forget a fact | `DELETE /memories/:id?ctx` | `store.forget` |
| Account, counts, AI usage | `GET /me` | Drive e-mail, Calendar probe, counts, `Usage.snapshot` (estimated) |
| Disconnect | `POST /disconnect {confirm:true}` | same as chat "disconnect" (not for the owner) |
| Reconnect | link from `/me.connectUrl` | existing `/connect` OAuth flow |

## 4. Implemented / deferred / blocked

**Implemented**

* Web app: วันนี้ (greeting, Drive chip, up next, week strip with ● ◆ ▭ ▪ markers and legend, month overlay; desktop shows the month inline, back to today, date-aware empty states, month/year rollover, Calendar partial-failure banners), reminder manager (upcoming / repeating / just sent, change time, cancel with confirmation, snooze, done), editor (what → when → once/repeat with progressive options, chat-style input that fills fields, "2 โมง" clarification, Thai time words, past/empty validation, summary with exact date, time, zone, repeat, destination and device-zone equivalent, failure banner keeping input, idempotent retry, unsaved-change guard on back, tab and reload), done screen; Deadlines (filters with counts, search, stub with shape icons, countdown in Bangkok calendar days, "ไม่ระบุเวลา", organiser note shown as written, event dates marked "not the closing date", ⋯ sheet, detail, applied/resume, per-item alerts, past alerts struck through, merge panel + split, delete + undo toast, alert settings with preview and save-only-when-changed); คลัง (mine / group contexts with owner line, debounced cancellable search, files / links / memory tabs with counts, list / gallery, file detail, open original, forget with confirmation, AI-limit banner, show more); ของฉัน (identity, masked account + connection, Calendar status, counts, shared AI usage marked ประมาณการ with real reset time and explicit unknown limits, language, tone with preview, deadline alerts, reduced-motion setting, disconnect with confirmation, reconnect, help, privacy); first-run welcome with language choice, chat demos and wave; recovery states (not configured, login, session expired, not connected, Drive disconnected, forbidden, gone, failed load with retry, partial).
* Motion: mini JaiJa from the Motion board. **Default: in-place run (dots pass under JaiJa).** The curved "around" path is kept as an option (`createMotion({ path: 'around' })`); in-place reads better at small sizes and keeps the status text still. Reveal 400 ms, 2.4 s loop, long-wait at 8 s (static clock pose + text, not a timeout), success ≈ 560 ms only after the server confirms, partial and failure poses, destroyed on navigation / superseded requests, ignores late results, paused when the page is hidden, OS reduced motion + user setting.
* i18n: one dictionary (`web/shared/i18n.js`) for the app and the bot; Thai default; Buddhist years in Thai, Gregorian in English; user content never translated. Bot: every standard reply and every Flex card localised (per-event language via `AsyncLocalStorage`, so concurrent chats never mix); cron pushes use the person's (or group host's) language; the AI is told to reply in English when chosen.
* LINE native loading dots (`showLoadingAnimation`) in 1:1 chats while the AI works; no extra animated messages.
* Rich menus: `assets/richmenu.th.png` / `.en.png` (2500×1686, 329 / 288 KB), action maps `assets/richmenu-areas.{th,en}.json` (8 non-overlapping areas, same shape), chat bar "เมนู JaiJa" / "JaiJa menu", hero opens the keyboard with "เตือน " prefilled, ของฉัน opens the app when `LIFF_ID` is set. Upload script creates both menus + aliases and sets Thai as default.
* Reminder repeats now computed on the local wall clock with an anchor day (fixes monthly reminders before 07:00 Bangkok landing on the wrong day, and 31st/29 Feb drift). Shared by server and app.

**Deferred** (designed, not built)

* Photo-to-reminder draft-and-confirm (PhotoReminder board).
* Weekday multi-select repeats; "last day of every month" as its own option (month-end anchors already fall back to the last day).
* Editing a reminder's text or repeat from the app (time only, as in the board).
* User-initiated "merge these two" in the app (chat offers it on suggestions); splitting older merges (backend keeps only the latest merge).
* Desktop two-pane Deadlines (list + detail side by side); desktop Today is two-column.
* Group context for Today/Deadlines in the app (Library supports groups).
* Sharing the group folder from the app (stays in the group chat, host only).

**Blocked on you (external)**

* A **LINE Login channel** in the same provider as the Messaging API channel, a **LIFF app** (endpoint `https://<service>/app`, scopes `openid profile`, size Full), and `LIFF_ID` on Cloud Run. Until then `/app` shows "ยังไม่ได้ตั้งค่าแอป".
* Uploading the rich menus (`npm run rich-menu`), deploying, and the webhook: not done, per instruction.

## 5. Behaviour notes

* Countdown counts Bangkok calendar days; deadlines are date-only in the tenant zone (Asia/Bangkok) and are never given an invented time.
* Monthly on the 29th–31st: months without that day use their last day, then return to the anchor; yearly 29 Feb uses 28 Feb in common years. Shown as a note in the editor and list.
* "เพิ่งเตือน" shows one-off reminders sent in the last 24 h (the backend keeps them that long).
* AI usage is the bot's own count of shared requests, so it is labelled ประมาณการ / Estimated; reset is the next Pacific midnight (14:00 Bangkok now, 15:00 from 1 Nov 2026), computed, not hard-coded.

## 6. Preview and checks

```bash
npm install
npm run preview                     # http://127.0.0.1:8090/app  (fictional data, no external calls)
node scripts/verify-app.mjs         # 22 browser checks against the preview (Chromium)
npm run check && npm test           # syntax check + 125 unit/integration tests
npm run richmenu-image              # re-render both rich menus + action maps
```

The preview's ของฉัน page has the simulation panel (slow / very slow / failing
network, AI at its limit, Drive disconnected, Calendar failing, first-open).

## 7. Verification results (2026-10-07)

* `npm run check`: pass. `npm test`: 125 / 125 pass, including new suites for auth (`appAuth`), API boundaries and mutations (`appApi`: forged/expired sessions, ignored client user ids, group membership, host-calendar and cross-tenant file isolation, idempotent create, stale edit, snooze/done/cancel semantics, delete/restore, split guard, alert validation, failed reads ≠ empty, partial Calendar, estimated AI, per-user language), dates / recurrence / dictionary parity (`shared`), time parsing (`timeparse`), motion lifecycle (`motion`, fake DOM + mocked timers), rich-menu maps (`richmenu`).
* `scripts/verify-app.mjs`: 22 / 22 pass in Chromium — language saved on the server and kept after reload, pinned nav, week navigation + month overlay focus/Escape/selected day, "at 2" clarification, past-time error, unsaved-change dialog, failed save keeps input and the retry does not duplicate, cancel confirmation, delete + undo, "No time given" and organiser note, failed library load shows an error not an empty list, newer search wins over a slow older one, long-wait after 8 s and cleanup on navigation, group library separation, Me estimated AI + reset + unknown limit + privacy, switch back to Thai, system reduced motion, no horizontal scroll at 320 / 390 / 1280 on every tab, 44 px targets, no script errors.
* End-to-end bot harness (local, not committed: real `src/index.js`, LINE/Drive/Calendar/AI mocked): 10 / 10 scenarios, including the English path (menu alias switched, English Flex cards and settings, native loading dots once per AI turn, AI told to reply in English, `/app` CSP, `/api/app/me` 401 without a session).
* Contrast (WCAG): ink on paper 9.8:1, secondary 5.2:1, white on primary 5.8:1, urgent on paper 4.7:1.

## 8. Not tested against live services

LINE ID-token verification against the real LINE Login channel; LIFF init/login inside the LINE app; `showLoadingAnimation`, `getGroupMemberProfile`, rich-menu alias linking and the upload script against the real channel; Google Drive `allFiles` / thumbnails / Calendar `listRange` with real accounts; the deployed container (Dockerfile now copies `web/` and the fonts); real devices (iOS/Android LINE in-app browser, safe areas, Thai input methods).
