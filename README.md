# LINE → Google Drive archiver

A tiny LINE Official Account bot. Anything you send it (links, text, photos,
videos, voice notes, files, locations) is saved immediately into your own
Google Drive, organised by day, and the bot replies with the Drive link.

```
My Drive/
└── LineArchive/
    ├── 2026-09-08/
    │   ├── notes.md                       ← every text message / link of the day
    │   ├── 21-32-10_image_5501234.jpg
    │   └── 22-33-05_Akibul_CV.pdf
    └── 2026-09-09/
        └── ...
```

Why: LINE's "send to myself" chat is convenient across devices, but it gets
crowded, is hard to scroll back through, and media expires after a while.
Drive keeps everything, is searchable, and never expires.

## How it works

```
Phone/PC ──LINE──▶ LINE Platform ──webhook──▶ Cloud Run (this app) ──▶ Google Drive
                                        ◀── reply with Drive link ──┘
```

* `src/index.js` – Express server. Verifies the LINE signature, downloads the
  message content, uploads to Drive, replies with the link. Only user IDs in
  `ALLOWED_USER_IDS` are served.
* `src/drive.js` – Drive helper. Creates `LineArchive/YYYY-MM-DD/` on demand
  and appends text messages to that day's `notes.md`.
* `scripts/get-refresh-token.js` – one-time OAuth flow for your Google account.

Drive access uses **your own Google account via OAuth** rather than a service
account, because service accounts have no storage quota on personal Gmail
accounts. The scope is `drive.file`, so the app can only see files it created.

## Setup

You will need: a LINE account, a Google account, and the
[gcloud CLI](https://cloud.google.com/sdk/docs/install) if deploying to Cloud Run.
Node.js 20+ is needed only to run the token script locally.

### A. Create the LINE channel

1. Go to <https://developers.line.biz/console/> and log in with LINE.
2. Create a **Provider** (any name), then **Create a Messaging API channel**.
   Fill in the required fields; the icon/description are only shown to you.
3. On the channel's **Basic settings** tab copy the **Channel secret** →
   `LINE_CHANNEL_SECRET`.
4. On the **Messaging API** tab click **Issue** under *Channel access token
   (long-lived)* → `LINE_CHANNEL_ACCESS_TOKEN`.
5. Still on the Messaging API tab, scan the QR code with your phone to add the
   bot as a friend. Leave **Use webhook** for later (step D).
6. Optional: in the [LINE Official Account Manager](https://manager.line.biz/)
   → Settings → Response settings, turn **off** *Auto-response messages* so
   the bot doesn't send canned replies.

### B. Create the Google OAuth client

1. Go to <https://console.cloud.google.com/> and create a project
   (e.g. `line-archiver`).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → External → fill app name and
   your email → Save. Under *Test users* add your own Gmail address.
   (Staying in "Testing" mode is fine for personal use, but Google expires
   refresh tokens after 7 days in that mode. To avoid re-authorising weekly,
   click **Publish app** – no verification is needed for the `drive.file`
   scope when only you use it.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Desktop app**. Copy the client ID and secret →
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

### C. Get a refresh token (one time, on your computer)

```bash
git clone <this repo> && cd line-chat-bot
npm install
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run get-token
```

Open the printed URL, sign in with the Google account whose Drive you want to
use, accept the permission. The script prints `GOOGLE_REFRESH_TOKEN=...`.

### D. Deploy to Cloud Run

```bash
gcloud auth login
gcloud config set project <your-project-id>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud run deploy line-archiver \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --memory 512Mi \
  --timeout 300 \
  --set-env-vars "LINE_CHANNEL_SECRET=...,LINE_CHANNEL_ACCESS_TOKEN=...,GOOGLE_CLIENT_ID=...,GOOGLE_CLIENT_SECRET=...,GOOGLE_REFRESH_TOKEN=...,TIMEZONE=Asia/Bangkok"
```

(`--allow-unauthenticated` is required so LINE's servers can reach the
webhook; the app itself rejects anything without a valid LINE signature.)

The command prints a **Service URL** like `https://line-archiver-xxxx.a.run.app`.

Back in the LINE Developers Console → Messaging API tab:

1. **Webhook URL** = `https://line-archiver-xxxx.a.run.app/webhook` → Update → **Verify** (should say *Success*).
2. Turn **Use webhook** on.

### E. Lock the bot to your own account

Send any message to the bot. Because `ALLOWED_USER_IDS` is still empty it
replies with your LINE user ID (starts with `U`). Redeploy with it:

```bash
gcloud run services update line-archiver --region asia-southeast1 \
  --update-env-vars ALLOWED_USER_IDS=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Now send a link, a photo, or a file. Within a couple of seconds the bot replies
with the Drive link, and the file is in `My Drive/LineArchive/<today>/`.

## Configuration

| Variable | Description |
| --- | --- |
| `LINE_CHANNEL_SECRET` | From LINE Developers Console, Basic settings |
| `LINE_CHANNEL_ACCESS_TOKEN` | Long-lived token, Messaging API tab |
| `ALLOWED_USER_IDS` | Comma-separated LINE user IDs allowed to use the bot. Empty = "tell me my ID" mode, nothing saved |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth Desktop client |
| `GOOGLE_REFRESH_TOKEN` | Output of `npm run get-token` |
| `DRIVE_ROOT_FOLDER_NAME` | Top-level folder in My Drive (default `LineArchive`) |
| `TIMEZONE` | IANA zone for the day folders (default `Asia/Bangkok`) |
| `PORT` | Listen port (Cloud Run sets this automatically) |

## Running locally

```bash
cp .env.example .env   # fill in values
npm install
node --env-file=.env src/index.js
```

To receive real LINE webhooks locally, expose the port with a tunnel
(e.g. `ngrok http 8080`) and point the webhook URL at `https://<tunnel>/webhook`.

## Cost

* Cloud Run free tier comfortably covers personal use (a few hundred requests a month).
* LINE reply messages are free and unlimited. The bot only falls back to a
  push message (limited on the free plan) if an upload took longer than the
  reply token's lifetime.
* Files use your normal Google Drive storage.

## Ideas for later

* Fetch the page `<title>` for links and store it next to the URL in `notes.md`.
* Add a `/find <keyword>` command that searches Drive and replies with matches.
* Sort by type instead of (or in addition to) date, e.g. `LineArchive/PDF/…`.
