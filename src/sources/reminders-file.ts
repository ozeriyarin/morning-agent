import { join } from 'node:path';
import { z } from 'zod';
import { clockTime, isIsoDate, todayIn, zonedTime } from '../dates.js';
import type { FetchContext, Reminder, Source } from '../types.js';
import { instant, parseHandOff, readHandOff } from './calendar-file.js';
import { remindersOnDay } from './icloud-calendar.js';

export const remindersFileSchema = z.object({
  date: z.iso.date(),
  timezone: z.string(),
  source: z.string(),
  reminders: z.array(
    z.object({ title: z.string().trim().min(1), due: instant, allDay: z.boolean().optional() }),
  ),
});

// Today's reminders, all-day first then by time; an all-day `due` may also be a full datetime.
export function parseRemindersFile(raw: unknown, date: string, timeZone: string): Reminder[] {
  const reminders = parseHandOff(remindersFileSchema, raw, date, 'reminders').reminders.map(
    ({ title, due, allDay: sent }) => {
      const at = new Date(due);
      const allDay = sent ?? (isIsoDate(due) || isLocalMidnight(at, timeZone));
      return allDay
        ? { title, due: isIsoDate(due) ? due : todayIn(timeZone, at), allDay, time: null }
        : { title, due: at.toISOString(), allDay, time: clockTime(at, timeZone) };
    },
  );
  return remindersOnDay(reminders, date, timeZone);
}

function isLocalMidnight(at: Date, timeZone: string): boolean {
  return zonedTime(todayIn(timeZone, at), '00:00', timeZone).getTime() === at.getTime();
}

// Reads the reminders the routine copies from the Shortcut's mail before the run.
export class RemindersFileSource implements Source<Reminder[]> {
  readonly name = 'reminders-file';

  constructor(
    private readonly root: string,
    private readonly timeZone: string,
    private readonly path?: string,
  ) {}

  async fetch(ctx: FetchContext): Promise<Reminder[]> {
    const path = this.path ?? join(this.root, 'input', `reminders-${ctx.date}.json`);
    return parseRemindersFile(await readHandOff(path, 'reminders'), ctx.date, this.timeZone);
  }
}
