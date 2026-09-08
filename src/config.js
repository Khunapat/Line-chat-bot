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

  // Persona / chat brain (optional - without a key the bot falls back to
  // simple keyword commands and cannot do reminders or calendar).
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  claudeModel: env.CLAUDE_MODEL || 'claude-opus-5',
  claudeEffort: env.CLAUDE_EFFORT || 'low',
  botName: env.BOT_NAME || 'น้องไดรฟ์',
  userName: env.USER_NAME || '',

  // Shared secret Cloud Scheduler sends in X-Cron-Secret to /cron/reminders.
  cronSecret: env.CRON_SECRET,

  port: Number(env.PORT || 8080),
};

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
