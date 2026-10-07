/**
 * Everything that changes saved deadlines ("opportunities"): saving a new
 * announcement or folding it into the one already saved, planning alerts,
 * deleting with undo, marking as applied, and the per-chat alert schedule.
 *
 * Works on a tenant's services `svc` = { store, calendar, drive, tenant } so
 * it can be tested with in-memory fakes. Changes for one tenant run one at a
 * time: a poster and a message about the same call, handled at the same
 * moment, must not both decide "not saved yet".
 */
import { withLock } from './lock.js';
import {
  findDuplicate, mergeOpportunity, alertTimes, alertsFor, normalizeAlerts, normalizeDays, normalizeTime, sameSource, uniqueUrls,
} from './deadlines.js';
import { renderMarkdown } from './opportunities.js';

const locks = new Map();
const keyOf = (svc) => `opp:${svc.tenant?.id ?? ''}`;
const exclusive = (svc, fn) => withLock(locks, keyOf(svc), fn);

/** Bump when the alert planning changes, so saved deadlines are re-planned once. */
export const ALERTS_VERSION = 2;

const FIELDS = ['kind', 'organizer', 'summary', 'deadline_note', 'event_dates', 'eligibility', 'cost', 'link', 'contact'];

const validDate = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : '');

export async function alertSettings(svc) {
  return normalizeAlerts((await svc.store.settings()).deadlineAlerts);
}

export async function getOpportunity(svc, id) {
  const o = (await svc.store.opportunities()).find((x) => x.id === id);
  return o ? { ...o } : null;
}

// ------------------------------------------------------------------ alerts

function plannedAlerts(opp, settings, { timeZone, now }) {
  if (!opp.deadline || opp.status === 'applied') return [];
  return alertTimes(opp.deadline, alertsFor(opp, settings), timeZone, now).map((t) => ({
    userId: opp.userId,
    text: `${t.label}: ${opp.title}`,
    at: t.at,
    repeat: 'none',
    kind: 'deadline',
    offset: t.offset,
  }));
}

/** Re-plan alerts for `ids` (or every saved item). Caller holds the lock. */
async function reschedule(svc, { ids, timeZone, now }) {
  const settings = await alertSettings(svc);
  const list = await svc.store.opportunities();
  const targets = ids ? list.filter((o) => ids.includes(o.id)) : list;
  if (targets.length === 0) return new Map();
  const plan = new Map(targets.map((o) => [o.id, plannedAlerts(o, settings, { timeZone, now })]));
  const scheduled = await svc.store.replaceDeadlineAlerts(plan, now);
  await svc.store.update('opportunities.json', [], (all) => {
    for (const o of all) if (scheduled.has(o.id)) o.reminderIds = scheduled.get(o.id);
  });
  return scheduled;
}

export async function rescheduleAlerts(svc, { ids, timeZone, now = new Date() } = {}) {
  return exclusive(svc, () => reschedule(svc, { ids, timeZone, now }));
}

/**
 * Re-plan every saved deadline once after an upgrade (the old schedule was
 * only 3 days before + the last day). Returns true when it ran.
 */
const upToDate = new Set(); // tenants already checked by this process

export async function ensureAlertsUpToDate(svc, { timeZone, now = new Date() } = {}) {
  const key = keyOf(svc);
  if (upToDate.has(key)) return false;
  const s = await svc.store.settings();
  if (s.alertsVersion !== ALERTS_VERSION) {
    await exclusive(svc, () => reschedule(svc, { timeZone, now }));
    await svc.store.updateSettings({ alertsVersion: ALERTS_VERSION });
  }
  upToDate.add(key);
  return s.alertsVersion !== ALERTS_VERSION;
}

/**
 * Change when alerts go out. Without `oppId` it is the chat-wide schedule
 * (days and/or time); with `oppId` only that item's days change. `off`
 * switches alerts off, `reset` puts an item back on the chat-wide schedule.
 */
export async function setAlertSettings(svc, { days, time, off = false, reset = false, oppId } = {}, { timeZone, now = new Date() } = {}) {
  return exclusive(svc, async () => {
    const settings = await alertSettings(svc);
    // Missing or unusable values mean "leave as is", never "switch off".
    const newDays = days === undefined ? null : normalizeDays(days);
    const useDays = newDays && newDays.length ? newDays : null;
    if (oppId) {
      let opp;
      if (reset) opp = await svc.store.updateOpportunity(oppId, { alertDays: undefined });
      else if (off) opp = await svc.store.updateOpportunity(oppId, { alertDays: [] });
      else if (useDays) opp = await svc.store.updateOpportunity(oppId, { alertDays: useDays });
      else opp = await getOpportunity(svc, oppId);
      if (!opp) return null;
      await reschedule(svc, { ids: [oppId], timeZone, now });
      return { scope: 'item', opp: await getOpportunity(svc, oppId), alerts: alertsFor(opp, settings) };
    }
    const next = {
      days: off ? [] : (useDays || settings.days),
      time: normalizeTime(time) || settings.time,
    };
    await svc.store.updateSettings({ deadlineAlerts: next });
    await reschedule(svc, { timeZone, now });
    return { scope: 'all', alerts: normalizeAlerts(next) };
  });
}

// ---------------------------------------------------------------- calendar

const calendarTitle = (opp) => `⏳ Deadline: ${opp.title}`;

async function addCalendarEntry(svc, opp) {
  if (!svc.calendar || !opp.deadline) return;
  try {
    const ev = await svc.calendar.createEvent({
      title: calendarTitle(opp),
      start: opp.deadline,
      allDay: true,
      description: [opp.summary, opp.link || opp.source?.webViewLink].filter(Boolean).join('\n'),
    });
    if (ev?.id) await svc.store.updateOpportunity(opp.id, { calendarEventId: ev.id });
  } catch (err) {
    console.warn('calendar entry for deadline failed', err?.message || err);
  }
}

async function moveCalendarEntry(svc, opp) {
  if (!svc.calendar) return;
  if (!opp.calendarEventId) return addCalendarEntry(svc, opp);
  try {
    if (opp.deadline) await svc.calendar.moveAllDayEvent(opp.calendarEventId, opp.deadline);
    else await svc.calendar.deleteEvent(opp.calendarEventId);
  } catch (err) {
    console.warn('moving deadline calendar entry failed', err?.message || err);
  }
}

/** Remove the item's calendar entry; older items are found by date + title. */
async function removeCalendarEntry(svc, opp) {
  if (!svc.calendar || !opp.deadline) return;
  try {
    let id = opp.calendarEventId;
    if (!id && svc.calendar.findAllDay) [id] = await svc.calendar.findAllDay(opp.deadline, calendarTitle(opp));
    if (id) await svc.calendar.deleteEvent(id);
  } catch (err) {
    console.warn('removing deadline calendar entry failed', err?.message || err);
  }
}

// ------------------------------------------------------------------- saving

export async function refreshDoc(svc, { timeZone, now = new Date() } = {}) {
  try {
    await svc.drive?.writeRootText?.('Opportunities.md', renderMarkdown(await svc.store.opportunities(), timeZone, now));
  } catch (err) {
    console.warn('Opportunities.md refresh failed', err?.message || err);
  }
}

/** Caller holds the lock. */
async function createNew(svc, fields, { source, userId, timeZone, now }) {
  const record = {
    title: String(fields.title || '').trim() || 'ไม่มีชื่อ',
    deadline: validDate(fields.deadline),
    confidence: fields.confidence ?? 1,
    source,
    userId,
    reminderIds: [],
    createdAt: now.toISOString(),
  };
  for (const k of FIELDS) record[k] = String(fields[k] || '').trim();
  if (!record.kind) record.kind = 'other';
  if (source) record.sources = [source];
  const opp = await svc.store.addOpportunity(record);
  if (opp.deadline) {
    await reschedule(svc, { ids: [opp.id], timeZone, now });
    await addCalendarEntry(svc, opp);
  }
  return getOpportunity(svc, opp.id);
}

/**
 * Save an announcement read from a poster, page or message. When it is an
 * item already saved (the model said so, the same specific link, a near
 * identical title, or a close match sent minutes after the first), the new
 * details are folded into that item instead of adding a second one.
 *
 * Returns { opp, merged, reason, added, otherDeadline, before, incoming,
 * suggestion }: `before` / `incoming` let the caller undo a wrong merge;
 * `suggestion` is a saved item that looks related but was not merged.
 */
export async function registerOpportunity(svc, fields, { source, userId, timeZone, now = new Date(), forceNew = false } = {}) {
  return exclusive(svc, async () => {
    const incoming = { ...fields, title: String(fields.title || '').trim() || 'ไม่มีชื่อ', deadline: validDate(fields.deadline) };
    const list = await svc.store.opportunities();
    const found = forceNew
      ? { match: null, suggestion: null }
      : findDuplicate(list, incoming, { sameAs: fields.same_as, userId, timeZone, now, aiChecked: Boolean(fields.ai_checked) });

    if (found.match) {
      const existing = found.match.opp;
      const before = structuredClone(existing);
      const { patch, added, deadlineChanged, otherDeadline } = mergeOpportunity(existing, incoming, source, { now });
      await svc.store.updateOpportunity(existing.id, patch);
      let opp = await getOpportunity(svc, existing.id);
      if (deadlineChanged) {
        await reschedule(svc, { ids: [opp.id], timeZone, now });
        await moveCalendarEntry(svc, opp);
        opp = await getOpportunity(svc, opp.id);
      }
      await refreshDoc(svc, { timeZone, now });
      return {
        opp, merged: true, reason: found.match.reason, added, otherDeadline, deadlineChanged,
        before, incoming: { fields: stripMeta(incoming), source }, suggestion: null,
      };
    }

    const opp = await createNew(svc, incoming, { source, userId, timeZone, now });
    await refreshDoc(svc, { timeZone, now });
    const s = found.suggestion?.opp;
    return { opp, merged: false, added: [], suggestion: s ? { id: s.id, title: s.title } : null };
  });
}

function stripMeta(fields) {
  const { same_as: _s, ai_checked: _a, is_opportunity: _i, caption: _c, tags: _t, ...rest } = fields;
  return rest;
}

/**
 * Undo the last automatic merge: put the saved item back the way it was and
 * save the new reading as its own item.
 */
export async function splitMerge(svc, lastMerge, { userId, timeZone, now = new Date() } = {}) {
  if (!lastMerge?.before || !lastMerge?.incoming) return null;
  return exclusive(svc, async () => {
    const { before, incoming } = lastMerge;
    const current = await getOpportunity(svc, before.id);
    let restored = null;
    if (current) {
      // Keep what the user changed since (applied, own alert days, calendar id).
      const keep = { status: current.status, appliedAt: current.appliedAt, alertDays: current.alertDays, calendarEventId: current.calendarEventId };
      await svc.store.update('opportunities.json', [], (all) => {
        const i = all.findIndex((o) => o.id === before.id);
        if (i >= 0) {
          all[i] = { ...before, ...keep };
          for (const k of Object.keys(keep)) if (all[i][k] === undefined) delete all[i][k];
        }
      });
      restored = await getOpportunity(svc, before.id);
      if ((current.deadline || '') !== (before.deadline || '')) {
        await reschedule(svc, { ids: [before.id], timeZone, now });
        await moveCalendarEntry(svc, restored);
      }
    }
    const created = await createNew(svc, incoming.fields, { source: incoming.source, userId, timeZone, now });
    await refreshDoc(svc, { timeZone, now });
    return { restored, created };
  });
}

/**
 * The user says two saved items are the same: fold `srcId` into `targetId`
 * and remove `srcId`. Returns the same shape as a merge in registerOpportunity.
 */
export async function mergeInto(svc, targetId, srcId, { timeZone, now = new Date() } = {}) {
  if (!targetId || !srcId || targetId === srcId) return null;
  return exclusive(svc, async () => {
    const list = await svc.store.opportunities();
    const target = list.find((o) => o.id === targetId);
    const src = list.find((o) => o.id === srcId);
    if (!target || !src) return null;
    const before = structuredClone(target);
    const { patch, added, deadlineChanged, otherDeadline } = mergeOpportunity(target, src, src.source, { now });
    const sources = [...(patch.sources || target.sources || (target.source ? [target.source] : []))];
    for (const s of src.sources || (src.source ? [src.source] : [])) {
      if (!sources.some((x) => sameSource(x, s))) sources.push(s);
    }
    patch.sources = sources;
    const links = uniqueUrls([target.link, ...(target.links || []), src.link, ...(src.links || [])]);
    if (!target.link && links.length) patch.link = links[0];
    if (links.length > 1) patch.links = links;
    await svc.store.updateOpportunity(targetId, patch);
    await svc.store.removeOpportunity(srcId);
    await svc.store.removeAlertsFor(srcId);
    await removeCalendarEntry(svc, src);
    let opp = await getOpportunity(svc, targetId);
    if (deadlineChanged) {
      await reschedule(svc, { ids: [targetId], timeZone, now });
      await moveCalendarEntry(svc, opp);
      opp = await getOpportunity(svc, targetId);
    }
    await refreshDoc(svc, { timeZone, now });
    const { id: _id, createdAt: _c, reminderIds: _r, calendarEventId: _e, sources: _s, ...fields } = src;
    return {
      opp, merged: true, reason: 'user', added, otherDeadline, deadlineChanged,
      before, incoming: { fields, source: src.source },
    };
  });
}

// ----------------------------------------------------------- delete / undo

/** Delete an item with its alerts and calendar entry. Returns the removed record. */
export async function deleteOpportunity(svc, id, { timeZone, now = new Date() } = {}) {
  return exclusive(svc, async () => {
    const removed = await svc.store.removeOpportunity(id);
    if (!removed) return null;
    await svc.store.removeAlertsFor(id);
    await removeCalendarEntry(svc, removed);
    await refreshDoc(svc, { timeZone, now });
    return removed;
  });
}

/** Undo a delete: the same record comes back with fresh alerts and calendar entry. */
export async function restoreOpportunity(svc, snapshot, { timeZone, now = new Date() } = {}) {
  if (!snapshot?.id) return null;
  return exclusive(svc, async () => {
    const { calendarEventId: _e, reminderIds: _r, ...rest } = snapshot;
    const back = await svc.store.restoreOpportunity({ ...rest, reminderIds: [] });
    if (!back) return null;
    if (back.deadline) {
      await reschedule(svc, { ids: [back.id], timeZone, now });
      await addCalendarEntry(svc, back);
    }
    await refreshDoc(svc, { timeZone, now });
    return getOpportunity(svc, back.id);
  });
}

/** "Applied" stops the remaining alerts; un-applying plans them again. */
export async function setApplied(svc, id, applied, { timeZone, now = new Date() } = {}) {
  return exclusive(svc, async () => {
    const patch = applied ? { status: 'applied', appliedAt: now.toISOString() } : { status: undefined, appliedAt: undefined };
    const opp = await svc.store.updateOpportunity(id, patch);
    if (!opp) return null;
    await reschedule(svc, { ids: [id], timeZone, now });
    await refreshDoc(svc, { timeZone, now });
    return getOpportunity(svc, id);
  });
}

/** Items this user saved or updated in the last `withinMs` (for the chat hint). */
export async function recentOpportunities(svc, { userId, now = new Date(), withinMs = 30 * 60 * 1000 } = {}) {
  return (await svc.store.opportunities()).filter((o) => {
    const t = Date.parse(o.updatedAt || o.createdAt || '');
    return Number.isFinite(t) && now.getTime() - t <= withinMs && (!userId || !o.userId || o.userId === userId);
  });
}
