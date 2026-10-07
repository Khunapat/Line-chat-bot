#!/usr/bin/env node
/**
 * Browser checks of the web app against the local preview (fictional data).
 *   npm run preview            (in another terminal)
 *   node scripts/verify-app.mjs [baseUrl]
 * Uses Playwright with the preinstalled Chromium. Prints one line per check
 * and exits non-zero on the first failure.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  const req = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'));
  ({ chromium } = req('playwright'));
}

const BASE = process.argv[2] || 'http://127.0.0.1:8090';
const browser = await chromium.launch();
let failed = 0;
const errors = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message.split('\n')[0]}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const sim = (page, s) => page.evaluate((b) => fetch('/api/preview/sim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }), s);

async function open({ width = 390, height = 844, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/app`);
  await page.waitForFunction(() => window.__jaija?.session);
  await sim(page, { net: 'normal', ai: false, drive: false, cal: false });
  return page;
}
const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(700); };

const page = await open();

await check('first open asks for the language and saves it on the server', async () => {
  if (await page.getByText('เลือกภาษา / Choose language').count()) {
    await page.getByText('English').click();
    await page.getByRole('button', { name: "Let's start" }).click();
    await page.waitForTimeout(800);
  } else {
    await page.evaluate(async () => { const a = window.__jaija; await fetch('/api/app/prefs', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.session.token}` }, body: JSON.stringify({ lang: 'en' }) }); a.setLang('en'); });
  }
  await page.reload();
  await page.waitForFunction(() => window.__jaija?.session);
  await page.waitForTimeout(800);
  assert(await page.evaluate(() => document.documentElement.lang) === 'en', 'language did not survive a reload');
  assert(await page.getByRole('link', { name: 'Deadlines' }).count(), 'English nav missing');
});

await check('nav stays pinned while the page scrolls', async () => {
  await go(page, '#/today');
  const before = await page.locator('nav.nav').boundingBox();
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(300);
  const after = await page.locator('nav.nav').boundingBox();
  assert(before && after && Math.abs(before.y - after.y) < 1 && after.y + after.height <= 844 + 1, 'nav moved');
});

await check('week navigation, month overlay keeps the selected day, Escape closes', async () => {
  await go(page, '#/today');
  await page.getByRole('button', { name: 'Next week' }).click();
  await page.waitForTimeout(600);
  assert(await page.getByRole('button', { name: 'Back to today' }).count(), 'no back-to-today after moving');
  const selected = await page.locator('.week .day[aria-pressed="true"]').getAttribute('aria-label');
  await page.getByRole('button', { name: /Open the month calendar/ }).click();
  await page.waitForTimeout(600);
  assert(await page.getByRole('dialog').count() === 1, 'month overlay not open');
  const inMonth = await page.getByRole('dialog').locator('.mday[aria-pressed="true"]').getAttribute('aria-label');
  assert(inMonth.split(':')[0] === selected.split(':')[0], `overlay selected ${inMonth} vs ${selected}`);
  assert(await page.evaluate(() => document.activeElement?.closest('[role=dialog]') !== null), 'focus not in dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert(await page.getByRole('dialog').count() === 0, 'Escape did not close');
  await page.getByRole('button', { name: 'Back to today' }).click();
  await page.waitForTimeout(500);
});

await check('reminder: "at 2" asks am/pm, nothing is guessed, then saves once', async () => {
  await go(page, '#/reminder/new');
  await page.getByRole('button', { name: '“remind me to call mom at 2”' }).click();
  await page.waitForTimeout(200);
  assert(await page.getByText('When is “at 2”?').count(), 'no clarification');
  await page.getByRole('button', { name: 'Set reminder' }).click();
  assert(await page.getByText('Pick one of the options above first.').count(), 'saved without a choice');
  await page.getByText('Afternoon / evening').click();
  await page.getByRole('button', { name: 'Set reminder' }).click();
  await page.waitForTimeout(1600);
  assert(await page.getByRole('heading', { name: 'Reminder set' }).count(), 'no success screen');
  assert(await page.getByText(/14:00/).count(), 'wrong time');
});

await check('reminder: a past time is refused with a clear message', async () => {
  await go(page, '#/reminder/new');
  await page.getByLabel('1. What to remind you about').fill('late thing');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByLabel('Time', { exact: true }).fill('00:01');
  await page.getByLabel('Time', { exact: true }).blur();
  await page.getByRole('button', { name: 'Set reminder' }).click();
  assert(await page.getByText('That time has passed. Pick a later time.').count(), 'no past error');
});

await check('unsaved editor asks before leaving', async () => {
  await page.getByRole('link', { name: 'Deadlines' }).click();
  await page.waitForTimeout(300);
  assert(await page.getByRole('heading', { name: 'Leave without saving?' }).count(), 'no leave dialog');
  await page.getByRole('button', { name: 'Leave' }).click();
  await page.waitForTimeout(800);
  assert(page.url().includes('#/deadlines'), 'did not leave');
});

await check('failed save keeps the input and the retry does not duplicate', async () => {
  await go(page, '#/reminder/new');
  await page.getByLabel('1. What to remind you about').fill('retry test');
  await page.getByRole('button', { name: 'Tomorrow', exact: true }).click();
  await page.getByRole('button', { name: '09:00' }).click();
  await sim(page, { net: 'fail' });
  await page.getByRole('button', { name: 'Set reminder' }).click();
  await page.waitForTimeout(1500);
  assert(await page.getByText('Reminder not set').count(), 'no failure banner');
  assert(await page.getByLabel('1. What to remind you about').inputValue() === 'retry test', 'input lost');
  await sim(page, { net: 'normal' });
  await page.getByRole('button', { name: 'Set reminder' }).click();
  await page.waitForTimeout(1600);
  const n = await page.evaluate(async () => (await (await fetch('/api/app/reminders', { headers: { authorization: `Bearer ${window.__jaija.session.token}` } })).json()).items.filter((r) => r.text === 'retry test').length);
  assert(n === 1, `expected one reminder, found ${n}`);
});

await check('cancel asks first and uses the server result', async () => {
  await go(page, '#/reminders');
  await page.getByRole('button', { name: 'Cancel' }).first().click();
  assert(await page.getByRole('dialog').count(), 'no confirmation');
  await page.getByRole('button', { name: 'Cancel reminder' }).click();
  await page.waitForTimeout(900);
  assert(await page.getByText('Reminder cancelled').count(), 'no toast');
});

await check('deadline: delete then undo restores it', async () => {
  await go(page, '#/deadline/d3');
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.waitForTimeout(900);
  assert(page.url().includes('#/deadlines'), 'not back on the list');
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(1200);
  assert(await page.getByText('แข่งออกแบบวงจร Analog IC รอบคัดเลือก').count(), 'not restored');
});

await check('deadline: date-only items say "No time given"; organiser note shown as written', async () => {
  await go(page, '#/deadline/d1');
  assert(await page.getByText('No time given').count(), 'missing no-time text');
  assert(!(await page.getByText('23:59').count()), 'invented a closing time');
  await go(page, '#/deadline/d2');
  assert(await page.getByText("Organiser's note: 23:59").count(), 'organiser note missing');
  assert(await page.getByText('not the closing date').count(), 'event dates not separated');
});

await check('library: a failed load is an error with retry, never an empty list', async () => {
  await sim(page, { net: 'fail' });
  await go(page, '#/library');
  await page.waitForTimeout(1200);
  assert(await page.getByText("Couldn't load. Try again; your data is still there.").count(), 'no error state');
  assert(!(await page.getByText('Nothing here yet').count()), 'shown as empty');
  await sim(page, { net: 'normal' });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.waitForTimeout(900);
  assert(await page.getByText('bookbank.pdf').count(), 'retry did not load');
});

await check('library: newer search wins over an older slow one', async () => {
  await go(page, '#/library');
  await sim(page, { net: 'slow' });
  await page.getByPlaceholder('File name, caption or tag').fill('receipt-not-there');
  await page.waitForTimeout(500);
  await sim(page, { net: 'normal' });
  await page.getByPlaceholder('File name, caption or tag').fill('bookbank');
  await page.waitForTimeout(4500);
  assert(await page.getByText('1 result for “bookbank”').count(), 'stale result shown');
});

await check('long wait switches to a static, truthful status after 8 s', async () => {
  await sim(page, { net: 'very' });
  await go(page, '#/me');
  await page.waitForTimeout(8600);
  const cls = await page.locator('.mo').first().getAttribute('class');
  assert(cls.includes('is-longwait'), `class was ${cls}`);
  assert(await page.getByText('Still working. This is taking longer than usual, no need to tap again.').count(), 'no long-wait text');
  await go(page, '#/deadlines');
  const live = await page.evaluate(() => document.querySelectorAll('.mo.is-longwait').length);
  assert(live === 0, 'old animation survived navigation');
  await sim(page, { net: 'normal' });
  await page.waitForTimeout(800);
});

await check('group library is labelled and separate from personal files', async () => {
  await go(page, '#/library');
  await page.getByRole('radio', { name: 'กลุ่ม 5 ซิปๆ' }).click();
  await page.waitForTimeout(900);
  assert(await page.getByText(/host's Drive/).count(), 'no group owner line');
  assert(!(await page.getByText('bookbank.pdf').count()), 'personal file leaked into group view');
});

await check('Me: AI usage is marked estimated with a reset time; help and privacy reachable', async () => {
  await go(page, '#/me');
  await page.waitForTimeout(600);
  assert(await page.getByText('Estimated').count(), 'no estimate tag');
  assert(await page.getByText(/Resets (Today|Tomorrow)/).count(), 'no reset time');
  assert(await page.getByText('limit not known yet').count(), 'unknown limit not explicit');
  await page.getByRole('link', { name: 'Privacy' }).click();
  await page.waitForTimeout(400);
  assert(await page.getByText(/drive.file/).count(), 'privacy page missing');
});

await check('switch back to Thai from Me › Language', async () => {
  await go(page, '#/me/lang');
  await page.getByText('ไทย', { exact: true }).click();
  await page.waitForTimeout(900);
  assert(await page.evaluate(() => document.documentElement.lang) === 'th', 'still English');
  assert(await page.getByRole('link', { name: 'วันนี้' }).count(), 'nav not Thai');
});

await check('system reduced motion gives static poses', async () => {
  const p2 = await open({ reducedMotion: 'reduce' });
  await sim(p2, { net: 'slow' });
  await go(p2, '#/deadlines');
  await p2.waitForTimeout(600);
  const cls = await p2.locator('.mo').first().getAttribute('class');
  assert(cls.includes(' rm'), `no rm class: ${cls}`);
  const anim = await p2.locator('.mo .dot').first().evaluate((e) => getComputedStyle(e).animationName);
  assert(anim === 'none', `dots still animate: ${anim}`);
  await sim(p2, { net: 'normal' });
  await p2.context().close();
});

for (const [w, hgt] of [[320, 740], [390, 844], [1280, 900]]) {
  await check(`no horizontal scroll at ${w}px on every tab`, async () => {
    const p3 = await open({ width: w, height: hgt });
    for (const hsh of ['#/today', '#/reminders', '#/reminder/new', '#/deadlines', '#/deadline/d2', '#/deadline-alerts', '#/library', '#/file/f3', '#/me']) {
      await go(p3, hsh);
      await p3.waitForTimeout(400);
      const over = await p3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(over <= 0, `${hsh} overflows by ${over}px`);
    }
    await p3.context().close();
  });
}

await check('touch targets are at least 44 px on Today and Deadlines', async () => {
  for (const hsh of ['#/today', '#/deadlines']) {
    await go(page, hsh);
    await page.waitForTimeout(500);
    const small = await page.evaluate(() => [...document.querySelectorAll('main button, main a.btn, nav a')].filter((e) => e.offsetParent && (e.getBoundingClientRect().height < 44 || e.getBoundingClientRect().width < 44)).map((e) => e.textContent.trim().slice(0, 20)));
    assert(small.length === 0, `${hsh}: ${small.join(', ')}`);
  }
});

await check('no script errors', async () => { assert(errors.length === 0, errors.join(' | ')); });

await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
