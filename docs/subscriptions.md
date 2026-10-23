# Subscriptions and free trials

JaiJa keeps a list of what charges your card every month or year, and of free
trials with their end dates, so a trial you forgot does not turn into a charge.
Personal chats only: nothing about money is stored in a group folder.

## What it does

* **Free trials**: reminds you 2 days and 1 day before the trial ends, and on
  the morning of the last day, with "I cancelled it" / "Keep it" buttons.
* **Yearly plans**: reminds you 7 days and 1 day before the renewal.
  Monthly plans: only when you switch the reminder on.
* **Charges from your bank** (e-mail or SMS, forwarded, pasted or as a
  screenshot):
  * matches a subscription you track: quiet; the next charge date moves on;
  * a trial that just started charging: tells you, so you can still cancel;
  * a charge for something you marked as cancelled: warns you, with what to do;
  * a price change: tells you;
  * a new charge that looks like a subscription (a known service, or the same
    amount from the same place a month or a year apart): asks
    "monthly / yearly / one-time / I don't know this";
  * anything else (a coffee, a QR payment, a transfer): quiet.
* Alerts go out at the deadline alert time (`เตือน deadline … 20:00` changes both).

Ways to add one: tell JaiJa in chat ("เริ่มทดลอง Netflix ฟรีถึง 30 ต.ค.",
"Spotify 149 บาท ตัดทุกวันที่ 3"), paste or forward a card SMS / bank e-mail,
send a screenshot, or use **ของฉัน › ค่าสมาชิกและทดลองใช้** in the web app.
Type `ค่าสมาชิก` in chat for the list.

## Connecting bank e-mails and SMS

JaiJa cannot read your e-mail, SMS or other LINE chats by itself. Instead, a
private forwarding link receives the messages you choose to send it:

1. Web app: **ของฉัน › แจ้งเตือนจากธนาคาร** › turn on the private link. You get
   the URL (`/hooks/money`) and a secret. Keep the secret private; "New link"
   replaces it and "Turn off" stops it.
2. Pick one or more sources below. **Test the link** checks it without
   storing anything.

The secret goes in the header `Authorization: Bearer <secret>`. For apps that
cannot set headers there is also a link with the secret in the path (it can
then appear in request logs, so prefer the header).

### Gmail (Apps Script, runs in your own Google account)

script.google.com › New project › paste the code (the web app shows it with
your URL and secret filled in) › choose `setup` › Run once › allow access.
Every 10 minutes it sends new e-mails matching `QUERY`. Change `QUERY` to the
sender of your bank's card e-mails (look at the From line of one of them).

```js
// JaiJa: forward bank and card e-mails to your JaiJa (runs in your own Google account).
// 1) Pick "setup" and press Run once, then allow access.
// 2) Every 10 minutes, new e-mails that match QUERY are sent to JaiJa.
// Only e-mails matching QUERY leave your account. Change QUERY to your bank's sender.
const JAIJA_URL = "https://YOUR-SERVICE.run.app/hooks/money";
const JAIJA_TOKEN = "PASTE-YOUR-SECRET-FROM-THE-APP"; // keep this secret
const QUERY = "newer_than:2d (from:bangkokbank.com OR subject:(receipt OR ใบเสร็จ OR \"free trial\" OR ทดลองใช้ OR subscription OR renew OR ต่ออายุ))";

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
```

### iPhone (SMS)

Shortcuts › Automation › New Automation › Message. Sender: your bank's SMS
name; Message Contains: `บาท`; Run Immediately. Action **Get Contents of URL**:
the URL, Method POST, header `Authorization` = `Bearer <secret>`, Request Body
JSON with `text` = Shortcut Input.

### Android (SMS)

Any SMS-to-webhook forwarder you trust (for example MacroDroid or Tasker):
trigger on SMS from your bank, HTTP POST to the URL with the same header, and
the SMS text as the body (plain text, or JSON `{"text": "..."}`).

## What is kept, what is not

* The message text is never stored. Only the charge read from it: merchant,
  amount, date, last 3-4 card digits, and a fingerprint so resends are skipped.
  It lives in your own Drive (`_data/subscriptions.json`, `_data/charges.json`).
* Messages with a one-time code (OTP) are dropped before anything else.
* Known formats (Bangkok Bank payment e-mails, common card SMS) are read with
  patterns on the server. Other messages that look like money go to the same
  AI as the chat (at most 40 a day per person); everything else is ignored.
* Limits: 120 forwarded messages an hour per person, 64 KB each.

## Files

* `src/subscriptions.js` – pure logic: matching a card descriptor to a saved
  subscription, billing cycles that keep their day, alert plan, recurrence.
* `src/chargeParse.js` – reading bank / card messages (patterns + AI schema), OTP filter.
* `src/subscriptionService.js` – saving, charge outcomes, questions, alerts, daily upkeep.
* `src/moneyHook.js` – the forwarding link (`POST /hooks/money`).
* `web/app/js/views/subscriptions.js`, `web/app/js/gmailScript.js` – the web pages.
