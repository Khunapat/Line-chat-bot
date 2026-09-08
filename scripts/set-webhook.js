/**
 * Register the webhook URL with LINE and test it.
 *
 *   LINE_CHANNEL_ACCESS_TOKEN=... node scripts/set-webhook.js https://your-service.a.run.app
 *
 * LINE only lets the "Use webhook" switch be flipped in the console, so the
 * script reports whether it is on and tells you where to turn it on if not.
 */
import { messagingApi } from '@line/bot-sdk';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const base = process.argv[2];
if (!token || !base) {
  console.error('Usage: LINE_CHANNEL_ACCESS_TOKEN=... node scripts/set-webhook.js https://your-service-url');
  process.exit(1);
}

const endpoint = base.replace(/\/+$/, '') + '/webhook';
const client = new messagingApi.MessagingApiClient({ channelAccessToken: token });

await client.setWebhookEndpoint({ endpoint });
console.log('webhook URL set to', endpoint);

const test = await client.testWebhookEndpoint({ endpoint });
console.log(test.success ? 'webhook test: OK' : `webhook test failed: ${test.statusCode} ${test.reason} ${test.detail}`);

const info = await client.getWebhookEndpoint();
if (info.active) {
  console.log('"Use webhook" is ON. LINE is ready.');
} else {
  console.log('\n"Use webhook" is still OFF. Turn it on once:');
  console.log('  LINE Developers Console > your channel > Messaging API tab > Webhook settings > Use webhook');
}
