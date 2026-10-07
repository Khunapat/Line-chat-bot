#!/usr/bin/env node
/**
 * Local preview of the web app with fictional data and no Google, LINE or AI
 * calls. The real /api/app routes run on in-memory fakes; sign-in accepts a
 * fixed preview token. The simulation panel (slow / failing network, AI at
 * its limit, Drive or Calendar down) exists only here, through
 * /api/preview/sim, never in the deployed server.
 *
 *   npm run preview            -> http://127.0.0.1:8090/app
 *   PORT=9000 npm run preview
 */
import express from 'express';
import { registerAppRoutes } from '../src/appApi.js';
import { registerWebApp } from '../src/webApp.js';
import { AuthError } from '../src/appAuth.js';
import { Prefs } from '../src/prefs.js';
import { nextReset } from '../src/providers/usage.js';
import { fakeTenants, fakeLine, makeSvc, memoryStore } from '../test/helpers/appFakes.js';
import { addDays, zonedToUtc, todayKey } from '../web/shared/dates.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV === 'production') {
  console.error('preview-app is for local checks only; refusing to run with NODE_ENV=production');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const TZ = 'Asia/Bangkok';
const ME = 'U' + '0'.repeat(31) + '1';
const FRIEND = 'U' + '0'.repeat(31) + '2';
const GROUP = 'C' + '0'.repeat(31) + '5';
const port = Number(process.env.PORT || 8090);
const today = todayKey(TZ);
const at = (dayOffset, hm) => zonedToUtc(addDays(today, dayOffset), hm, TZ);
const day = (n) => addDays(today, n);

// ------------------------------------------------------------- fixtures

const tenants = fakeTenants({
  tenants: [
    { id: ME, type: 'user', name: 'Jai' },
    { id: FRIEND, type: 'user', name: 'เพื่อน A' },
    { id: GROUP, type: 'group', name: 'กลุ่ม 5 ซิปๆ', hostUserId: ME, subFolders: ['Groups', 'กลุ่ม 5 ซิปๆ'] },
  ],
});

const thumb = (name) => `/preview-thumb/${name}`;
const mine = makeSvc({ id: ME }, {
  email: 'jai.example@gmail.com',
  files: [
    { id: 'f1', name: '10-21-05_ใบเสร็จร้านกาแฟ.jpg', day: day(0), mimeType: 'image/jpeg', hasThumb: true, webViewLink: 'https://drive.google.com/file/d/f1/view', modifiedTime: at(0, '10:21') },
    { id: 'f4', name: '14-02-33_โปสเตอร์แข่ง Analog IC.jpg', day: day(-2), mimeType: 'image/jpeg', hasThumb: true, webViewLink: 'https://drive.google.com/file/d/f4/view', modifiedTime: at(-2, '14:02') },
    { id: 'f2', name: 'bookbank.pdf', day: day(-4), mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/f2/view', modifiedTime: at(-4, '09:00') },
    { id: 'f3', name: 'ใบสมัครงาน_ฉบับแก้ไขครั้งที่สาม_สุดท้ายจริงๆ_v7.docx', day: day(-7), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', webViewLink: 'https://drive.google.com/file/d/f3/view', modifiedTime: at(-7, '18:30') },
  ],
  events: [{ id: 'e1', title: 'ประชุมทีม', start: at(1, '14:00'), end: at(1, '15:00'), allDay: false, link: 'https://calendar.google.com/' }],
});
const group = makeSvc({ id: GROUP }, {
  files: [
    { id: 'g1', name: 'สไลด์นำเสนอกลุ่ม_v2.pdf', day: day(-1), mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/g1/view' },
    { id: 'g2', name: '12-40-11_กระดานสรุปงานกลุ่ม.jpg', day: day(-2), mimeType: 'image/jpeg', hasThumb: true, webViewLink: 'https://drive.google.com/file/d/g2/view' },
  ],
});
tenants.attach(ME, mine);
tenants.attach(GROUP, group);
tenants.attach(FRIEND, makeSvc({ id: FRIEND }));
const thumbs = { f1: '39b03a1325302af74996031ffe636177.svg', f4: '37781f7549052cd921554ccf63eba25c.svg', g2: '0333500b5e2636e519f9e08c7fcbdd4b.svg' };

async function seed() {
  const s = mine.store;
  await s.update('reminders.json', [], (list) => {
    list.push(
      { id: 'r1', userId: ME, text: 'กินยา', at: at(0, '19:00'), repeat: 'daily', createdAt: at(-3, '08:00') },
      { id: 'r2', userId: ME, text: 'ส่งเอกสารฝ่ายบุคคล', at: at(1, '10:15'), repeat: 'none', createdAt: at(-1, '08:00') },
      { id: 'r3', userId: ME, text: 'จ่ายค่าเน็ต', at: at(18, '09:00'), repeat: 'monthly', anchorDay: Number(day(18).slice(8)), createdAt: at(-30, '08:00') },
      { id: 'r4', userId: ME, text: 'โทรหาคลินิกทันตกรรม', at: new Date(Date.now() - 6 * 60_000).toISOString(), repeat: 'none', firedAt: new Date(Date.now() - 5 * 60_000).toISOString(), createdAt: at(-2, '08:00') },
      { id: 'r5', userId: ME, text: 'สรุปรายจ่ายสิ้นเดือน', at: zonedToUtc(`${today.slice(0, 8)}${monthEnd(today)}`, '20:00', TZ), repeat: 'monthly', anchorDay: 31, createdAt: at(-40, '08:00') },
    );
  });
  await s.update('opportunities.json', [], (list) => {
    list.push(
      { id: 'd1', title: 'ทุนเรียนต่อ ป.โท ต่างประเทศ รุ่นที่ 12', kind: 'scholarship', organizer: 'มูลนิธิตัวอย่าง', deadline: day(0), deadline_note: '', summary: 'ทุนเต็มจำนวนสำหรับเรียนต่อปริญญาโท 2 ปี', eligibility: 'จบปริญญาตรี เกรดเฉลี่ย 3.00 ขึ้นไป', cost: 'ไม่มีค่าสมัคร', event_dates: 'สัมภาษณ์ปลายเดือนหน้า', source: { kind: 'pdf', fileId: 'f2', webViewLink: 'https://drive.google.com/file/d/f2/view' }, userId: ME, createdAt: at(-8, '10:00') },
      { id: 'd2', title: 'Youth Innovation Forum 2026', kind: 'application', organizer: 'Example Org', deadline: day(3), deadline_note: '23:59', summary: 'Forum for young innovators, 3 days on site.', eligibility: 'Age 18–25', cost: 'Free', event_dates: '14–16 Nov 2026', link: 'https://example.org/apply', links: ['https://example.org/apply'], source: { kind: 'image', fileId: 'f4', webViewLink: 'https://drive.google.com/file/d/f4/view' }, sources: [{ kind: 'link', url: 'https://example.org/apply' }, { kind: 'image', fileId: 'f4' }], mergeCount: 1, userId: ME, createdAt: at(-2, '16:00'), updatedAt: at(-1, '16:12') },
      { id: 'd3', title: 'แข่งออกแบบวงจร Analog IC รอบคัดเลือก', kind: 'competition', organizer: 'ชมรมวงจรตัวอย่าง', deadline: day(8), summary: 'ส่งแบบวงจรและรายงาน 4 หน้า', eligibility: 'นิสิตนักศึกษา ทีมละ 2–3 คน', source: { kind: 'image', fileId: 'f4', webViewLink: 'https://drive.google.com/file/d/f4/view' }, userId: ME, createdAt: at(-2, '14:02') },
      { id: 'd4', title: 'คอร์สอบรม PCB Design to Comply EMC Requirement', kind: 'course', organizer: 'สถาบันอบรมตัวอย่าง', deadline: day(14), deadline_note: 'หรือจนกว่าจะเต็ม', summary: 'อบรม 2 วัน', cost: '1,500 บาท', event_dates: 'สองวันหลังปิดรับ', status: 'applied', appliedAt: at(-4, '11:00'), source: { kind: 'text' }, userId: ME, createdAt: at(-6, '09:00') },
      { id: 'd5', title: 'Community Townhall', kind: 'event', deadline: day(-3), source: { kind: 'text' }, userId: ME, createdAt: at(-10, '09:00') },
      { id: 'd6', title: 'Summer Research Fellowship (no date found)', kind: 'scholarship', deadline: '', summary: 'Poster did not show a closing date.', source: { kind: 'image' }, userId: ME, createdAt: at(-1, '09:00') },
    );
  });
  await s.setUserState(ME, {
    lastMerge: {
      before: { id: 'd2', title: 'Youth Innovation Forum 2026', kind: 'application', deadline: day(3), link: 'https://example.org/apply', source: { kind: 'link', url: 'https://example.org/apply' }, userId: ME, createdAt: at(-2, '16:00') },
      incoming: { fields: { title: 'Youth Innovation Forum 2026 (poster)', kind: 'application', deadline: day(3), deadline_note: '23:59', eligibility: 'Age 18–25' }, source: { kind: 'image', fileId: 'f4' } },
      at: at(-1, '16:12'),
    },
  });
  // Plan the deadline alerts the way the real service does.
  const { ensureAlertsUpToDate } = await import('../src/deadlineService.js');
  await ensureAlertsUpToDate(mine, { timeZone: TZ, now: new Date() });
  await s.update('links.json', [], (list) => {
    list.push({ id: 'l1', url: 'https://example.org/apply', title: 'Apply | Youth Innovation Forum', host: 'example.org', day: day(-1), at: at(-1, '16:00'), userId: ME });
  });
  await s.update('memory.json', [], (list) => {
    list.push({ id: 'm1', text: 'ที่จอดรถ ชั้น 3 ช่อง B12', userId: ME, createdAt: at(-2, '17:00') });
  });
  await s.update('files.json', {}, (idx) => {
    idx.f1 = { caption: 'ใบเสร็จร้านกาแฟ', tags: ['ใบเสร็จ', 'กาแฟ'] };
    idx.f4 = { caption: 'โปสเตอร์แข่งออกแบบวงจร Analog IC', tags: ['deadline'] };
  });
  await group.store.update('links.json', [], (list) => { list.push({ id: 'l2', url: 'https://example.com/brief', title: 'Project brief (example)', host: 'example.com', day: day(-3), at: at(-3, '12:00') }); });
  await group.store.update('files.json', {}, (idx) => { idx.g1 = { caption: 'สไลด์นำเสนองานกลุ่ม' }; idx.g2 = { caption: 'กระดานสรุปงานกลุ่ม' }; });
}

function monthEnd(key) {
  const [y, m] = key.split('-').map(Number);
  return String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
}

// ----------------------------------------------------------- simulation

const sim = { net: 'normal', ai: false, drive: false, cal: false };
const DELAY = { normal: 250, slow: 3000, very: 12000, fail: 400 };

const app = express();
app.disable('x-powered-by');
app.get('/', (_req, res) => res.redirect('/app'));
app.use('/static', express.static(path.join(here, '..', 'assets', 'public')));
app.get('/preview-thumb/:id', (req, res) => {
  const f = thumbs[req.params.id];
  if (!f) return res.status(404).end();
  res.sendFile(path.join(here, '..', 'design', 'assets', f));
});
app.get('/api/preview/sim', (_req, res) => res.json(sim));
app.post('/api/preview/sim', express.json(), (req, res) => {
  const b = req.body || {};
  if (['normal', 'slow', 'very', 'fail'].includes(b.net)) sim.net = b.net;
  for (const k of ['ai', 'drive', 'cal']) if (typeof b[k] === 'boolean') sim[k] = b[k];
  mine.calendar.fail = sim.cal ? 'error' : null;
  res.json(sim);
});
app.use('/api/app', (req, res, next) => {
  if (req.path === '/config') return next();
  setTimeout(() => {
    // "fail" drops the connection, which is what a dead network looks like.
    if (sim.net === 'fail' && req.path !== '/session') return req.socket.destroy();
    next();
  }, DELAY[sim.net]);
});

const realServices = tenants.services.bind(tenants);
tenants.services = async (t) => (sim.drive && t.id !== GROUP ? null : realServices(t));

registerWebApp(app, { maxAge: 0 });
registerAppRoutes(app, {
  tenants,
  lineClient: fakeLine({ members: { [GROUP]: [ME, FRIEND] }, profiles: { [ME]: 'Jai', [FRIEND]: 'เพื่อน A' } }),
  sessionSecret: 'preview-only-secret',
  prefs: new Prefs(memoryStore()),
  timeZone: TZ,
  verifyIdToken: async (tok) => {
    if (typeof tok === 'string' && tok.startsWith('preview')) return { userId: ME, name: 'Jai' };
    throw new AuthError('invalid_token');
  },
  aiUsage: async (now) => ({
    total: sim.ai ? 23 : 17,
    resetAt: nextReset(now).toISOString(),
    models: [
      { model: 'gemini-flash', used: sim.ai ? 20 : 14, limit: 20, exhausted: sim.ai },
      { model: 'gemini-flash-lite', used: 3, limit: null, exhausted: sim.ai },
    ],
  }),
  thumbUrlFor: (_req, _tid, fileId) => (thumbs[fileId] ? thumb(fileId) : ''),
  connectUrlFor: () => '#preview-connect',
  onLangChanged: async () => ({ menuSwitched: false }),
  settings: { liffId: '', preview: true, rootFolderName: 'LineArchive', botName: 'JaiJa', multiUser: true },
});

await seed();
app.listen(port, '127.0.0.1', () => {
  console.log(`JaiJa preview (fictional data, no external calls): http://127.0.0.1:${port}/app`);
});
