// Central place for environment configuration.
const env = process.env;

export const config = {
  line: {
    channelSecret: env.LINE_CHANNEL_SECRET,
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
  },
  allowedUserIds: (env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),

  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN,
    calendarId: env.GOOGLE_CALENDAR_ID || 'primary',
  },
  driveRootFolderName: env.DRIVE_ROOT_FOLDER_NAME || 'LineArchive',
  timeZone: env.TIMEZONE || 'Asia/Bangkok',

  // Chat brain. Optional: without any key the bot falls back to keyword
  // commands and cannot do reminders, calendar or free chat.
  // LLM_PROVIDER = gemini | anthropic | none (auto-detected from keys when unset)
  llmProvider: (env.LLM_PROVIDER || '').toLowerCase(),
  geminiApiKey: env.GEMINI_API_KEY,
  geminiModel: env.GEMINI_MODEL || 'gemini-3.6-flash',
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  claudeModel: env.CLAUDE_MODEL || 'claude-opus-5',
  claudeEffort: env.CLAUDE_EFFORT || 'low',
  // What to do with posters / links: always (scan automatically), ask (offer a
  // button), off. Each scan is one model request.
  autoScan: (env.AUTO_SCAN || 'always').toLowerCase(),
  botName: env.BOT_NAME || 'น้องไดรฟ์',
  userName: env.USER_NAME || '',

  // Multi-user: a "Web application" OAuth client lets other people connect
  // their own Google Drive from a link. Without it, only ALLOWED_USER_IDS work.
  googleWeb: {
    clientId: env.GOOGLE_WEB_CLIENT_ID,
    clientSecret: env.GOOGLE_WEB_CLIENT_SECRET,
  },
  // Optional word new people must send before they can connect.
  inviteCode: env.INVITE_CODE || '',

  // Shared secret Cloud Scheduler sends in X-Cron-Secret to /cron/reminders.
  cronSecret: env.CRON_SECRET,
  // Signs the expiring gallery links. Falls back to other secrets so it needs no setup.
  gallerySecret: env.GALLERY_SECRET || env.CRON_SECRET || env.LINE_CHANNEL_SECRET,
  // Public base URL of this service (derived from the webhook request when unset).
  publicUrl: env.PUBLIC_URL || '',

  port: Number(env.PORT || 8080),
};

/** Which chat provider to use, based on LLM_PROVIDER or whichever key is present. */
export function resolveProvider() {
  if (config.llmProvider) return config.llmProvider;
  if (config.geminiApiKey) return 'gemini';
  if (config.anthropicApiKey) return 'anthropic';
  return 'none';
}

export function multiUserEnabled() {
  return Boolean(config.googleWeb.clientId && config.googleWeb.clientSecret);
}

export function requireConfig() {
  const missing = [];
  if (!config.line.channelSecret) missing.push('LINE_CHANNEL_SECRET');
  if (!config.line.channelAccessToken) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  if (!config.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!config.google.refreshToken) missing.push('GOOGLE_REFRESH_TOKEN');
  if (missing.length) {
    console.error('Missing required environment variables: ' + missing.join(', '));
    process.exit(1);
  }
}
