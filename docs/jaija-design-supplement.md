# JaiJa design supplement: facts from the current code

Prepared 7 October 2026 from the repository at commit `541e05e`, for Claude Design.
Read it with `claude-design-brief.md`, `abdul-browser-review-2026-10-07.md` and
`parnuan-reference-supplement.md`.

The other documents say what to design. This one says **what JaiJa does today**,
taken from the source code. It also marks where a requested design needs **new
backend work**. Everything here describes the code, not competitor behaviour.
Where the prompt and this file disagree about the current behaviour, this file
is the fact and the prompt is the wish. Label such screens "Proposed".

## 1. Surfaces that exist today

| Surface | What it is now | Notes for design |
| --- | --- | --- |
| LINE chat | Text replies plus Flex Message cards. | Native LINE limits apply (section 6). |
| Rich menu | One static PNG, 2500×1686, with 8 tap rectangles. | The current layout is in section 5. |
| Web gallery `/gallery` | A month calendar of saved files, links and deadlines, with search. It opens from a signed link that expires after 24 hours. | This is the only web page today. It is not a LIFF page. |
| Connect page `/connect` | Google sign-in for friends who connect their own Drive. | Plain HTML result pages. |
| Static assets `/static/icons/*.png` | The hand-drawn icons, served for Flex cards. | |

**There is no LIFF app, web login, home/planner, reminder editor or profile page
yet.** Those screens are proposals. They need a LIFF app ID, which means a LINE
Login channel in the LINE Developers Console, and new authenticated API routes.

## 2. Data each user has (stored as JSON in their own Drive, `LineArchive/_data/`)

All times are stored in UTC and shown in `Asia/Bangkok`. Each person, or each
group, is a "tenant" with its own Drive folder. A group uses the host member's
Drive under `LineArchive/Groups/<group name>`.

**Reminder** (`reminders.json`)
```
{ id, userId, text, at: ISO UTC, repeat: "none" | "daily" | "weekly" | "monthly" | "yearly",
  firedAt?: ISO,            // one-off already sent; kept 24 h, then purged
  oppId?, kind?: "deadline", offset?: days-before   // deadline alerts only
}
```
How it behaves today:
- `weekly` repeats on the same weekday as the first time. There is no weekday picker.
- `monthly` repeats on the same date.
- There is **no** category, note, "weekdays only", month-end option, completed
  history, or unscheduled task.
- Completed one-offs disappear after 24 hours.
- Snooze is 10 or 60 minutes, and "done" removes the reminder.

All of those missing items are **new backend work** if you design them.

**Deadline** (`opportunities.json`)
```
{ id, title, kind: "competition" | "application" | "scholarship" | "course" | "event" | "other",
  organizer, summary, eligibility, cost, contact, event_dates (free text),
  deadline: "YYYY-MM-DD",          // DATE ONLY
  deadline_note: free text, e.g. "23:59" or "หรือจนกว่าจะเต็ม"   // not a parsed time
  link, links[], source { kind: "image"|"pdf"|"link"|"text", fileId?, webViewLink?, url? }, sources[],
  status?: "applied", appliedAt?, alertDays?: number[]  // per-item override; [] = no alerts
  reminderIds[], calendarEventId?, createdAt, updatedAt?, mergeCount? }
```
- **There is no closing time field.** If `deadline_note` holds a time, show it as
  the organiser's note. Otherwise show **ไม่ระบุเวลา**, and never invent one.
- Kinds in Thai: การแข่งขัน, รับสมัคร, ทุน, คอร์ส/อบรม, กิจกรรม, อื่น ๆ.

**Deadline alert settings** (`settings.json`)
```
{ deadlineAlerts: { days: [7,3,1,0], time: "09:00" }, alertsVersion: 2 }
```
- Presets: `std` [7,3,1,0], `early` [14,7,3,1,0], `light` [3,1,0].
- Times offered: 08:00, 12:00 and 20:00. Any HH:MM can be typed.
- `days: []` means alerts are off. Each item can override the days but not the time.
- Alerts due in the same minute go out as **one** LINE push, as a carousel.

**Memory item** (`memory.json`): `{ id, text, createdAt, userId }`. This is a
free-text fact. It has no title, category or pin today.

**File index** (`files.json`): `{ [driveFileId]: { name, day: "YYYY-MM-DD", caption, tags[], mimeType, webViewLink } }`
- The files themselves sit in `LineArchive/YYYY-MM-DD/` in the user's own Drive.
- Photos and PDFs get an AI caption and are renamed `HH-mm-ss_<caption>`.
- Video and audio are stored without a caption.

**Saved link** (`links.json`): `{ id, url, title (page title), host, day, at, caption, tags[] }`

**Per-chat state** (`state.json`): last file, a pending "change time" flow, the
last automatic merge (for split), and the last 5 deleted deadlines (for undo).

**Counts you can show truthfully:** files, links, memory items, active reminders,
open, applied and closed deadlines.

**What you cannot show without new work:**
- Storage used or capacity. JaiJa never reads Drive quota, so draw no storage bar
  unless it is labelled Proposed with a defined source.
- Per-category counts.
- A user nickname or tone setting, which does not exist yet.

## 3. AI usage, honest version

- The chat AI is Gemini on the free tier, with several models chained as fallbacks.
- JaiJa counts its own requests per model per day.
- A model's daily limit is only known after it first refuses, so show "ยังไม่รู้ลิมิต" until then.
- The counter resets at **midnight US Pacific time**: 14:00 Bangkok during US daylight
  time, 15:00 in winter. Show the exact reset time, for example "รีเซ็ต 14:00 น.".
- When every model is out, chat replies say AI is busy. Files are still saved;
  only reading them waits.
- The quota is shared by everyone using this bot. Usage counts are **not**
  storage capacity and **not** collection counts.

## 4. Actions that already exist (so prototype buttons map to real behaviour)

Postback actions the bot understands today:

| Area | Actions |
| --- | --- |
| Menu | `menu_reminders`, `menu_deadlines`, `menu_files`, `menu_gallery`, `menu_notes`, `menu_ai`, `menu_settings`, `menu_help` |
| Reminders | `list_reminders`, `snooze&min=10\|60&id=`, `done&id=`, `cancel&id=`, `reschedule&id=` (then the user types the new time) |
| Deadlines | `opp_list`, `opp_view&id=`, `opp_delete&id=`, `opp_restore&id=`, `opp_applied&id=`, `opp_unapplied&id=`, `opp_split&id=`, `opp_merge&id=&src=`, `scan&file=` |
| Alert schedule | `alerts_menu[&id=]`, `alerts_set&p=std\|early\|light[&id=]`, `alerts_time&t=HHMM`, `alerts_off[&id=]`, `alerts_reset&id=` |
| Account | `disconnect`, `group_host`, `group_share` |

The chat AI's tools: remember, recall, forget, save_note, find_file, search,
gallery_link, name_last_file, set_reminder, list_reminders, cancel_reminder,
reschedule_reminder, save_opportunity, list_opportunities, delete_opportunity,
mark_opportunity_applied, set_deadline_alerts, add_calendar_event, list_calendar.

Typed commands that need no AI: `เตือน deadline ก่อน 10 5 2 1 วัน 20:00`,
`ปิดเตือน deadline`, `หา <คำ>`, `ขอไฟล์ <ชื่อ>`, `เก็บไฟล์ <ชื่อ>`, `ช่วยจำ ...`.

HTTP routes today: `/webhook`, `/cron/reminders`, `/gallery`, `/api/gallery/month?m=`,
`/api/gallery/search?q=`, `/api/gallery/thumb/:id`, `/thumb/:tenant/:file`,
`/connect`, `/oauth/callback`, `/static/*`.

## 5. Current rich menu

The image is 2500×1686. Tap areas, as pixel rectangles:

| Area | Action | x, y, w, h |
| --- | --- | --- |
| Banner: mascot + "JaiJa เก็บให้ · จำให้ · เตือนให้" | `menu_help` | 60, 64, 2380, 739 (behind the three quick buttons) |
| สิ่งที่จำไว้ | `menu_notes` | 1782, 112, 580, 195 |
| แกลเลอรี | `menu_gallery` | 1782, 333, 580, 195 |
| โควตา AI | `menu_ai` | 1782, 554, 580, 195 |
| แจ้งเตือน | `menu_reminders` | 60, 883, 565, 723 |
| Deadline | `menu_deadlines` | 665, 883, 565, 723 |
| ไฟล์/รูป | `menu_files` | 1270, 883, 565, 723 |
| ตั้งค่า | `menu_settings` | 1875, 883, 565, 723 |

- The source is `assets/richmenu-src/richmenu.html`, rendered by `npm run richmenu-image`.
- That build also writes the tap map to `assets/richmenu-areas.json`, which the upload script reads.
- Your new design should keep this pipeline: HTML source → PNG + areas JSON.

**Your prompt's new layout:** a reminder-first hero; สิ่งที่จำไว้ and แกลเลอรี as side
shortcuts; bottom tiles แจ้งเตือน / Deadline / ไฟล์/รูป / ของฉัน.
- ของฉัน **replaces ตั้งค่า**, and the โควตา AI shortcut moves inside ของฉัน.
- In the action map, ของฉัน should open the LIFF profile page. Until LIFF exists,
  it opens `menu_settings` as a fallback.

LINE rich menu limits:
- PNG or JPEG, 1 MB at most, 2500×1686 or 2500×843.
- At most 20 tap areas, as plain rectangles.
- The image is static, and the chat-bar text is 14 characters at most.

Thai and English menus are **different images**. JaiJa would link a menu per user
through the API (link rich menu to user). That is **new backend work**.

## 6. LINE chat card limits (Flex Message), so chat designs are buildable

- System font only. Bai Jamjuree, shadows, blur, gradients, overlays and animation
  are not available inside chat cards.
- Rounded corners, borders, background colours, images and icons work.
- Card widths: mega is about 300 px, kilo about 260 px.
- At most 12 cards per carousel and 5 messages per reply.
- One card's JSON must stay under about 30 KB. The current deadline list caps at 10 rows.
- A button label is at most 20 characters. The text echoed in chat on a tap is at most 300.
- Images need public HTTPS URLs. Thumbnails come from `/thumb/...` and icons from `/static/icons/...`.
- **Loading indicator:** LINE's native three-dot animation, started by
  `POST /v2/bot/chat/loading/start`.
  - It works in one-to-one chats only and lasts 5 to 60 seconds.
  - It cannot be restyled.
  - It is **not called yet**, so this is new, small backend work.
  - The custom mascot animation belongs on web pages only.

Today's chat card style is a beige card on a dark #3B3B3B frame with rounded
outline buttons. Deadline cards use a coloured date badge: red within 3 days,
amber within 7, olive later, grey when closed. Each row has a ลบ pill.

## 7. Assets in the repo

| File | Notes |
| --- | --- |
| `assets/mascot.jpg` | 1024×1024. A cartoon of Jai: short dark hair, white shirt with a small book badge, cream circle background. Keep this identity. |
| `assets/richmenu.png` + `assets/richmenu-src/richmenu.html` | The current menu and its source. |
| `assets/richmenu-src/fonts/` | Bai Jamjuree Regular, Medium, SemiBold and Bold, with the OFL licence. |
| `assets/public/icons/*.png` | Hand-drawn 128 px icons with dark outlines and cream/olive fill: ai, audio, bell, calendar, check, clip, clock, doc, folder, gallery, group, link, note, pdf, pin, search, settings, target, trash, video, wave. There are also 480×360 placeholders `ph-*` for audio, clip, doc, link, note, pdf and video. |
| `assets/icons-src/icons.mjs` | The SVG source for those icons. New icons should follow it: 100×100 viewBox, 5 px dark stroke, round caps. |

## 8. Voice (from Jai's own messages; full sample in `jai_style_sample.txt` if attached)

**How Jai writes:**
- Very short. The median message is 8 characters.
- Common words: จริง, ใช่ ๆ, ลุย, จัด, ชิว, อ่ออ, หือ.
- Endings: อะ, ละ, นะ, ป่ะ, เลย, เว้ย. ครับ appears in work talk.
- He laughs with 5555 and uses the ☠️ emoji, both often.
- He stretches words (จริงงง) and rarely uses question marks.

**Rules for the bot:**
- Keep the warmth and brevity, and use laughter and emoji sparingly.
- Close-friend pronouns (กุ/มึง) and swearing are an opt-in tone for Jai only.
  The default for other users and for groups is polite-casual (เรา, นะ, ครับ when it fits).
- Dates, times, money, file names and tool results are always exact.
- A serious error gets a full, clear sentence.
- Never say something succeeded before it did.

**Current bot lines worth keeping or improving:**
- `จดไว้แล้ว`
- `งานนี้จดไว้แล้วนะ เลยรวมรายละเอียดใหม่ให้: ลิงก์, คุณสมบัติ`
- `ตอนนี้ AI ติดลิมิตชั่วคราว ลองใหม่อีกสักครู่นะ (ไฟล์ที่ส่งมายังเก็บเข้า Drive ให้ตามปกติ)`
- `วันนี้วันสุดท้าย!`
- `อีก 3 วัน`
- `ไม่ระบุวันปิดรับ`
- `สมัครแล้ว หยุดเตือน`
- `เอาคืน`

## 9. Language

There is no language setting today, and all replies are Thai with English
answered in English. A ไทย/English choice is **new work**:
- a per-user setting;
- translated cards and menus;
- two rich-menu images linked per user.

Formats to use:
- **Thai dates:** "พ. 7 ต.ค. 2569", with the Buddhist year shortened to 69 where space is tight.
- **English dates:** "Wed 7 Oct 2026".
- **Times:** 24-hour, "09:00 น." / "09:00".
- **Time zone:** Asia/Bangkok, shown when it matters.

## 10. Fixture data (fictional, today = Wednesday 7 October 2026, Bangkok)

Use these or similar for the prototype. All names and links are made up.

```json
{
  "user": { "displayName": "Jai", "drive": "j***@gmail.com", "folder": "LineArchive", "calendar": "connected" },
  "deadlines": [
    { "id": "d1", "title": "ทุนเรียนต่อ ป.โท ต่างประเทศ รุ่นที่ 12", "kind": "scholarship", "organizer": "มูลนิธิตัวอย่าง", "deadline": "2026-10-07", "deadline_note": "", "alerts": "std" },
    { "id": "d2", "title": "Youth Innovation Forum 2026", "kind": "application", "deadline": "2026-10-10", "deadline_note": "23:59", "link": "https://example.org/apply" },
    { "id": "d3", "title": "แข่งออกแบบวงจร Analog IC รอบคัดเลือก", "kind": "competition", "deadline": "2026-10-15", "source": "image" },
    { "id": "d4", "title": "คอร์สอบรม PCB Design to Comply EMC Requirement", "kind": "course", "deadline": "2026-10-21", "status": "applied" },
    { "id": "d5", "title": "Community Townhall", "kind": "event", "deadline": "2026-10-04" },
    { "id": "d6", "title": "Summer Research Fellowship (no date found)", "kind": "scholarship", "deadline": "" }
  ],
  "reminders": [
    { "id": "r1", "text": "กินยา", "at": "2026-10-07T12:00:00Z", "repeat": "daily" },
    { "id": "r2", "text": "ส่งเอกสารฝ่ายบุคคล", "at": "2026-10-08T03:15:00Z", "repeat": "none" },
    { "id": "r3", "text": "จ่ายค่าเน็ต", "at": "2026-10-25T02:00:00Z", "repeat": "monthly" }
  ],
  "calendar": [ { "title": "ประชุมทีม", "start": "2026-10-08T07:00:00Z", "end": "2026-10-08T08:00:00Z" } ],
  "files": [
    { "name": "10-21-05_ใบเสร็จร้านกาแฟ.jpg", "day": "2026-10-07", "caption": "ใบเสร็จร้านกาแฟ", "mime": "image/jpeg" },
    { "name": "bookbank.pdf", "day": "2026-10-03", "mime": "application/pdf", "size": 495970 },
    { "name": "ใบสมัครงาน_ฉบับแก้ไขครั้งที่สาม_สุดท้ายจริงๆ_v7.docx", "day": "2026-09-30", "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
  ],
  "links": [ { "title": "Apply | Youth Innovation Forum", "host": "example.org", "day": "2026-10-06" } ],
  "memories": [ { "text": "ที่จอดรถ ชั้น 3 ช่อง B12", "createdAt": "2026-10-05T10:00:00Z" } ],
  "aiUsage": { "models": [ { "model": "gemini-flash", "used": 14, "limit": 20 }, { "model": "gemini-flash-lite", "used": 3, "limit": null } ], "resetAt": "14:00 น." },
  "group": { "name": "กลุ่ม 5 ซิปๆ", "host": "Jai", "folder": "LineArchive/Groups/กลุ่ม 5 ซิปๆ" }
}
```

## 11. Decisions already made

- **Product promise:** "เก็บให้ หาเจอ เตือนทัน".
- **Bottom tiles:** แจ้งเตือน / Deadline / ไฟล์/รูป / ของฉัน. ตั้งค่า and โควตา AI move inside ของฉัน.
- **Palette:** the prompt's tokens. The primary action is now #62694D with white text,
  darker than today's #8B9270 for contrast. #8B9270 stays decorative.
- **Deadline defaults:** 7, 3 and 1 days before plus the deadline day, at 09:00.
  Applied items stop their alerts. Delete has undo for the last 5.
  Merge is automatic, with split as the correction.
- **Photo to reminder:** a draft the user confirms. It is never scheduled silently. This is new work.
- **Native LINE loading dots in chat:** one indicator per turn, with no extra
  "waiting" message. The custom animation is for web only.

## 12. New backend work implied by the design (label these "Proposed" in the prototype)

| Item | Size |
| --- | --- |
| LIFF app + authenticated API: `/app/*` pages; `/api/me`, `/api/reminders`, `/api/deadlines`, `/api/library`, `/api/settings` | L |
| Reminder category, note, weekday set, month-end, completed history, unscheduled tasks | M–L |
| Deadline closing time as a structured field (optional) | S–M |
| Language setting, translated strings, per-user rich menu | M |
| Tone setting (polite-casual / close-friend) with preview | S |
| Photo-to-reminder draft and confirm | M |
| Native chat loading indicator call | S |
| Storage usage from Drive quota, only if wanted | M |
