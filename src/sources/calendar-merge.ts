import type { CalendarEvent } from '../types.js';

export const byCalendarOrder = (a: CalendarEvent, b: CalendarEvent) =>
  Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start);

const eventKey = (e: CalendarEvent) =>
  `${e.title.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()}|${Math.floor(Date.parse(e.start) / 60_000)}`;

// An event in both calendars (same normalised title and start minute) keeps its Google copy.
export function mergeCalendars(google: CalendarEvent[], icloud: CalendarEvent[]): CalendarEvent[] {
  const merged = new Map<string, CalendarEvent>();
  for (const event of [...google, ...icloud]) {
    const key = eventKey(event);
    if (!merged.has(key)) merged.set(key, event);
  }
  return [...merged.values()].sort(byCalendarOrder);
}
