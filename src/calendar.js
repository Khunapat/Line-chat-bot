import { google } from 'googleapis';

/**
 * Google Calendar helper using the same OAuth client as Drive.
 * Requires the `calendar.events` scope on the refresh token
 * (`npm run get-token` requests it).
 */
export class Calendar {
  constructor(auth, { calendarId = 'primary', timeZone = 'UTC' } = {}) {
    this.api = google.calendar({ version: 'v3', auth });
    this.calendarId = calendarId;
    this.timeZone = timeZone;
  }

  /**
   * Create an event. `start`/`end` are ISO strings with offset. When `end`
   * is missing the event lasts one hour.
   */
  async createEvent({ title, start, end, description, location, allDay = false }) {
    let startField;
    let endField;
    if (allDay) {
      // `start` is YYYY-MM-DD; Google's all-day end date is exclusive.
      const next = new Date(start + 'T00:00:00Z');
      next.setUTCDate(next.getUTCDate() + 1);
      startField = { date: start };
      endField = { date: next.toISOString().slice(0, 10) };
    } else {
      const startDate = new Date(start);
      const endDate = end ? new Date(end) : new Date(startDate.getTime() + 60 * 60 * 1000);
      startField = { dateTime: startDate.toISOString(), timeZone: this.timeZone };
      endField = { dateTime: endDate.toISOString(), timeZone: this.timeZone };
    }
    const { data } = await this.api.events.insert({
      calendarId: this.calendarId,
      requestBody: {
        summary: title,
        description,
        location,
        start: startField,
        end: endField,
        reminders: { useDefault: true },
      },
    });
    return simplify(data);
  }

  /** Upcoming events in the next `days` days. */
  async listUpcoming({ days = 7, max = 15 } = {}) {
    const now = new Date();
    const until = new Date(now.getTime() + days * 86_400_000);
    const { data } = await this.api.events.list({
      calendarId: this.calendarId,
      timeMin: now.toISOString(),
      timeMax: until.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: max,
    });
    return (data.items || []).map(simplify);
  }
}

function simplify(e) {
  return {
    id: e.id,
    title: e.summary || '(ไม่มีชื่อ)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    allDay: !e.start?.dateTime,
    link: e.htmlLink,
    location: e.location,
  };
}

/** True when the error means the token lacks the calendar scope. */
export function isScopeError(err) {
  const code = err?.code || err?.response?.status;
  return code === 403 || /insufficient|scope/i.test(err?.message || '');
}
