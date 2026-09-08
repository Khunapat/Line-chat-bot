# LINE personal assistant → Google Drive

A LINE Official Account that works like a friend-plus-secretary in one chat:

| Say / send | What happens |
| --- | --- |
| a photo, video, voice note, PDF, any file | saved to `My Drive/LineArchive/YYYY-MM-DD/`, reply is a card with an **เปิดไฟล์** button |
| a link | appended to that day's `notes.md` |
| `เก็บไฟล์ bookbank ให้หน่อย` | renames the file you just sent so it is easy to find |
| `ขอไฟล์ bookbank หน่อย` | finds it in Drive and sends the card back |
| `ช่วยจำ ที่จอดรถชั้น 3 B12` | remembers it |
| `จอดรถไว้ไหน` / `ขอเลขบัญชี X` | recalls it and tells you when it was saved |
| `เตือนกินยา 19.00` / `เตือนทุกเย็น 18.00 กินยา` | one-off or recurring reminder, card with **เปลี่ยนเวลา / ยกเลิก** |
| `พรุ่งนี้มีเตือนอะไรบ้าง` | lists reminders |
| `ลง calendar พรุ่งนี้ team dinner 18.09` | creates a Google Calendar event |
| `เตือนและลง calendar 15.00 โทรหาลูกค้า` | does both |
| anything else | chats back in casual Thai (or English if you write English) |

A rich menu at the bottom of the chat gives one-tap access to
**แจ้งเตือน · โน้ต/บันทึก · ไฟล์/รูป · ตั้งค่า**.

Everything lives in **your own Google Drive**, nothing expires, and only your
LINE user ID is allowed to talk to the bot.

```
My Drive/LineArchive/
├── 2026-09-08/
│   ├── notes.md                      ← links & text of the day
│   ├── 21-32-10_image_5501234.jpg
│   └── bookbank.pdf                  ← renamed via "เก็บไฟล์ bookbank"
└── _data/
    ├── memory.json                   ← things you asked it to remember
    ├── reminders.json
    └── state.json
```

## How it works

```
Phone/PC ─LINE─▶ LINE Platform ─webhook─▶ Cloud Run (this app) ─▶ Google Drive / Calendar
                                    ▲                │
                        Cloud Scheduler (every min) ─┘  fires due reminders (push message)
                                                     └─▶ Claude (intent + chat persona)
```

* `src/index.js` – Express webhook. Signature check, media download, tool handlers, postbacks, `/cron/reminders`.
* `src/brain.js` – Claude with a Thai "friend + secretary" persona and tools
  (`remember`, `recall`, `find_file`, `name_last_file`, `set_reminder`, `add_calendar_event`, …).
* `src/drive.js` – Drive folders, uploads, search, rename, JSON documents.
* `src/store.js` – memory / reminders / per-user state persisted as JSON in Drive.
* `src/reminders.js` – scheduling, recurrence, Thai date phrases ("พรุ่งนี้ 10:15 น.").
* `src/calendar.js` – Google Calendar events.
* `src/flex.js` – the beige cards with olive buttons.
* `scripts/get-refresh-token.js` – one-time Google OAuth (Drive + Calendar scopes).
* `scripts/setup-rich-menu.js` + `assets/richmenu.png` – the bottom menu.

Without `ANTHROPIC_API_KEY` the bot still archives everything and understands
the keyword commands (`ขอไฟล์ …`, `เก็บไฟล์ …`, `ช่วยจำ …`, `ขอ … หน่อย`), but
reminders, calendar and free chat need the key.

## Setup

You need: a LINE account, a Google account, an Anthropic API key
(<https://console.anthropic.com/>), the
[gcloud CLI](https://cloud.google.com/sdk/docs/install), and Node.js 20+ on
your computer for the two one-time scripts.

### A. LINE channel

1. <https://developers.line.biz/console/> → create a **Provider** → **Create a Messaging API channel**.
2. **Basic settings** tab → copy **Channel secret** → `LINE_CHANNEL_SECRET`.
3. **Messaging API** tab → **Issue** a long-lived channel access token → `LINE_CHANNEL_ACCESS_TOKEN`.
4. Scan the QR code on that tab to add the bot as a friend.
5. In [LINE Official Account Manager](https://manager.line.biz/) → Settings → Response settings: turn **off** *Auto-response messages* and *Greeting message* (the bot sends its own).

### B. Google OAuth client

1. <https://console.cloud.google.com/> → new project (e.g. `line-assistant`).
2. **APIs & Services → Library** → enable **Google Drive API** and **Google Calendar API**.
3. **OAuth consent screen** → External → app name + your email → add yourself under *Test users*.
   Then click **Publish app**. (In "Testing" mode Google expires refresh tokens after 7 days.)
4. **Credentials → Create credentials → OAuth client ID** → type **Desktop app** →
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

### C. Refresh token (once, on your computer)

```bash
git clone <this repo> && cd line-chat-bot
npm install
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run get-token
```

Open the printed URL, sign in, accept Drive + Calendar access. Copy the printed
`GOOGLE_REFRESH_TOKEN=...`.

### D. Deploy to Cloud Run

```bash
gcloud auth login
gcloud config set project <your-project-id>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com cloudscheduler.googleapis.com

gcloud run deploy line-assistant \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --memory 512Mi --timeout 300 \
  --min-instances 0 --max-instances 1 \
  --set-env-vars "LINE_CHANNEL_SECRET=...,LINE_CHANNEL_ACCESS_TOKEN=...,GOOGLE_CLIENT_ID=...,GOOGLE_CLIENT_SECRET=...,GOOGLE_REFRESH_TOKEN=...,ANTHROPIC_API_KEY=...,CRON_SECRET=<random string>,TIMEZONE=Asia/Bangkok,BOT_NAME=น้องไดรฟ์,USER_NAME=<your nickname>"
```

`--max-instances 1` matters: state is a JSON file in Drive, and two containers
must not write it at the same time. `--allow-unauthenticated` is required so
LINE can reach the webhook; the app rejects anything without a valid LINE
signature.

The command prints a **Service URL** like `https://line-assistant-xxxx.a.run.app`.

Back in the LINE Developers Console → Messaging API tab:

1. **Webhook URL** = `https://line-assistant-xxxx.a.run.app/webhook` → Update → **Verify**.
2. Turn **Use webhook** on.

### E. Lock the bot to you

Send any message. The bot replies with your LINE user ID (starts with `U`):

```bash
gcloud run services update line-assistant --region asia-southeast1 \
  --update-env-vars ALLOWED_USER_IDS=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### F. Reminders (Cloud Scheduler, every minute)

```bash
gcloud scheduler jobs create http line-assistant-reminders \
  --location asia-southeast1 \
  --schedule "* * * * *" \
  --uri "https://line-assistant-xxxx.a.run.app/cron/reminders" \
  --http-method GET \
  --headers "X-Cron-Secret=<the CRON_SECRET you set above>"
```

Reminders are delivered as push messages. The free LINE plan includes a
monthly push quota (a few hundred), which is plenty for personal reminders;
every other reply the bot sends uses free reply tokens.

### G. Rich menu (bottom buttons)

```bash
LINE_CHANNEL_ACCESS_TOKEN=... npm run rich-menu
```

Uploads `assets/richmenu.png` and sets it as the default menu. To change the
artwork, replace that file (2500×843 PNG, four equal columns) and re-run.

## Configuration

| Variable | Description |
| --- | --- |
| `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` | From the LINE Developers Console |
| `ALLOWED_USER_IDS` | Comma-separated LINE user IDs. Empty = "tell me my ID" mode |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | OAuth for your Google account |
| `GOOGLE_CALENDAR_ID` | Calendar to write to (default `primary`) |
| `DRIVE_ROOT_FOLDER_NAME` | Top-level Drive folder (default `LineArchive`) |
| `TIMEZONE` | IANA zone for folders, reminders, calendar (default `Asia/Bangkok`) |
| `ANTHROPIC_API_KEY` | Enables the chat brain. Optional |
| `CLAUDE_MODEL` | Default `claude-opus-5` |
| `CLAUDE_EFFORT` | `low` (default, fast and cheap) / `medium` / `high` |
| `BOT_NAME` / `USER_NAME` | How the bot refers to itself and to you |
| `CRON_SECRET` | Shared secret for `/cron/reminders` |
| `PORT` | Set by Cloud Run automatically |

## Running locally

```bash
cp .env.example .env   # fill in values
npm install
npm test
node --env-file=.env src/index.js
```

Expose the port with a tunnel (`ngrok http 8080`) and point the LINE webhook
URL at `https://<tunnel>/webhook`. Fire reminders by hand with
`curl -H "X-Cron-Secret: ..." localhost:8080/cron/reminders`.

## Cost

* Cloud Run and Cloud Scheduler free tiers cover personal use.
* Claude: each chat turn is a small request at low effort, typically well under a cent.
* Files use your normal Google Drive storage.

## Not built yet

* Group chats (reminders that tag friends, fetching files sent in a group).
* Reminders from a photo of a schedule.
* To-do list view.
