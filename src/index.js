import express from 'express';
import { middleware, messagingApi, HTTPFetchError, SignatureValidationFailed, JSONParseError } from '@line/bot-sdk';
import { DriveArchive } from './drive.js';

const {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  ALLOWED_USER_IDS = '',
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  DRIVE_ROOT_FOLDER_NAME = 'LineArchive',
  TIMEZONE = 'Asia/Bangkok',
  PORT = 8080,
} = process.env;

if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN) {
  console.error('LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN are required');
  process.exit(1);
}

const allowedUsers = new Set(
  ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean),
);

const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN });
const lineBlob = new messagingApi.MessagingApiBlobClient({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN });

const drive = new DriveArchive({
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  refreshToken: GOOGLE_REFRESH_TOKEN,
  rootFolderName: DRIVE_ROOT_FOLDER_NAME,
  timeZone: TIMEZONE,
});

const app = express();

// Health check for Cloud Run / uptime monitors.
app.get('/', (_req, res) => res.status(200).send('line-drive-archiver ok'));

// NOTE: do not put express.json() in front of this route. The LINE
// middleware needs the raw body to verify the X-Line-Signature header.
app.post('/webhook', middleware({ channelSecret: LINE_CHANNEL_SECRET }), async (req, res) => {
  const events = req.body.events ?? [];
  // Handle each event, but never let one failure break the whole batch.
  await Promise.all(events.map((event) => handleEvent(event).catch((err) => {
    console.error('event failed', { type: event.type, err: describeError(err) });
  })));
  res.status(200).end();
});

// Turn LINE middleware errors into proper status codes instead of a 500.
app.use((err, _req, res, _next) => {
  if (err instanceof SignatureValidationFailed) return res.status(401).send('invalid signature');
  if (err instanceof JSONParseError) return res.status(400).send('invalid JSON');
  console.error('unhandled error', describeError(err));
  res.status(500).end();
});

app.listen(Number(PORT), () => {
  console.log(`listening on :${PORT} (tz=${TIMEZONE}, root=${DRIVE_ROOT_FOLDER_NAME}, allowed=${allowedUsers.size})`);
});

// ---------------------------------------------------------------------------

async function handleEvent(event) {
  if (event.type !== 'message') return; // follow/unfollow/join etc. are ignored

  const userId = event.source?.userId;
  const replyToken = event.replyToken;

  // First-run helper: with no allow-list configured, tell the sender their ID
  // so it can be placed in ALLOWED_USER_IDS. Nothing is saved in this mode.
  if (allowedUsers.size === 0) {
    await reply(replyToken, userId,
      `Your LINE user ID is:\n${userId}\n\nSet ALLOWED_USER_IDS to this value and redeploy to start archiving.`);
    return;
  }
  if (!allowedUsers.has(userId)) {
    console.warn('ignoring message from non-allowed user', userId);
    return;
  }

  const message = event.message;
  const when = new Date(event.timestamp ?? Date.now());

  try {
    let saved;
    switch (message.type) {
      case 'text':
        saved = await drive.appendNote(message.text, when);
        await reply(replyToken, userId, `Saved to ${drive.todayKey(when)}/notes.md\n${saved.webViewLink}`);
        return;

      case 'location': {
        const { title, address, latitude, longitude } = message;
        const maps = `https://www.google.com/maps?q=${latitude},${longitude}`;
        saved = await drive.appendNote([title, address, maps].filter(Boolean).join('\n'), when);
        await reply(replyToken, userId, `Saved location to notes.md\n${saved.webViewLink}`);
        return;
      }

      case 'image':
      case 'video':
      case 'audio':
      case 'file':
        saved = await archiveBinary(message, when);
        await reply(replyToken, userId, `Saved ${saved.name}\n${saved.webViewLink}`);
        return;

      case 'sticker':
        return; // nothing worth archiving

      default:
        console.log('unhandled message type', message.type);
    }
  } catch (err) {
    console.error('archive failed', describeError(err));
    await reply(replyToken, userId, `Sorry, could not save that (${message.type}). Check the server logs.`)
      .catch(() => {});
  }
}

/**
 * Download a media message from LINE and stream it straight into Drive.
 * LINE keeps media only briefly, so this happens at webhook time.
 */
async function archiveBinary(message, when) {
  if (message.contentProvider?.type === 'external' && message.contentProvider.originalContentUrl) {
    // Media hosted outside LINE (rare, e.g. from some integrations)
    const resp = await fetch(message.contentProvider.originalContentUrl);
    if (!resp.ok) throw new Error(`external media fetch failed: ${resp.status}`);
    const mimeType = resp.headers.get('content-type') || 'application/octet-stream';
    return drive.uploadStream({
      name: buildFileName(message, mimeType, when),
      mimeType,
      body: resp.body,
      date: when,
    });
  }

  const { httpResponse, body } = await lineBlob.getMessageContentWithHttpInfo(message.id);
  const mimeType = httpResponse.headers.get('content-type') || 'application/octet-stream';
  return drive.uploadStream({
    name: buildFileName(message, mimeType, when),
    mimeType,
    body,
    date: when,
  });
}

function buildFileName(message, mimeType, when) {
  const stamp = drive.timeKey(when);
  if (message.type === 'file' && message.fileName) {
    return `${stamp}_${sanitize(message.fileName)}`;
  }
  const ext = extensionFor(mimeType, message.type);
  return `${stamp}_${message.type}_${message.id}${ext}`;
}

function extensionFor(mimeType, type) {
  const table = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/aac': '.aac',
    'application/pdf': '.pdf',
  };
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (table[base]) return table[base];
  const fallback = { image: '.jpg', video: '.mp4', audio: '.m4a', file: '' };
  return fallback[type] ?? '';
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 200);
}

/**
 * Reply with the reply token while it is still valid; fall back to a push
 * message when a big upload took too long and the token has expired.
 */
async function reply(replyToken, userId, text) {
  const messages = [{ type: 'text', text }];
  try {
    await lineClient.replyMessage({ replyToken, messages });
  } catch (err) {
    if (err instanceof HTTPFetchError && userId) {
      console.warn('reply failed, pushing instead', err.status);
      await lineClient.pushMessage({ to: userId, messages });
    } else {
      throw err;
    }
  }
}

function describeError(err) {
  if (err instanceof HTTPFetchError) return `${err.status} ${err.body}`;
  return err?.stack || String(err);
}
