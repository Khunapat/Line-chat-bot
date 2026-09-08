import Anthropic from '@anthropic-ai/sdk';
import { localIsoWithOffset, REPEATS } from './reminders.js';

/**
 * The conversational layer. Claude decides what the user wants and calls the
 * matching tool (remember / recall / find file / reminder / calendar ...) or
 * just chats like a friend. Tool handlers are supplied by the server so this
 * module knows nothing about LINE.
 *
 * Returns { text, attachments } where attachments are LINE message objects
 * (Flex cards) the handlers want shown alongside the reply.
 */
export class Brain {
  constructor({ apiKey, model = 'claude-opus-5', effort = 'low', botName, userName, timeZone, handlers }) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.effort = effort;
    this.botName = botName;
    this.userName = userName;
    this.timeZone = timeZone;
    this.handlers = handlers;
    this.history = new Map(); // userId -> MessageParam[] (text only)
    this.system = buildSystemPrompt({ botName, userName, timeZone });
  }

  async chat({ userId, text, hint }) {
    const history = this.history.get(userId) || [];
    const now = new Date();
    const stamp = localIsoWithOffset(now, this.timeZone);
    const userTurn = `[เวลาตอนนี้ ${stamp} (${weekdayThai(now, this.timeZone)})]${hint ? `\n[บริบท: ${hint}]` : ''}\n${text}`;

    const messages = [...history, { role: 'user', content: userTurn }];
    const attachments = [];
    const ctx = { userId, now, attachments };

    let finalText = '';
    for (let i = 0; i < 6; i++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 2048,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: this.effort },
        system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
      });

      if (response.stop_reason === 'refusal') {
        finalText = 'ขอโทษนะ อันนี้ตอบให้ไม่ได้';
        break;
      }

      const textBlocks = response.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean);
      const toolUses = response.content.filter((b) => b.type === 'tool_use');

      if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
        finalText = textBlocks.join('\n');
        break;
      }

      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const tu of toolUses) {
        let result;
        try {
          const handler = this.handlers[tu.name];
          if (!handler) throw new Error(`unknown tool ${tu.name}`);
          result = await handler(tu.input, ctx);
        } catch (err) {
          console.error('tool failed', tu.name, err?.message || err);
          result = { error: String(err?.message || err) };
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: results });
    }

    // Persist a compact text-only history (drop tool blocks) for continuity.
    const next = [...history, { role: 'user', content: text }];
    if (finalText) next.push({ role: 'assistant', content: finalText });
    this.history.set(userId, next.slice(-12));

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
    description: 'ค้นหาไฟล์/รูป/วิดีโอที่เคยส่งมาเก็บไว้ใน Drive ด้วยชื่อหรือคำค้น ใช้เมื่อผู้ใช้ขอไฟล์ เช่น "ขอไฟล์ bookbank" "หารูปใบเสร็จ" ถ้าไม่ระบุคำค้นจะได้ไฟล์ล่าสุด',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'คำค้นชื่อไฟล์ (ภาษาเดิมของผู้ใช้) หรือค่าว่างเพื่อดูล่าสุด' } },
      required: ['query'],
      additionalProperties: false,
    },
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
- เก็บไฟล์และหาไฟล์ที่เคยส่งมา (find_file / name_last_file) - เมื่อเจอไฟล์ ระบบจะแนบการ์ดพร้อมปุ่ม "เปิดไฟล์" ให้เอง คุณแค่บอกสั้น ๆ ว่าเจอแล้วกดปุ่มด้านล่างได้เลย ไม่ต้องพิมพ์ลิงก์
- จดโน้ต/ลิงก์ลง Drive (save_note)
- ตั้งเตือน ดูเตือน ยกเลิก เปลี่ยนเวลา (set_reminder / list_reminders / cancel_reminder / reschedule_reminder) - ระบบแนบการ์ดยืนยันให้เอง คุณตอบยืนยันสั้น ๆ พร้อมเวลา เช่น "ได้เลย พรุ่งนี้ 10:15 น. เดี๋ยวเด้งเตือนให้"
- ลงนัด / ดูนัดใน Google Calendar (add_calendar_event / list_calendar)
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
