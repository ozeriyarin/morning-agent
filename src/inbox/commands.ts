import { join } from 'node:path';
import { addDays, dayMonth, todayIn } from '../dates.js';
import { loadRecords } from '../records.js';
import { list, ms, summarise, usd, type ReportSummary } from '../report/report.js';
import { FileConceptStore } from '../sources/concepts.js';
import { geocode, OpenMeteoSource, weatherAdvice, weatherSummary } from '../sources/weather.js';
import { escapeHtml } from '../write/template.js';

export interface Command {
  name: string;
  arg: string;
}

export interface CommandContext {
  root: string;
  timeZone: string;
  now: Date;
  fetchFn: typeof fetch;
}

const DEFAULT_COST_DAYS = 7;
const MAX_COST_DAYS = 90;
const MAX_ARG_CHARS = 80;

export const HELP_TEXT = [
  '<b>פקודות</b>',
  '/weather &lt;מקום&gt; - מזג האוויר היום במקום',
  `/cost [ימים] - עלות הריצות בימים האחרונים (ברירת מחדל ${DEFAULT_COST_DAYS})`,
  '/concept &lt;שם&gt; - הוספת מושג לתור',
  '/help - הרשימה הזו',
  'כל הודעה אחרת, או תגובה לבריף, נשמרת כמשוב. כן או לא עם חלק מכותרת של ידיעה מסמנים אותה.',
].join('\n');

// Null for plain text; "/Cost@my_bot 3" becomes { name: 'cost', arg: '3' }.
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head = '', ...rest] = trimmed.slice(1).split(/\s+/);
  return {
    name: head.replace(/@.*$/, '').toLowerCase(),
    arg: rest.join(' ').slice(0, MAX_ARG_CHARS).trim(),
  };
}

export function costMessage(totals: ReportSummary['totals'], days: number): string {
  const t = totals;
  const errors = t.errors ? ` (${escapeHtml(list(t.errorsBySource))})` : '';
  return [
    `<b>עלות ${days} הימים האחרונים</b>`,
    `ימים שרצו: ${t.daysRun}, נשלחו: ${t.daysDelivered}`,
    `פריטים: ${t.items.fetched} נאספו, ${t.items.inWindow} בחלון, ${t.items.decided} הוחלטו`,
    `עלות: ${usd(t.costUsd)} (ממוצע ${usd(t.meanCostPerDay)} ליום)`,
    `לפי תפקיד: החלטות ${usd(t.costByRole.decision)}, כתיבה ${usd(t.costByRole.writer)}`,
    `לפי מודל: ${Object.keys(t.costByModel).length ? escapeHtml(list(t.costByModel, usd)) : 'אין'}`,
    `זמן ממוצע: החלטות ${ms(t.meanLatencyMs.decision)}, כתיבה ${ms(t.meanLatencyMs.writer)}`,
    `יחס cache של הכותב: ${t.writerCacheHitRatio.toFixed(2)}`,
    `שגיאות: ${t.errors}${errors}`,
  ].join('\n');
}

// Names the failing service so a blocked host shows up on the phone instead of a generic error.
async function step<T>(service: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work().catch(() => work());
  } catch (error: unknown) {
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
    throw new Error(`שירות ${service} לא זמין כרגע${cause}`, { cause: error });
  }
}

async function weather(place: string, ctx: CommandContext): Promise<string> {
  const found = await step('המיקום (geocoding-api.open-meteo.com)', () => geocode(place, ctx.timeZone, ctx.fetchFn));
  if (!found) return `לא מצאתי מקום בשם "${escapeHtml(place)}"`;
  const date = todayIn(found.timezone, ctx.now);
  const day = await step('מזג האוויר (api.open-meteo.com)', () =>
    new OpenMeteoSource(found, ctx.fetchFn).fetch({ date, reference: ctx.now }),
  );
  const line = `${weatherSummary(day)} ${weatherAdvice(day)}`;
  return `<b>${escapeHtml(found.name)}</b>: ${escapeHtml(line)}`;
}

async function cost(days: number, ctx: CommandContext): Promise<string> {
  const today = todayIn(ctx.timeZone, ctx.now);
  const records = await loadRecords(join(ctx.root, 'runs'), addDays(today, 1 - days), today);
  return costMessage(summarise(records).totals, days);
}

async function concept(name: string, ctx: CommandContext): Promise<string> {
  const store = new FileConceptStore(join(ctx.root, 'concepts', 'queue.md'));
  const { added, entry, position } = await store.add(name);
  const quoted = `"${escapeHtml(entry.name)}"`;
  if (position === null)
    return `${quoted} כבר נלמד${entry.usedOn ? ` ב-${dayMonth(entry.usedOn)}` : ''}`;
  return added ? `נוסף לתור: ${quoted}, מקום ${position}` : `${quoted} כבר בתור, מקום ${position}`;
}

// Only these handlers run; anything else in a message is never executed.
export async function runCommand(command: Command, ctx: CommandContext): Promise<string> {
  const { name, arg } = command;
  if (name === 'weather' && arg) return weather(arg, ctx);
  if (name === 'concept' && arg) return concept(arg, ctx);
  if (name === 'cost') {
    const days = arg ? Number(arg) : DEFAULT_COST_DAYS;
    if (Number.isInteger(days) && days >= 1 && days <= MAX_COST_DAYS) return cost(days, ctx);
  }
  return HELP_TEXT;
}
