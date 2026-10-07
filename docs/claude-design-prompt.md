Create the complete visual design and coded interactive prototype for JaiJa,
my Thai LINE personal assistant.

Codex has handled inspection and recommendations. Your job is to design the
screens, components and motion, code the prototype, and prepare the handoff
for Claude Code to implement it in the real application.

ATTACHED FILES

Read these first:
1. claude-design-brief.md: the inspection brief and requirements.
2. abdul-browser-review-2026-10-07.md: the verified Abdul observations (IDs A01–A20).
3. parnuan-reference-supplement.md: the verified Parnuan observations (IDs P01–P07).
4. jaija-design-supplement.md: facts from JaiJa's current code. It covers the data model,
   existing actions and routes, LINE Flex and rich-menu limits, assets, voice, sample
   data, decisions already made, and which designs need new backend work.
   Where it describes current behaviour, treat it as the source of truth.

Assets:
5. mascot.jpg: my mascot. Keep its identity.
6. richmenu.png: the current rich menu.
7. Icons from assets/public/icons, all 21 hand-drawn PNGs plus the ph-* placeholders.
8. Bai Jamjuree font files with OFL.txt.

Optional:
9. jai_style_sample.txt: my own LINE messages, anonymised, for the voice.

If any of these is missing, tell me which one before you rely on it. Do not
pretend to have read a file you did not receive. The style sample is optional;
the core design can proceed without it.

PRODUCT DIRECTION

JaiJa's promise is:
"เก็บให้ หาเจอ เตือนทัน"

It saves files and links in each user's own Google Drive, remembers facts,
finds stored items, sets reminders, uses Google Calendar and tracks deadlines.

Preserve these strengths:
- Searchable files, captions/tags and calendar gallery.
- Memory and recall.
- One-time and recurring reminders.
- Deadline merging, configurable alerts, applied status and delete/undo.
- Personal and group storage with explicit Drive ownership.

INSPIRATION

Use the verified review documents as evidence, and cite their IDs.

From Abdul, adapt useful planner/calendar navigation, reminder categories,
progressive repeat controls, notes/files organisation, account/usage cards,
mascot speech previews and illustrated paper layouts.

From Parnuan, adapt its clear product promise, LINE conversation demonstrations,
mascot-led storytelling and simple explanation of how to start.

Keep observed features separate from proposed additions. Abdul's populated
reminder/group flows were unavailable, and Parnuan's authenticated app reached
LINE Login. Competitor motion timing remains unverified.

Do not copy competitor artwork, branding, pricing or unrelated features.

VISUAL IDENTITY

Keep JaiJa's beige notebook style:
- Paper: #F4EFE4
- Raised surface: #FBF8F1
- Quiet panel: #EFE8D8
- Dark outline/body text: #3B3B3B
- Secondary text: #686458
- Decorative olive: #8B9270, with dark text
- Primary action: #62694D, with white text
- Urgent date: #B5482F
- Soon date: #C98A2B, with dark text

Use Bai Jamjuree on web/export surfaces, hand-drawn icons, rounded outlined
cards and restrained shadows. Preserve my mascot's identity.

Critical information comes before illustration. Use clear Thai, readable dates,
two-line titles and one primary action per compact card.

SCREENS TO DESIGN AND CODE

1. LINE rich menu, exactly 2500×1686
   - Reminder-first hero: ตั้งเตือน, a smaller mascot and one short example.
   - Side shortcuts: สิ่งที่จำไว้ and แกลเลอรี.
   - Bottom tiles: แจ้งเตือน / Deadline / ไฟล์/รูป / ของฉัน (ของฉัน replaces ตั้งค่า; see the supplement, section 5).
   - Export editable HTML source, PNG and a non-overlapping tap-region/action map,
     using the existing action names where they exist.
   - The rich-menu image is static.

2. Mobile home/planner
   - Greeting, Drive status and upcoming reminders/deadlines.
   - Week picker, previous/next week and กลับวันนี้.
   - Month-calendar overlay that preserves the selected day and list context.
   - Clearly distinguish reminders, Calendar events and deadlines, not by colour alone.
   - Fixed navigation with sufficient bottom padding and safe-area clearance.

3. Reminder manager
   - Upcoming, recurring and completed categories.
   - Task → date/time → one-time or repeat.
   - Reveal repeat options progressively.
   - Confirmation, change-time, cancellation, fired reminder and snooze states.
   - Ambiguous dates/times require clarification.
   - Photo-to-reminder is a proposed draft-and-confirm flow, not silently
     scheduled extraction.
   - The supplement, section 2, lists which reminder fields exist today; mark
     the others Proposed.

4. Deadlines
   - List, detail, urgency/countdown and exact closing timestamp.
   - Applied/stop alerts and resume.
   - Merge explanation and split correction.
   - Single/batched alerts, alert schedule, delete and undo.
   - Keep additional actions reachable without crowding the card.
   - Date-only deadlines say ไม่ระบุเวลา; never invent a closing time.

5. Library
   - Files/photos, links and remembered facts.
   - Search, list/gallery/calendar views and item details.
   - Accurate filenames, saved dates and clear open actions.
   - Storage indicators only when their data and units are defined.
   - Distinct personal/group collection context.

6. ของฉัน
   - Compact identity, masked connected account and Drive destination.
   - Files, active reminders, open deadlines and memory counts.
   - Shared AI usage, honest limits and explicit reset timestamps (supplement, section 3).
   - Preferences, tone previews, reconnect/disconnect and help/privacy.
   - Keep collection counts separate from quotas and storage capacity.

7. Onboarding and recovery
   - Short fictional chat demos: save/retrieve a file, remember/recall a fact,
     and extract/confirm a deadline.
   - Empty, loading, failed-load, disconnected-Drive, expired-link,
     unauthorised, AI-unavailable and partial-success states.
   - A failed request must not become an empty collection or false success.

8. Chat cards (LINE Flex)
   - Redesign the key chat cards within the Flex limits in the supplement, section 6:
     saved file, reminder set, reminder fired, deadline saved/merged, deadline list,
     alert, and settings.
   - System font only, with no shadows or animation inside chat.

MOTION

Create a distinctive "ใจ๋วิ่งไปจัดให้" animation.
- Mini JaiJa carries a note past three olive dots while web work is pending.
- After success it places the note in a folder and shows a check.

Use it for web loading, searching and saving. Add a brief first-open wave and
small completion motions.

Provide idle, pending, success, failure, partial-success, long-wait and
reduced-motion variants. Stop stale animations when requests change or the
user navigates away. Keep status text readable independently of the animation.

Suggested timing is a starting design choice, not verified competitor timing:
- Loading reveal after roughly 400 ms.
- Running cycle around 2.4 seconds.
- Success settles in roughly 400–600 ms.
- Ordinary transitions around 120–180 ms.
- After prolonged waiting, switch to a truthful static status.

LINE's native three-dot indicator cannot be replaced with custom artwork.
Keep it in chat. The custom mascot animation belongs on web surfaces.
Do not send an extra animated waiting message on every chat turn.

VOICE AND ACCURACY

Use concise, friendly Thai resembling Jai: occasional อ่ออ, ลุย, จัด and
natural casual endings. Use laughter sparingly. Close-friend pronouns and
swearing are opt-in, not the default for other users or groups.

Dates, times, money, filenames and tool results remain exact. Serious errors
need clear explanations. Never claim an action succeeded before confirmation.

LANGUAGE OPTION

Provide a ไทย / English selector on first use and in ของฉัน → ภาษา / Language.
Default to Thai and remember each user's selection.

Apply it to:
- navigation, buttons, forms and cards;
- help and notifications;
- loading and error states;
- default bot replies.

Use concise, natural English alongside Jai-style Thai.

Keep filenames, names, saved facts, currency, timezones and schedules unchanged.
Use clear date formatting; English dates use Gregorian years.

Produce Thai and English rich-menu variants. Test every screen in both languages,
especially long English labels and Thai vowel marks.

PROTOTYPE AND IMPLEMENTATION BOUNDARY

Build the prototype with the fictional fixture data from the supplement
(section 10) and simulated asynchronous operations, including slow, failing and
partial outcomes. Clearly label proposed features and new backend requirements.

The real application uses Node.js, Express, LINE Messaging API, Google
Drive/Calendar and tenant-scoped JSON storage in each user's Drive. There is no
LIFF app yet. Native LINE Flex constraints differ from web CSS: custom fonts,
shadows and overlays are not available in chat.

Do not expose credentials or imply that prototype login or data is real.
Do not deploy, upload a rich menu, change a webhook, send messages or modify
live Drive/Calendar data.

DELIVERABLES

Produce:
- A coherent screen board and reusable components.
- A coded interactive prototype and preview instructions.
- Mobile layouts at 390 px and a tested 320 px variant, plus a desktop companion layout.
- Thai and English rich-menu PNGs, editable HTML source and an action map JSON
  ({ data, text, bounds: { x, y, width, height } } per area).
- Editable motion artwork/code, static fallbacks and a review preview.
- implementation-handoff.md for Claude Code. It must describe:
  - components and their states;
  - actions, routes and API fields, mapped to the existing actions and data in the supplement;
  - dependencies;
  - new backend work and a proposed implementation order.
- An acceptance checklist and a complete follow-up prompt for Claude Code.

Verify:
- Thai vowel marks and wrapping, and long names and filenames.
- Contrast, keyboard access, 44 px web touch targets and safe areas.
- Exact timestamps (including ไม่ระบุเวลา), month/year rollover and short months.
- Motion lifecycle and reduced motion.
- Both languages.

Start by reading the attached files. Then:
1. Say which attachments you received.
2. Summarise the chosen design direction and navigation choice in a few lines.
3. List the open questions you resolved by assumption.

Then proceed with the design and prototype.
