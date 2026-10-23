// The Google Apps Script people paste into script.google.com so their own
// Gmail forwards bank / card e-mails to JaiJa. It runs in their account;
// JaiJa itself never gets a Gmail permission. Kept in one place so the app
// page and docs/subscriptions.md show the same code.

export const DEFAULT_QUERY = 'newer_than:2d (from:bangkokbank.com OR subject:(receipt OR ใบเสร็จ OR "free trial" OR ทดลองใช้ OR subscription OR renew OR ต่ออายุ))';

export function gmailScript({ url, token, query = DEFAULT_QUERY }) {
  const q = (s) => JSON.stringify(String(s));
  return `// JaiJa: forward bank and card e-mails to your JaiJa (runs in your own Google account).
// 1) Pick "setup" and press Run once, then allow access.
// 2) Every 10 minutes, new e-mails that match QUERY are sent to JaiJa.
// Only e-mails matching QUERY leave your account. Change QUERY to your bank's sender.
const JAIJA_URL = ${q(url)};
const JAIJA_TOKEN = ${q(token)}; // keep this secret
const QUERY = ${q(query)};

function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('forward').timeBased().everyMinutes(10).create();
  PropertiesService.getScriptProperties().setProperty('since', String(Date.now() - 24 * 3600 * 1000));
  forward();
}

function forward() {
  const props = PropertiesService.getScriptProperties();
  let since = Number(props.getProperty('since') || 0);
  const list = [];
  GmailApp.search(QUERY, 0, 50).forEach((thread) => thread.getMessages().forEach((m) => {
    if (m.getDate().getTime() > since) list.push(m);
  }));
  list.sort((a, b) => a.getDate() - b.getDate());
  for (const m of list.slice(0, 40)) {
    const res = UrlFetchApp.fetch(JAIJA_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + JAIJA_TOKEN },
      payload: JSON.stringify({ source: 'email', id: m.getId(), subject: m.getSubject(), text: m.getPlainBody().slice(0, 8000) }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 404 || code === 429 || code >= 500) break; // link off, too many or busy: try again later
    since = m.getDate().getTime();
    props.setProperty('since', String(since));
  }
}
`;
}
