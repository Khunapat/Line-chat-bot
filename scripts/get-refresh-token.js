/**
 * One-time helper: obtain a Google OAuth refresh token for your own Drive
 * and Calendar.
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run get-token
 *
 * Prints a consent URL. After you approve, the browser is redirected to
 * http://localhost:53682/ and the token is captured automatically. When that
 * page cannot load (for example when running inside Google Cloud Shell),
 * copy the full URL from the browser's address bar and paste it into this
 * terminal instead.
 *
 * Requires an OAuth client of type "Desktop app".
 */
import http from 'node:http';
import readline from 'node:readline';
import { google } from 'googleapis';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  process.exit(1);
}

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/`;
// drive.file      = only files/folders this app creates (safer than full Drive access)
// calendar.events = create/list events so "ลง calendar ..." works
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar.events',
];

const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT);
const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force a refresh token even if previously granted
  scope: SCOPES,
});

let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      console.error('\nNo refresh token returned. Revoke the app at https://myaccount.google.com/permissions and run again.');
      process.exit(1);
    }
    console.log('\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
    console.log('Copy the line above into your .env / Cloud Run environment variables.');
    process.exit(0);
  } catch (err) {
    console.error('Token exchange failed:', err?.message || err);
    process.exit(1);
  }
}

function codeFrom(input) {
  const s = input.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.searchParams.get('code');
  } catch {
    return s; // a bare code pasted directly
  }
}

// 1) automatic capture via localhost redirect
const server = http.createServer(async (req, res) => {
  const { searchParams } = new URL(req.url, REDIRECT);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  if (error) {
    res.end(`Authorization failed: ${error}`);
    console.error('Authorization failed:', error);
    process.exit(1);
  }
  if (!code) return void res.end('Waiting for Google redirect...');
  res.end('Done. You can close this tab and return to the terminal.');
  server.close();
  await finish(code);
});
server.on('error', () => { /* port busy: manual paste still works */ });
server.listen(PORT);

// 2) manual paste fallback
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const code = codeFrom(line);
  if (code) finish(code);
});

console.log('1. Open this URL in your browser and sign in with the Google account whose Drive you want to use:\n');
console.log(url + '\n');
console.log('2. Approve access. If the browser then shows "This site can\'t be reached" for localhost,');
console.log('   copy the ENTIRE address from the address bar (it starts with http://localhost:53682/?code=...)');
console.log('   and paste it here, then press Enter.\n');
