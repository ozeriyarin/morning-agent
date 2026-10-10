import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { clockTime } from '../dates.js';
import { SourceError, type CalendarEvent, type FetchContext, type Source } from '../types.js';

const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'not a date');

export const calendarFileSchema = z.object({
  date: z.iso.date(),
  timezone: z.string(),
  source: z.string(),
  events: z.array(
    z.object({
      title: z.string().trim().min(1),
      start: instant,
      end: instant,
      allDay: z.boolean(),
      location: z.string().trim().optional(),
    }),
  ),
});

const invalid = (message: string) => new SourceError('calendar', message, 'invalid');

// All-day events first, then timed events by start; times rendered in the given zone.
export function parseCalendarFile(raw: unknown, date: string, timeZone: string): CalendarEvent[] {
  const parsed = calendarFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw invalid(`calendar hand-off file has the wrong shape: ${issues.join('; ')}`);
  }
  if (parsed.data.date !== date) {
    throw invalid(`calendar hand-off file is for ${parsed.data.date}, not ${date}`);
  }
  return parsed.data.events
    .map(({ title, start, end, allDay, location }) => ({
      title,
      start,
      end,
      allDay,
      ...(location && { location }),
      time: allDay
        ? null
        : `${clockTime(new Date(start), timeZone)}–${clockTime(new Date(end), timeZone)}`,
    }))
    .sort(
      (a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start),
    );
}

// Reads the file the cloud routine writes from the Google Calendar connector before the run.
export class CalendarFileSource implements Source<CalendarEvent[]> {
  readonly name = 'calendar';

  constructor(
    private readonly root: string,
    private readonly timeZone: string,
    private readonly path?: string,
  ) {}

  async fetch(ctx: FetchContext): Promise<CalendarEvent[]> {
    const path = this.path ?? join(this.root, 'input', `calendar-${ctx.date}.json`);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw new SourceError('calendar', 'calendar hand-off file not found', 'missing');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw invalid('calendar hand-off file is not valid JSON');
    }
    return parseCalendarFile(raw, ctx.date, this.timeZone);
  }
}
