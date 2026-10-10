import type { Prices } from '../config.js';
import { priceCall, totalCost } from '../cost.js';
import { clockTime, dayMonth, hebrewWeekday, zonedTime } from '../dates.js';
import { mergeCalendars } from '../sources/calendar-merge.js';
import { dedupe, sortNewestFirst, withinWindow } from '../sources/feeds.js';
import type { ConceptStore } from '../sources/concepts.js';
import {
  SourceError,
  type Brief,
  type CalendarEvent,
  type CallRecord,
  type CallUsage,
  type DecisionModel,
  type DecisionResult,
  type Item,
  type RunError,
  type RunRecord,
  type Section,
  type Sender,
  type Source,
  type WeatherDay,
  type Writer,
  type WriterInput,
  type WrittenBrief,
} from '../types.js';
import {
  formatBrief,
  QUEUE_EMPTY_CONCEPT,
  templateBrief,
  visibleLength,
} from '../write/template.js';
import { validateBrief, WriterError } from '../write/writer.js';
import { redact } from './redact.js';

export const MAX_DECISIONS = 40;
const DECISION_CONCURRENCY = 5;

export interface RunDeps {
  weather: Source<WeatherDay>;
  calendar: Source<CalendarEvent[]>;
  icloud?: Source<CalendarEvent[]> | null;
  feeds: Source<Item[]>[];
  concepts: ConceptStore;
  decisionModel: DecisionModel;
  warnings?: string[];
  writer: Writer;
  sender: Sender;
  prices: Prices;
  secrets: string[];
  timeZone: string;
  localTime: string;
  now: () => Date;
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function decideAll(model: DecisionModel, items: Item[]): Promise<DecisionResult[]> {
  const results: DecisionResult[] = [];
  for (let i = 0; i < items.length; i += DECISION_CONCURRENCY) {
    const batch = items.slice(i, i + DECISION_CONCURRENCY).map((item) =>
      model.decide(item).catch((error: unknown): DecisionResult => ({
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
): Promise<{
  brief: WrittenBrief;
  mode: RunRecord['writer'];
  omitted: Section[];
  call?: CallUsage;
}> {
  try {
    const { brief, call } = await writer.write(input);
    const checked = validateBrief(brief);
    if (checked.ok) return { brief: checked.brief, mode: writer.mode, omitted: [], call };
    errors.push({ stage: 'writer', message: `writer output failed validation: ${checked.error}` });
    return { brief: templateBrief(input), mode: 'fallback', omitted: checked.missing, call };
  } catch (error) {
    errors.push({ stage: 'writer', message: message(error) });
    const call = error instanceof WriterError ? error.call : undefined;
    return { brief: templateBrief(input), mode: 'fallback', omitted: [], call };
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

  const [[weatherResult, conceptResult, calendarResult, icloudResult], feedResults] =
    await Promise.all([
      Promise.allSettled([
        deps.weather.fetch(ctx),
        deps.concepts.next(),
        deps.calendar.fetch(ctx),
        deps.icloud ? deps.icloud.fetch(ctx) : [],
      ] as const),
      Promise.allSettled(deps.feeds.map((feed) => feed.fetch(ctx))),
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
  const results = await decideAll(deps.decisionModel, toDecide);
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
    };
  });
  const pick = (d: string) => toDecide.filter((_, i) => results[i]?.decision === d);

  const input: WriterInput = {
    greeting: `בוקר טוב, יום ${hebrewWeekday(opts.date)} ${dayMonth(opts.date)}`,
    weather,
    mustRead: pick('must_read'),
    mention: pick('mention'),
    concept,
    calendar,
  };
  const written = await writeBrief(deps.writer, input, errors);
  for (const section of written.omitted) missing.add(section);

  const usages = [...results.map((r) => r.call), written.call].filter((c): c is CallUsage => !!c);
  const calls: CallRecord[] = usages.map((c) => priceCall(c, deps.prices));
  const total = totalCost(calls);
  const now = deps.now();
  const brief: Brief = {
    ...written.brief,
    calendar,
    icloudUnavailable: icloud === 'failed' && google !== null,
    greeting: input.greeting,
    news: keepKnownLinks(written.brief.news, toDecide),
    concept:
      concept === null && !missing.has('concept') ? QUEUE_EMPTY_CONCEPT : written.brief.concept,
    footer: `נוצר ב-${clockTime(now, deps.timeZone)} · ${items.length} פריטים נבדקו · עלות ~$${total.toFixed(3)}`,
  };
  const missingSections = [...missing];
  const html = formatBrief(brief, missingSections);

  let delivery: RunRecord['delivery']['status'] = 'failed';
  try {
    delivery = (await deps.sender.send(html)).status;
  } catch (error) {
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

  const record = redact<RunRecord>(
    {
      date: opts.date,
      generatedAt: now.toISOString(),
      dryRun: opts.dryRun,
      fetchedCount: fetched.length,
      items: items.map(({ title, link, published, sources }) => ({
        title,
        link,
        published,
        sources,
      })),
      calendar:
        calendar?.map(({ title, start, end, allDay, source }) => ({
          title,
          start,
          end,
          allDay,
          source,
        })) ?? null,
      icloud,
      skippedUnseen: items.length - toDecide.length,
      decisions,
      calls,
      totalCostUsd: total,
      writer: written.mode,
      missingSections,
      concept: { name: concept, queueEmpty: concept === null && !missing.has('concept'), marked },
      delivery: { sender: deps.sender.name, status: delivery },
      briefChars: visibleLength(html),
      errors,
      ...(deps.warnings?.length && { warnings: deps.warnings }),
    },
    deps.secrets,
  );
  await deps.writeRecord(record);
  return { html, record };
}
