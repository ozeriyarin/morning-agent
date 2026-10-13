import type { Prices } from '../config.js';
import { priceCall, totalCost } from '../cost.js';
import { addDays, clockTime, dayMonth, hebrewWeekday, isSunday, zonedTime } from '../dates.js';
import { TelegramError } from '../deliver/telegram.js';
import type { StoredRecord } from '../records.js';
import { summarise } from '../report/report.js';
import { mergeCalendars } from '../sources/calendar-merge.js';
import { dedupe, sortNewestFirst, withinWindow } from '../sources/feeds.js';
import type { ConceptStore } from '../sources/concepts.js';
import type { InterviewStore } from '../sources/interview.js';
import type { MemorySource, Recall } from '../retrieve/memory.js';
import {
  SourceError,
  type Brief,
  type CalendarEvent,
  type CallRecord,
  type CallUsage,
  type DecisionExample,
  type DecisionModel,
  type DecisionResult,
  type FetchContext,
  type InterviewPick,
  type Item,
  type NewsItem,
  type Reminder,
  type RunError,
  type RunRecord,
  type Section,
  type Sender,
  type Source,
  type WeatherDay,
  type WeeklySummary,
  type Writer,
  type WriterInput,
} from '../types.js';
import { ChainWriter, type ChainResult } from '../write/chain.js';
import { formatBrief, QUEUE_EMPTY_CONCEPT, visibleLength } from '../write/template.js';
import { redact } from './redact.js';

export const MAX_DECISIONS = 40;
export const RECORD_SUMMARY_CHARS = 400;
const DECISION_CONCURRENCY = 5;

export interface RunDeps {
  weather: Source<WeatherDay>;
  calendar: Source<CalendarEvent[]>;
  icloud?: Source<CalendarEvent[]> | null;
  reminders?: Source<Reminder[]> | null;
  remindersFile?: Source<Reminder[]> | null;
  feeds: Source<Item[]>[];
  concepts: ConceptStore;
  interview: InterviewStore;
  decisionModel: DecisionModel;
  memory?: MemorySource | null;
  warnings?: string[];
  writer: Writer;
  sender: Sender;
  prices: Prices;
  secrets: string[];
  timeZone: string;
  localTime: string;
  now: () => Date;
  history: (from: string, to: string) => Promise<StoredRecord[]>;
  writeRecord: (record: RunRecord) => Promise<void>;
}

export interface RunOptions {
  date: string;
  dryRun: boolean;
}

export interface RunOutcome {
  html: string;
  record: RunRecord;
}

// Keeps the underlying cause (e.g. a proxy connect timeout) so records say why a fetch failed.
const message = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  return `${error.message}${cause}`;
};

export async function decideAll(
  model: DecisionModel,
  items: Item[],
  examples: DecisionExample[][] = [],
): Promise<DecisionResult[]> {
  const results: DecisionResult[] = [];
  for (let i = 0; i < items.length; i += DECISION_CONCURRENCY) {
    const batch = items.slice(i, i + DECISION_CONCURRENCY).map((item, j) =>
      model.decide(item, examples[i + j]).catch((error: unknown): DecisionResult => ({
        decision: 'skip',
        error: `decision call failed: ${message(error)}`,
      })),
    );
    results.push(...(await Promise.all(batch)));
  }
  return results;
}

async function writeBrief(
  writer: Writer,
  input: WriterInput,
  errors: RunError[],
): Promise<ChainResult> {
  const chain = writer instanceof ChainWriter ? writer : new ChainWriter([writer]);
  const result = await chain.write(input);
  for (const { model, error } of result.failures)
    errors.push({ stage: 'writer', message: `writer ${model} failed: ${message(error)}` });
  return result;
}

interface RemindersOutcome {
  reminders: Reminder[];
  source: RunRecord['reminders']['source'];
  fileError?: unknown;
  icloudError?: unknown;
}

// The hand-off file wins; iCloud is asked only when the file is missing or invalid.
async function fetchReminders(deps: RunDeps, ctx: FetchContext): Promise<RemindersOutcome> {
  let fileError: unknown;
  if (deps.remindersFile) {
    try {
      return { reminders: await deps.remindersFile.fetch(ctx), source: 'file' };
    } catch (error) {
      if (!(error instanceof SourceError && error.reason === 'missing')) fileError = error;
    }
  }
  if (!deps.reminders) return { reminders: [], source: 'none', fileError };
  try {
    return { reminders: await deps.reminders.fetch(ctx), source: 'icloud', fileError };
  } catch (icloudError) {
    return { reminders: [], source: 'none', fileError, icloudError };
  }
}

// Sunday footer: the 7 days before the run date; a day without a record counts as not run.
async function weeklySummary(
  deps: RunDeps,
  date: string,
  errors: RunError[],
): Promise<WeeklySummary | undefined> {
  try {
    const { totals } = summarise(await deps.history(addDays(date, -7), addDays(date, -1)));
    return {
      days: totals.daysRun,
      costUsd: totals.costUsd,
      items: totals.items.inWindow,
      errors: totals.errors,
    };
  } catch (error) {
    errors.push({ stage: 'source', source: 'weekly', message: message(error) });
    return undefined;
  }
}

// Guardrail: the writer may only link to items that were actually fetched and kept.
function keepKnownLinks(news: Brief['news'], kept: Item[]): Brief['news'] {
  const known = new Set(kept.map((item) => item.link));
  const mustRead = news.mustRead.filter((n) => known.has(n.url));
  const mention = news.mention.filter((n) => known.has(n.url));
  return { mustRead, mention, quietDay: news.quietDay || mustRead.length + mention.length === 0 };
}

export async function runBrief(deps: RunDeps, opts: RunOptions): Promise<RunOutcome> {
  const errors: RunError[] = [];
  const missing = new Set<Section>();
  const reference = zonedTime(opts.date, deps.localTime, deps.timeZone);
  const ctx = { date: opts.date, reference };

  const [
    [weatherResult, conceptResult, calendarResult, icloudResult, interviewResult],
    feedResults,
    remindersOutcome,
  ] = await Promise.all([
    Promise.allSettled([
      deps.weather.fetch(ctx).catch(() => deps.weather.fetch(ctx)),
      deps.concepts.next(),
      deps.calendar.fetch(ctx),
      deps.icloud ? deps.icloud.fetch(ctx) : [],
      deps.interview.next(),
    ] as const),
    Promise.allSettled(deps.feeds.map((feed) => feed.fetch(ctx))),
    fetchReminders(deps, ctx),
  ]);

  let weather: WeatherDay | null = null;
  if (weatherResult.status === 'fulfilled') weather = weatherResult.value;
  else {
    missing.add('weather');
    errors.push({
      stage: 'source',
      source: deps.weather.name,
      message: message(weatherResult.reason),
    });
  }

  let google: CalendarEvent[] | null = null;
  if (calendarResult.status === 'fulfilled') google = calendarResult.value;
  else {
    const reason = calendarResult.reason;
    errors.push({
      stage: 'source',
      source: deps.calendar.name,
      ...(reason instanceof SourceError && reason.reason && { reason: reason.reason }),
      message: message(reason),
    });
  }

  let icloud: RunRecord['icloud'] = deps.icloud ? 'ok' : 'disabled';
  if (icloudResult.status === 'rejected') {
    icloud = 'failed';
    errors.push({
      stage: 'source',
      source: 'calendar',
      reason: 'icloud',
      message: message(icloudResult.reason),
    });
  }
  const { reminders, fileError, icloudError } = remindersOutcome;
  // One reminders error at most: the file's, else iCloud's unless discovery already failed.
  if (fileError !== undefined)
    errors.push({
      stage: 'source',
      source: 'calendar',
      reason: 'reminders-file',
      message: message(fileError),
    });
  else if (icloudError !== undefined && icloud !== 'failed')
    errors.push({
      stage: 'source',
      source: 'calendar',
      reason: 'icloud-reminders',
      message: message(icloudError),
    });
  const icloudEvents = icloudResult.status === 'fulfilled' ? icloudResult.value : [];
  const calendar =
    google === null && icloud !== 'ok' ? null : mergeCalendars(google ?? [], icloudEvents);
  if (calendar === null) missing.add('calendar');

  let concept: string | null = null;
  if (conceptResult.status === 'fulfilled') concept = conceptResult.value;
  else {
    missing.add('concept');
    errors.push({ stage: 'concepts', message: message(conceptResult.reason) });
  }

  let interview: InterviewPick = { problem: null, tip: null };
  if (interviewResult.status === 'fulfilled') interview = interviewResult.value;
  else {
    missing.add('interview');
    errors.push({ stage: 'interview', message: message(interviewResult.reason) });
  }

  const fetched: Item[] = [];
  feedResults.forEach((result, i) => {
    if (result.status === 'fulfilled') fetched.push(...result.value);
    else
      errors.push({
        stage: 'source',
        source: deps.feeds[i]?.name,
        message: message(result.reason),
      });
  });
  if (deps.feeds.length > 0 && feedResults.every((r) => r.status === 'rejected'))
    missing.add('news');

  const items = sortNewestFirst(dedupe(withinWindow(fetched, reference)));
  const toDecide = items.slice(0, MAX_DECISIONS);
  let recall: Recall | null = null;
  if (deps.memory) {
    try {
      recall = await deps.memory.recall(opts.date, toDecide, concept);
    } catch (error) {
      errors.push({ stage: 'source', source: 'memory', message: message(error) });
    }
  }
  const examples = toDecide.map((item) => recall?.examples.get(item.id) ?? []);
  const results = await decideAll(deps.decisionModel, toDecide, examples);
  const decisions = toDecide.map((item, i) => {
    const r = results[i] ?? { decision: 'skip' as const, error: 'no decision' };
    if (r.error) errors.push({ stage: 'decision', source: item.title, message: r.error });
    return {
      title: item.title,
      link: item.link,
      decision: r.decision,
      model: r.call?.model ?? deps.decisionModel.model,
      ...(r.confidence !== undefined && { confidence: r.confidence }),
      ...(r.probabilities && { probabilities: r.probabilities }),
      ...(r.error && { error: r.error }),
      examples: examples[i]?.length ?? 0,
    };
  });
  const pick = (d: string) =>
    toDecide
      .filter((_, i) => results[i]?.decision === d)
      .map((item): NewsItem => {
        const seen = recall?.seenBefore.get(item.id);
        return seen ? { ...item, seenBefore: { title: seen.title, date: seen.date } } : item;
      });

  const input: WriterInput = {
    greeting: `בוקר טוב, יום ${hebrewWeekday(opts.date)} ${dayMonth(opts.date)}`,
    weather,
    mustRead: pick('must_read'),
    mention: pick('mention'),
    concept:
      concept === null
        ? null
        : { name: concept, related: recall?.relatedConcepts.map((c) => c.name) ?? [] },
    calendar,
    interview,
  };
  const written = await writeBrief(deps.writer, input, errors);
  for (const section of written.omitted) missing.add(section);

  const usages = [...(recall?.calls ?? []), ...results.map((r) => r.call), ...written.calls].filter(
    (c): c is CallUsage => !!c,
  );
  const calls: CallRecord[] = usages.map((c) => priceCall(c, deps.prices));
  const total = totalCost(calls);
  const now = deps.now();
  const weekly = isSunday(opts.date) ? await weeklySummary(deps, opts.date, errors) : undefined;
  const brief: Brief = {
    ...written.brief,
    calendar,
    icloudUnavailable: icloud === 'failed' && google !== null,
    reminders,
    greeting: input.greeting,
    news: keepKnownLinks(written.brief.news, toDecide),
    concept:
      concept === null && !missing.has('concept') ? QUEUE_EMPTY_CONCEPT : written.brief.concept,
    footer: `נוצר ב-${clockTime(now, deps.timeZone)} · ${items.length} פריטים נבדקו · עלות ~$${total.toFixed(3)}`,
    weekly,
    interviewPick: interview,
    interviewExplained: written.writer !== 'template',
  };
  const missingSections = [...missing];
  const html = formatBrief(brief, missingSections);

  let delivery: RunRecord['delivery']['status'] = 'failed';
  let attempts = 1;
  try {
    ({ status: delivery, attempts } = await deps.sender.send(html));
  } catch (error) {
    if (error instanceof TelegramError) attempts = error.attempts;
    errors.push({ stage: 'delivery', message: message(error) });
  }

  let marked = false;
  if (concept && !opts.dryRun && delivery === 'sent') {
    try {
      await deps.concepts.markUsed(concept, opts.date);
      marked = true;
    } catch (error) {
      errors.push({ stage: 'concepts', message: message(error) });
    }
  }

  let interviewMarked = false;
  if ((interview.problem || interview.tip) && !opts.dryRun && delivery === 'sent') {
    try {
      await deps.interview.markUsed(interview, opts.date);
      interviewMarked = true;
    } catch (error) {
      errors.push({ stage: 'interview', message: message(error) });
    }
  }

  const record = redact<RunRecord>(
    {
      date: opts.date,
      generatedAt: now.toISOString(),
      dryRun: opts.dryRun,
      fetchedCount: fetched.length,
      items: items.map(({ title, link, published, summary, sources }) => ({
        title,
        link,
        published,
        summary: summary.slice(0, RECORD_SUMMARY_CHARS),
        sources,
      })),
      calendar: calendar && {
        count: calendar.length,
        allDay: calendar.filter((e) => e.allDay).length,
        timed: calendar.filter((e) => !e.allDay).length,
        bySource: {
          google: calendar.filter((e) => e.source === 'google').length,
          icloud: calendar.filter((e) => e.source === 'icloud').length,
        },
      },
      icloud,
      reminders: { count: reminders.length, source: remindersOutcome.source },
      skippedUnseen: items.length - toDecide.length,
      decisions,
      calls,
      totalCostUsd: total,
      writer: written.writer,
      writerAttempts: written.attempts,
      missingSections,
      concept: { name: concept, queueEmpty: concept === null && !missing.has('concept'), marked },
      interview: {
        slug: interview.problem?.slug ?? null,
        tipIndex: interview.tip?.index ?? null,
        marked: interviewMarked,
      },
      memory: recall && {
        indexSize: recall.indexSize,
        seenBefore: recall.seenBefore.size,
        examples: examples.reduce((n, e) => n + e.length, 0),
        related: recall.relatedConcepts.length,
        chunkIds: recall.chunkIds,
      },
      delivery: { sender: deps.sender.name, status: delivery, attempts },
      briefChars: visibleLength(html),
      errors,
      ...(deps.warnings?.length && { warnings: deps.warnings }),
    },
    deps.secrets,
  );
  await deps.writeRecord(record);
  return { html, record };
}
