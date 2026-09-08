/**
 * One-time helper: obtain a Google OAuth refresh token for your own Drive.
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run get-token
 *
 * Prints a consent URL, receives the redirect on localhost, and prints the
 * refresh token to paste into GOOGLE_REFRESH_TOKEN.
 * Requires an OAuth client of type "Desktop app".
 */
import http from 'node:http';
import { google } from 'googleapis';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  process.exit(1);
}

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/`;
// drive.file = only files/folders this app creates. Safer than full Drive access.
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT);

const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force a refresh token even if previously granted
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  const { searchParams } = new URL(req.url, REDIRECT);
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    res.end(`Authorization failed: ${error}`);
    console.error('Authorization failed:', error);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.end('Waiting for Google redirect...');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.end('Done. You can close this tab and return to the terminal.');
    if (!tokens.refresh_token) {
      console.error('\nNo refresh token returned. Revoke the app at https://myaccount.google.com/permissions and run again.');
    } else {
      console.log('\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
      console.log('Copy the line above into your .env / Cloud Run environment variables.');
    }
  } catch (err) {
    res.end('Token exchange failed, see terminal.');
    console.error(err);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('1. Open this URL in your browser and sign in with the Google account whose Drive you want to use:\n');
  console.log(url + '\n');
  console.log(`2. After consenting you will be redirected to ${REDIRECT} and the token will print here.`);
});
