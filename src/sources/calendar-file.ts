import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { clockTime } from '../dates.js';
import { SourceError, type CalendarEvent, type FetchContext, type Source } from '../types.js';
import { byCalendarOrder } from './calendar-merge.js';

export const instant = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'not a date');

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

export const eventTime = (start: string, end: string, allDay: boolean, timeZone: string) =>
  allDay ? null : `${clockTime(new Date(start), timeZone)}–${clockTime(new Date(end), timeZone)}`;

// Validates a routine hand-off file's shape and that it is for the run date.
export function parseHandOff<T extends { date: string }>(
  schema: z.ZodType<T>,
  raw: unknown,
  date: string,
  kind: string,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw invalid(`${kind} hand-off file has the wrong shape: ${issues.join('; ')}`);
  }
  if (parsed.data.date !== date) {
    throw invalid(`${kind} hand-off file is for ${parsed.data.date}, not ${date}`);
  }
  return parsed.data;
}

// Reads a routine hand-off file: `missing` when absent, `invalid` when it is not JSON.
export async function readHandOff(path: string, kind: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new SourceError('calendar', `${kind} hand-off file not found`, 'missing');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(`${kind} hand-off file is not valid JSON`);
  }
}

// All-day events first, then timed events by start; times rendered in the given zone.
export function parseCalendarFile(raw: unknown, date: string, timeZone: string): CalendarEvent[] {
  return parseHandOff(calendarFileSchema, raw, date, 'calendar')
    .events.map(({ title, start, end, allDay, location }) => ({
      title,
      start,
      end,
      allDay,
      ...(location && { location }),
      time: eventTime(start, end, allDay, timeZone),
      source: 'google' as const,
    }))
    .sort(byCalendarOrder);
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
    return parseCalendarFile(await readHandOff(path, 'calendar'), ctx.date, this.timeZone);
  }
}
