# JaiJa — final inspection brief for Claude Design

Prepared 7 October 2026. Codex's role is inspection and recommendations only. Claude Design owns design and prototype creation; Claude Code implements later. This handoff makes no application-code changes and authorizes no deployment or account actions.

## Inputs and status

Read this alongside abdul-browser-review-2026-10-07.md (including its extended matrix) and parnuan-reference-supplement.md. Evidence IDs below point to those observations. Repo README.md and assets/richmenu-src/README.md were read; they describe own-Drive storage, deadline workflows, groups and assets/mascot.jpg. These are repository-documented capabilities, not live-tested JaiJa behavior. The available Downloads/jaija_current_state.md corroborates persona and deadline defaults.

The seven cloud design documents/ZIP and original docs/claude-code-design-template.md, DESIGN.md, docs/jaija-review.md, docs/motion-design.md, docs/abdul-profile-reference.md and docs/parnuan-reference.md were not attached or available locally. Do not treat this brief as a merge of unread originals. It is a final inspection handoff, ready to reconcile with them while preserving newer local edits. All design instructions below are proposals/requirements for Claude Design, not claims about competitor implementations.

## Preserve JaiJa's identity and strengths

Use existing beige notebook surfaces, olive primary controls, warm ink text, subtle paper rules and JaiJa's current mascot. Reuse existing assets rather than redesigning the character. Keep Thai friend-plus-secretary tone: short, warm, precise, with English responses when appropriate. Avoid copying Abdul green/orange or Parnuan pink financial branding.

Own-Drive storage is a core promise: show where an item lives and how to open its original. Repo documents My Drive/LineArchive with daily folders, private data and a host-owned Groups folder. Do not equate this with Abdul's paid storage allotment. Deadline capture, duplicate merge/split recovery, applied/stop alerts, undo and configurable advance alerts deserve first-class space. Do not replace Deadline with a generic notes tab.

## Screen requirements

| Screen | Required design content and states | Evidence / priority |
| --- | --- | --- |
| Today / planner | Greeting + mascot, selected-date week strip, month overlay, Return to Today; upcoming reminders and deadline urgency; daily notebook panel with count and type filters. Loading, selected date empty and populated variants. | A02–A05/A19; P0 |
| Reminder list | Upcoming/recurring/unscheduled distinctions, category filters, chat example empty state, clear add action. Show next delivery and destination; do not silently add Calendar event. | A06/A09; P0 |
| Reminder editor | Title, optional note, category, date/time, one-time/repeat; daily, weekdays, monthly date/month-end, yearly. Summary before explicit save; next occurrence and Asia/Bangkok context. Inline validation, save pending/failure, cancel and unsaved edits. | A07–A09; P0 |
| Deadline list | Urgency date badge + text countdown, active first, applied/closed lower, filter/search, source attachments, alert schedule access. | JaiJa README, not observed Abdul feature; P0 |
| Deadline detail/review | Source poster/link/file, extracted fields with uncertain/missing values, deadline vs event date, duplicate candidate compare, Merge / Separate, applied/stop alerts, resume, delete/undo. | Repo strengths; P0 |
| Notebook / files | Recents and full list, Notes/Files/Photos, keyword search, date archive, personal/group source label, metadata and original Drive action. Empty search differs from empty archive; loading differs from zero results. | A10–A14; P0 |
| Note / file detail | Title/body or preview, saved date/source, own-Drive location, explicit save state, back, accessible share/download/delete actions with confirmation/undo appropriate to action. Expired gallery link and unavailable preview recovery. | A11/A13 + repo 24h link expiry; P0 |
| Settings / integrations | Drive connected owner/location/status, Calendar independently connected status, persona preview, deadline alert defaults/overrides, timezone, accessible account controls. Reconnect/disconnect explanation and pending/error states. | A15–A16; P0 |
| Group context | Host Drive ownership, personal vs group switch, recipients, host setup/unavailable states; permissions and explicit link-sharing warning. Do not render private personal data inside group results. | Repo group model; A18 only shows competitor affordances; P1 |
| Help / guided demo | One short text → poster/deadline → review → saved result walkthrough; task-specific help and recovery. | P01–P02/P06; P1 |

Navigation proposal: keep JaiJa's familiar แจ้งเตือน · Deadline · ไฟล์/รูป · ตั้งค่า rich-menu access. Put Today/planner at a clear entry point inside the companion UI. Claude Design should compare a four-item shell retaining Deadline versus a Today shell with a persistent Deadline shortcut; choose one consistent hierarchy and show it on all screens. Do not assume a new five-item shell is required.

## Interaction flows to show in the prototype

1. **Capture deadline:** send poster/link in LINE → processing state → review title/deadline/source with uncertainty → candidate duplicate comparison if relevant → save to own Drive → confirmation with view/change actions. Show Merge and Separate recovery. Never invent a missing deadline.
2. **Finish deadline:** list → detail → สมัครแล้ว หยุดเตือน → applied state with stopped alerts → เตือนต่อ undo/recovery. Preserve source and history.
3. **Schedule reminder:** list/add → manual or chat-derived draft → date/time/repeat → plain Thai summary and next occurrence → explicit save → list. Changing frequency retains valid inputs, surfaces incompatible selections, and never saves just by switching a chip.
4. **Calendar planning:** Today → another day/month → daily reminders/deadlines/files → Return to Today. Creating a reminder and creating a Calendar event are distinct explicit actions. Calendar disconnected state offers connection information and permits other tasks.
5. **Find an item:** notebook → date/type/search → result with timestamp/source → preview → เปิดใน Google Drive. Expired private gallery link offers re-entry via LINE; revoked Drive access offers reconnect without claiming data loss.
6. **Upload/retry:** choose/drop file → progress → metadata/extraction pending → success. Failure keeps selected intent; retry is duplicate-safe. Show extraction failure separately from successful original-file storage.
7. **Group use:** choose group → host identity/Drive explanation → group archive/reminders → action preview names recipients. Host permission loss shows read/write consequences. Sharing folder access requires a separate explicit action and explanation.

## Thai copy proposals

| Context | Copy |
| --- | --- |
| Today greeting | วันนี้ให้ JaiJa ช่วยอะไรดี? |
| No reminders on selected day | ยังไม่มีรายการเตือนสำหรับวันที่เลือก |
| Reminder onboarding | ลองพิมพ์ “พรุ่งนี้ 9 โมง เตือนส่งเอกสาร” ในแชตได้เลย |
| Date recovery | กลับไปวันนี้ |
| Recurrence summary | เตือนทุกวันจันทร์และพุธ เวลา 09:00 น. |
| Month end | วันสุดท้ายของทุกเดือน |
| Missing required input | ใส่เรื่องที่อยากให้เตือนก่อนนะ / เลือกวันและเวลาให้ครบก่อนนะ |
| Deadline uncertainty | ยังไม่แน่ใจวันปิดรับสมัคร ช่วยตรวจอีกนิดนะ |
| Possible duplicate | รายการนี้อาจเป็นเรื่องเดียวกัน รวมข้อมูลไหม? |
| Duplicate actions | รวมเป็นรายการเดียว / แยกเป็นรายการใหม่ |
| Applied state | สมัครแล้ว หยุดเตือน / เตือนต่อ |
| Undo deletion | ลบรายการแล้ว · เอาคืน |
| Own storage | เก็บใน Google Drive ของคุณ |
| Extraction pending | เก็บไฟล์แล้ว กำลังอ่านรายละเอียด |
| Extraction failure | เก็บไฟล์แล้ว แต่อ่านรายละเอียดไม่สำเร็จ ลองอีกครั้งหรือกรอกเองได้ |
| Empty search | ยังไม่เจอ ลองเปลี่ยนคำค้นหรือวันที่นะ |
| Network retry | โหลดไม่สำเร็จ ลองอีกครั้งได้ ข้อมูลเดิมยังอยู่ |
| Expired link | ลิงก์นี้หมดอายุแล้ว เปิดไฟล์/รูปจากเมนูใน LINE อีกครั้งนะ |
| Reconnect | เชื่อมต่อ Google Drive อีกครั้งเพื่อใช้งานต่อ |
| Group ownership | ไฟล์กลุ่มนี้เก็บใน Drive ของผู้ดูแลกลุ่ม |
| Sharing scope | ผู้ที่มีลิงก์อาจเปิดดูโฟลเดอร์นี้ได้ ตรวจสิทธิ์ก่อนแชร์นะ |

Use factual success text only after the relevant write is confirmed. Change copy for the selected date; never retain วันนี้ on tomorrow's empty state. Final dates and times must distinguish deadline date, event date, alert time and timezone. Show an explicit year where ambiguity matters; Thai Buddhist year may be displayed consistently while underlying scheduling remains correct.

## Motion recommendations — proposals, not competitor measurements

All competitor timings remain **unverified**. No measured values or numerical estimates were obtained. Use these as initial design targets only: selection feedback 120–180 ms; panel/menu expansion 180–240 ms; dialog fade/short movement 180–240 ms. Favor restrained ease-out; no bouncing critical forms. Measure the prototype itself later and label its results separately from Abdul/Parnuan evidence.

Keep headers/counts anchored while panels expand. Calendar/task dialog needs focus entry, focus containment, Escape/close and focus return. Animate only opacity/transform where practical and keep content readable throughout. Reduced motion removes travel, decorative looping and unnecessary shimmer; state changes remain immediate and clear. Mascot motion should acknowledge meaningful events sparingly, never delay saving or obscure countdowns. Do not replay AI processing animations after data has already loaded.

## Effort and operating-cost guidance

Prioritize deterministic date filters, counts, recurrence summaries, search and manual edits before generated insights. Existing API/data compatibility determines effort; S/M/L in the findings is relative, not a delivery commitment. Deadline OCR/caption/intent inference may use model calls; reuse stored results and avoid running AI on every screen open. Manual scheduling and alert-offset editing should not need AI. Every scheduled recurrence or deadline offset can add outbound notification usage; a default four-offset deadline schedule can plan up to four deliveries if all remain future/applicable, without asserting provider billing units. Applied/closed items cancel future alerts. Group destinations require explicit recipient/accounting decisions. No current vendor rates, free-tier assumptions or currency estimates are verified.

## Acceptance criteria for Claude Design handoff

- Design and prototype only; no account mutations, live sends, uploads, billing, deployment or production writes. Prototype uses fixtures and labels simulated outcomes.
- Beige notebook, olive accents and existing JaiJa mascot remain recognizable. Deadline and own-Drive strengths are visible in the primary flows.
- Each listed P0 screen has loading, empty/populated, failure and recovery variants where relevant; no false empty state while loading. Separate save failure from extraction failure.
- Every primary action has a clear destination, confirmation/result and return path. Failed operations preserve input and retries avoid duplicates. Draft changes do not save automatically.
- Date selection updates all sections/copy. Test month/year rollover, last day of short months, leap-day policy, missing timezone and past-time entry. Unsupported recurrence cases receive explicit explanatory states.
- Deadline merge/split, applied/resume and delete/undo are demonstrated without losing attachments or changing the wrong record. Global alert settings versus per-item overrides are distinguishable.
- Storage and group context show the actual owner/destination. Sharing scope is explicit; no public-share default inferred from opening a preview. Integration failure does not masquerade as empty archive.
- Thai labels wrap legibly at narrow widths; native date/time controls remain usable at 360/390 px. No horizontal page overflow; bottom navigation does not cover inputs/actions. Desktop companion layout also specified.
- Keyboard focus is visible; modal entry/return, labels, 44 px touch targets, contrast and non-color urgency cues are addressed. Reduced-motion variant included.
- Each borrowed idea traces to an evidence ID; all new recovery/interaction proposals are labeled. Public marketing claims are not represented as tested behavior. Unverified motion timing stays unverified.
- Deliver screen map, annotated screens, fixture-based interaction flows, component/state inventory, Thai copy, motion target sheet and open questions for Claude Code. Reconcile unread cloud originals when provided; do not silently overwrite them.

## Inspection gaps and merge status

Abdul: no existing reminders or groups to inspect saved-item execution/group administration. Calendar OAuth, trial/payment, share/delete/pin/upload submissions, delivery and induced error paths were not executed. Legal pages and duplicate private content were not inspected. Parnuan: public landing/features/pricing/FAQ and app loading/error/retry were observed; authenticated app stopped at LINE Login, so real budgets, receipt parsing, export and groups remain unverified. Education/careers/contact/terms are linked but unreviewed.

Original cloud design template/reference notes are unavailable, so direct merge is pending attachment. This brief and supplements are documentation artifacts, not fabricated replacements for those files. Existing application code and account settings remain unchanged.
