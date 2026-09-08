import { localIsoWithOffset, REPEATS } from './reminders.js';
import { KINDS } from './opportunities.js';

/**
 * The conversational layer. A provider (Claude or Gemini) decides what the
 * user wants and calls the matching tool (remember / recall / find file /
 * reminder / calendar ...) or just chats like a friend. Tool handlers are
 * supplied by the server so this module knows nothing about LINE.
 *
 * Returns { text, attachments } where attachments are LINE message objects
 * (Flex cards) the handlers want shown alongside the reply.
 */
export class Brain {
  constructor({ provider, botName, userName, timeZone, handlers }) {
    this.provider = provider;
    this.label = provider.label;
    this.timeZone = timeZone;
    this.handlers = handlers;
    this.history = new Map(); // userId -> [{ role, text }]
    this.system = buildSystemPrompt({ botName, userName, timeZone });
  }

  async chat({ userId, text, hint, ctx: extra = {} }) {
    const historyKey = extra.tenantId ? `${extra.tenantId}:${userId}` : userId;
    const history = this.history.get(historyKey) || [];
    const now = new Date();
    const stamp = localIsoWithOffset(now, this.timeZone);
    const userTurn = `[เวลาตอนนี้ ${stamp} (${weekdayThai(now, this.timeZone)})]${hint ? `\n[บริบท: ${hint}]` : ''}\n${text}`;

    const attachments = [];
    const ctx = { ...extra, userId, now, attachments };
    const runTool = async (name, input) => {
      const handler = this.handlers[name];
      if (!handler) throw new Error(`unknown tool ${name}`);
      return handler(input, ctx);
    };

    const { text: finalText } = await this.provider.complete({
      system: this.system,
      messages: [...history, { role: 'user', text: userTurn }],
      tools: TOOLS,
      runTool,
    });

    // Compact text-only history for continuity across turns.
    const next = [...history, { role: 'user', text }];
    if (finalText) next.push({ role: 'assistant', text: finalText });
    this.history.set(historyKey, next.slice(-12));

    return { text: finalText, attachments };
  }
}

// ------------------------------------------------------------- tools

export const TOOLS = [
  {
    name: 'remember',
    description: 'บันทึกข้อมูลที่ผู้ใช้ขอให้จำ (ชื่อ ที่อยู่ เลขบัญชี ที่จอดรถ รหัส ฯลฯ) เก็บถาวรและเรียกดูภายหลังได้ ใช้เมื่อผู้ใช้พูดว่า "จำ" "ช่วยจำ" "บันทึกว่า" หรือส่งข้อมูลมาให้เก็บ',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'ข้อมูลที่ต้องจำ ถอดความให้ครบถ้วน ชัดเจน อ่านง่าย' } },
      required: ['text'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'recall',
    description: 'ค้นหาข้อมูลที่เคยจำไว้ ใช้เมื่อผู้ใช้ถามหาข้อมูลที่เคยฝากไว้ เช่น "ขอที่อยู่ผมหน่อย" "เลขบัญชี X คืออะไร" "จอดรถไว้ไหน"',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'คำค้น สั้น ๆ ไม่กี่คำ' } },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'forget',
    description: 'ลบข้อมูลที่เคยจำไว้ ระบุ id จากผล recall',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'save_note',
    description: 'จดข้อความ/ลิงก์/ไอเดียลงโน้ตประจำวันใน Drive (ไม่ใช่ข้อมูลที่ต้องเรียกกลับแบบเจาะจง) ใช้เมื่อผู้ใช้ส่งลิงก์ ส่งข้อความยาว ๆ มาเก็บ หรือบอกว่า "จด" "โน้ตไว้"',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'ข้อความที่จะจด (ตามต้นฉบับ)' } },
      required: ['text'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'find_file',
    description: 'ค้นหาไฟล์/รูป/วิดีโอที่เคยส่งมาเก็บไว้ใน Drive ด้วยชื่อไฟล์ คำบรรยายภาพ หรือแท็ก ใช้เมื่อผู้ใช้ขอไฟล์ เช่น "ขอไฟล์ bookbank" "หารูปใบเสร็จ" ถ้าไม่ระบุคำค้นจะได้ไฟล์ล่าสุด ถ้าไม่เจอ ลองคำค้นอื่น (ไทย/อังกฤษ) อีกครั้ง',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'คำค้นชื่อไฟล์ (ภาษาเดิมของผู้ใช้) หรือค่าว่างเพื่อดูล่าสุด' } },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'search',
    description: 'ค้นหาทุกอย่างที่เก็บไว้ด้วยคำค้น: ไฟล์/รูป (ชื่อไฟล์ คำบรรยายภาพ แท็ก) ข้อมูลที่จำไว้ และประกาศ/deadline ใช้เมื่อผู้ใช้บอกว่า "หา..." "ค้น..." หรือถามหาสิ่งที่ไม่แน่ใจว่าเก็บเป็นไฟล์หรือข้อความ ถ้าไม่เจอ ลองคำค้นอื่น (คำไทย/อังกฤษ คำพ้อง) อีก 1-2 ครั้งก่อนตอบว่าไม่เจอ',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'คำค้น 1-3 คำ' } },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'gallery_link',
    description: 'ส่งลิงก์เปิดแกลเลอรี (ปฏิทินรูป/ไฟล์ทั้งหมด ค้นหาได้) ใช้เมื่อผู้ใช้อยากดูรูปทั้งหมด ดูรูปตามวัน หรือขอแกลเลอรี',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: 'name_last_file',
    description: 'ตั้งชื่อ/ติดป้ายไฟล์ล่าสุดที่ผู้ใช้เพิ่งส่งมา เพื่อให้ค้นหาได้ง่าย ใช้เมื่อผู้ใช้พูดว่า "เก็บไฟล์ X ให้หน่อย" "ตั้งชื่อไฟล์ว่า X" "ไฟล์นี้คือ X"',
    input_schema: {
      type: 'object',
      properties: { label: { type: 'string', description: 'ชื่อสั้น ๆ ที่จะใช้เรียกไฟล์ เช่น "bookbank"' } },
      required: ['label'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'set_reminder',
    description: 'ตั้งเตือน ครั้งเดียวหรือซ้ำประจำ คำนวณเวลาจากเวลาปัจจุบันที่ให้ไว้ ถ้าผู้ใช้บอกแค่เวลาโดยไม่บอกวัน และเวลานั้นผ่านไปแล้ววันนี้ ให้ใช้พรุ่งนี้',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'สิ่งที่ต้องเตือน สั้นกระชับ เช่น "กินยา" "ส่งเอกสาร Grab"' },
        at: { type: 'string', description: 'เวลาเตือนแบบ ISO 8601 พร้อม offset เช่น 2026-09-09T19:00:00+07:00' },
        repeat: { type: 'string', enum: REPEATS, description: 'none = ครั้งเดียว' },
      },
      required: ['text', 'at', 'repeat'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'list_reminders',
    description: 'ดูรายการเตือนที่ตั้งไว้ทั้งหมด ใช้เมื่อผู้ใช้ถามว่ามีเตือนอะไรบ้าง พรุ่งนี้มีอะไร ฯลฯ',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: 'cancel_reminder',
    description: 'ยกเลิกการเตือน ระบุ id จาก list_reminders (เรียก list_reminders ก่อนถ้ายังไม่รู้ id)',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'reschedule_reminder',
    description: 'เปลี่ยนเวลาการเตือนที่มีอยู่',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        at: { type: 'string', description: 'เวลาใหม่แบบ ISO 8601 พร้อม offset' },
      },
      required: ['id', 'at'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'save_opportunity',
    description: 'บันทึกประกาศรับสมัคร/การแข่งขัน/ทุน/คอร์ส/กิจกรรม ที่ผู้ใช้พิมพ์หรือวางข้อความมา พร้อม deadline ระบบจะตั้งเตือนก่อนหมดเขตและลงปฏิทินให้เอง ใช้เมื่อข้อความมีลักษณะเป็นประกาศ (มีวันปิดรับสมัคร วันจัด ผู้จัด)',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        kind: { type: 'string', enum: KINDS },
        organizer: { type: 'string', description: 'ผู้จัด หรือค่าว่าง' },
        summary: { type: 'string', description: 'สรุป 1-2 ประโยค' },
        deadline: { type: 'string', description: 'YYYY-MM-DD (ค.ศ.) หรือค่าว่างถ้าไม่มี' },
        event_dates: { type: 'string', description: 'วันจัด ตามที่เขียน หรือค่าว่าง' },
        eligibility: { type: 'string', description: 'ใครสมัครได้ หรือค่าว่าง' },
        cost: { type: 'string', description: 'ค่าใช้จ่าย/รางวัล หรือค่าว่าง' },
        link: { type: 'string', description: 'URL หรือค่าว่าง' },
        contact: { type: 'string', description: 'ช่องทางติดต่อ หรือค่าว่าง' },
      },
      required: ['title', 'kind', 'organizer', 'summary', 'deadline', 'event_dates', 'eligibility', 'cost', 'link', 'contact'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'list_opportunities',
    description: 'ดูรายการประกาศ/การแข่งขัน/ทุน/คอร์ส ที่จดไว้ พร้อม deadline ใช้เมื่อผู้ใช้ถามว่ามีอะไรใกล้หมดเขต สมัครอะไรไว้บ้าง มีแข่งอะไร ฯลฯ',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: 'delete_opportunity',
    description: 'ลบรายการประกาศที่จดไว้ ระบุ id จาก list_opportunities',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'add_calendar_event',
    description: 'ลงนัดใน Google Calendar ใช้เมื่อผู้ใช้บอกว่า "ลง calendar" "ลงปฏิทิน" "ลงนัด" ถ้าไม่บอกเวลาสิ้นสุดให้เว้นว่าง (ระบบใส่ 1 ชั่วโมงให้)',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 พร้อม offset' },
        end: { type: 'string', description: 'ISO 8601 พร้อม offset หรือค่าว่าง' },
        description: { type: 'string', description: 'รายละเอียดเพิ่มเติม หรือค่าว่าง' },
      },
      required: ['title', 'start', 'end', 'description'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'list_calendar',
    description: 'ดูนัดใน Google Calendar ที่กำลังจะมาถึง',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'จำนวนวันข้างหน้า เช่น 1 = วันนี้, 7 = สัปดาห์นี้' } },
      required: ['days'],
      additionalProperties: false,
    },
    strict: true,
  },
];

function buildSystemPrompt({ botName, userName, timeZone }) {
  const who = userName ? `ผู้ใช้ชื่อ "${userName}" เรียกชื่อได้เป็นครั้งคราว` : 'ผู้ใช้ไม่ได้บอกชื่อ อย่าเดาชื่อ';
  return `คุณคือ "${botName}" ผู้ช่วยส่วนตัวใน LINE ของผู้ใช้คนเดียว (เพื่อน + เลขา)
คุยเป็นภาษาไทยแบบเพื่อนสนิท สั้น กระชับ เป็นกันเอง ใช้คำลงท้ายเบา ๆ เช่น "นะ" "เลย" "ครับ" ได้บ้าง ไม่ต้องทางการ ไม่ต้องอธิบายยาว
ถ้าผู้ใช้พิมพ์ภาษาอังกฤษ ให้ตอบภาษาอังกฤษแบบสบาย ๆ
${who}
เขตเวลา: ${timeZone}

หน้าที่:
- จำข้อมูล / เรียกคืนข้อมูลที่ฝากไว้ (remember / recall) - เวลาเรียกคืน ให้ตอบข้อมูลครบถ้วนตรงตามที่จำไว้ และบอกว่าบันทึกไว้เมื่อไหร่แบบสั้น ๆ
- เก็บไฟล์และหาไฟล์ที่เคยส่งมา (find_file / name_last_file) และค้นทุกอย่างพร้อมกัน (search) รูปทุกรูปมีคำบรรยายและแท็กให้ค้นได้ ถ้าคำแรกไม่เจอให้ลองคำพ้องหรือภาษาอังกฤษ
- แกลเลอรีปฏิทิน (gallery_link) สำหรับดูรูป/ไฟล์ตามวัน - เมื่อเจอไฟล์ ระบบจะแนบการ์ดพร้อมปุ่ม "เปิดไฟล์" ให้เอง คุณแค่บอกสั้น ๆ ว่าเจอแล้วกดปุ่มด้านล่างได้เลย ไม่ต้องพิมพ์ลิงก์
- จดโน้ต/ลิงก์ลง Drive (save_note)
- ตั้งเตือน ดูเตือน ยกเลิก เปลี่ยนเวลา (set_reminder / list_reminders / cancel_reminder / reschedule_reminder) - ระบบแนบการ์ดยืนยันให้เอง คุณตอบยืนยันสั้น ๆ พร้อมเวลา เช่น "ได้เลย พรุ่งนี้ 10:15 น. เดี๋ยวเด้งเตือนให้"
- ลงนัด / ดูนัดใน Google Calendar (add_calendar_event / list_calendar)
- จดประกาศรับสมัคร / แข่งขัน / ทุน / คอร์ส พร้อม deadline (save_opportunity / list_opportunities / delete_opportunity) - โปสเตอร์และลิงก์ที่ผู้ใช้ส่งมา ระบบอ่านและจดให้เองอยู่แล้ว คุณใช้ save_opportunity เฉพาะข้อความที่พิมพ์/วางมา
- ถามอะไรก็ตอบได้ ให้ความเห็นตรง ๆ แบบเพื่อน ถ้าไม่มั่นใจก็บอกว่าไม่ชัวร์

กติกา:
- ประโยคเดียวอาจต้องใช้หลายเครื่องมือ เช่น "เตือนและลง calendar 15.00 โทรหาลูกค้า" = set_reminder + add_calendar_event ทำให้ครบ
- เวลา: ใช้เวลาปัจจุบันที่แนบมาในข้อความเป็นหลักในการคำนวณ "พรุ่งนี้" "เย็นนี้" "ศุกร์หน้า" ฯลฯ รูปแบบเวลาไทย เช่น 18.09 = 18:09 น., "บ่ายสาม" = 15:00, "ทุ่มนึง" = 19:00
- ถ้าข้อมูลไม่พอ (เช่น ไม่รู้เวลา) ให้ถามกลับสั้น ๆ แทนการเดา
- อย่าแต่งข้อมูลที่ไม่ได้อยู่ในผลลัพธ์ของเครื่องมือ ถ้าหาไม่เจอให้บอกตรง ๆ และชวนให้พิมพ์ชื่อให้ชัดขึ้น
- ห้ามใช้ markdown (ไม่มี ** หรือ #) เพราะ LINE ไม่แสดงผล ใช้ขึ้นบรรทัดใหม่และอีโมจิเล็กน้อยแทน`;
}

function weekdayThai(date, timeZone) {
  const d = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date);
  return { Sunday: 'วันอาทิตย์', Monday: 'วันจันทร์', Tuesday: 'วันอังคาร', Wednesday: 'วันพุธ', Thursday: 'วันพฤหัสบดี', Friday: 'วันศุกร์', Saturday: 'วันเสาร์' }[d] || d;
}
