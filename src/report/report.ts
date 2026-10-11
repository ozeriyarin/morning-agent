import type { StoredCall, StoredRecord } from '../records.js';
import { redact } from '../run/redact.js';
import { DECISIONS, type CallRecord, type Decision, type WriterName } from '../types.js';

type Role = CallRecord['role'];
const ROLES: Role[] = ['decision', 'writer'];
const WRITERS: WriterName[] = ['sonnet', 'haiku', 'template'];
// Records before v10 said `ai` for Sonnet and `fallback` for the template after a failure.
const WRITER_OF: Record<NonNullable<StoredRecord['writer']>, WriterName> = {
  sonnet: 'sonnet',
  haiku: 'haiku',
  template: 'template',
  ai: 'sonnet',
  fallback: 'template',
};

export interface RoleStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  meanLatencyMs: number;
}

export interface DaySummary {
  date: string;
  delivery: 'sent' | 'printed' | 'failed' | null;
  items: { fetched: number | null; inWindow: number; decided: number };
  decisions: Record<Decision, number>;
  calls: Record<Role, RoleStats>;
  costUsd: number;
  errors: { source: string; reason?: string }[];
  calendarEvents: number | null;
  icloud: 'ok' | 'disabled' | 'failed' | null;
  concept: string | null;
  writer: WriterName | null;
}

export interface ReportSummary {
  days: DaySummary[];
  totals: {
    daysRun: number;
    daysDelivered: number;
    items: { fetched: number; inWindow: number; decided: number };
    costUsd: number;
    costByRole: Record<Role, number>;
    costByModel: Record<string, number>;
    meanCostPerDay: number;
    meanLatencyMs: Record<Role, number>;
    errors: number;
    errorsBySource: Record<string, number>;
    writerCacheHitRatio: number;
    briefsByWriter: Record<WriterName, number>;
  };
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const mean = (values: number[]) => (values.length ? sum(values) / values.length : 0);

function roleStats(calls: StoredCall[]): RoleStats {
  return {
    calls: calls.length,
    inputTokens: sum(calls.map((c) => c.inputTokens)),
    outputTokens: sum(calls.map((c) => c.outputTokens)),
    cacheReadTokens: sum(calls.map((c) => c.cacheReadTokens)),
    costUsd: sum(calls.map((c) => c.costUsd)),
    meanLatencyMs: mean(calls.map((c) => c.latencyMs)),
  };
}

const byRole = <T>(calls: StoredCall[], f: (calls: StoredCall[]) => T) =>
  Object.fromEntries(
    ROLES.map((role) => [role, f(calls.filter((c) => c.role === role))]),
  ) as Record<Role, T>;

// Decision errors carry the item title as source, so they are grouped under the stage instead.
const errorSource = (e: StoredRecord['errors'][number]) =>
  e.stage === 'decision' ? 'decision' : (e.source ?? e.stage);

function summariseDay(r: StoredRecord): DaySummary {
  return {
    date: r.date,
    delivery: r.delivery?.status ?? null,
    items: {
      fetched: r.fetchedCount ?? null,
      inWindow: r.items.length,
      decided: r.decisions.length,
    },
    decisions: Object.fromEntries(
      DECISIONS.map((d) => [d, r.decisions.filter((x) => x.decision === d).length]),
    ) as Record<Decision, number>,
    calls: byRole(r.calls, roleStats),
    costUsd: sum(r.calls.map((c) => c.costUsd)),
    errors: r.errors.map((e) => ({
      source: errorSource(e),
      ...(e.reason && { reason: e.reason }),
    })),
    calendarEvents: Array.isArray(r.calendar) ? r.calendar.length : (r.calendar?.count ?? null),
    icloud: r.icloud ?? null,
    concept: r.concept?.name ?? null,
    writer: r.writer ? WRITER_OF[r.writer] : null,
  };
}

function tally(keys: string[], weights?: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  keys.forEach((k, i) => (out[k] = (out[k] ?? 0) + (weights?.[i] ?? 1)));
  return out;
}

export function summarise(records: StoredRecord[]): ReportSummary {
  const days = [...records].sort((a, b) => a.date.localeCompare(b.date)).map(summariseDay);
  const calls = records.flatMap((r) => r.calls);
  const writer = roleStats(calls.filter((c) => c.role === 'writer'));
  const errors = days.flatMap((d) => d.errors.map((e) => e.source));
  const costUsd = sum(calls.map((c) => c.costUsd));
  return {
    days,
    totals: {
      daysRun: days.length,
      daysDelivered: days.filter((d) => d.delivery === 'sent').length,
      items: {
        fetched: sum(days.map((d) => d.items.fetched ?? 0)),
        inWindow: sum(days.map((d) => d.items.inWindow)),
        decided: sum(days.map((d) => d.items.decided)),
      },
      costUsd,
      costByRole: byRole(calls, (c) => sum(c.map((x) => x.costUsd))),
      costByModel: tally(
        calls.map((c) => c.model),
        calls.map((c) => c.costUsd),
      ),
      meanCostPerDay: days.length ? costUsd / days.length : 0,
      meanLatencyMs: byRole(calls, (c) => mean(c.map((x) => x.latencyMs))),
      errors: errors.length,
      errorsBySource: tally(errors),
      writerCacheHitRatio: writer.inputTokens ? writer.cacheReadTokens / writer.inputTokens : 0,
      briefsByWriter: Object.fromEntries(
        WRITERS.map((w) => [w, days.filter((d) => d.writer === w).length]),
      ) as Record<WriterName, number>,
    },
  };
}

export const usd = (n: number) => `$${n.toFixed(4)}`;
export const ms = (n: number) => `${n.toFixed(0)} ms`;
export const list = (record: Record<string, number>, format: (n: number) => string = String) =>
  Object.entries(record)
    .map(([k, v]) => `${k}: ${format(v)}`)
    .join(', ') || 'none';
const cell = (value: string) => value.replace(/\|/g, '\\|');
const table = (head: string[], body: string[][]) =>
  [head, head.map(() => '---'), ...body].map((r) => `| ${r.join(' | ')} |`).join('\n');

const roleCell = (s: RoleStats) =>
  s.calls
    ? `${s.calls} × ${s.inputTokens}/${s.outputTokens} tok, cache ${s.cacheReadTokens}, ${usd(s.costUsd)}, ${ms(s.meanLatencyMs)}`
    : '-';

export function toMarkdown(summary: ReportSummary): string {
  const { days, totals: t } = summary;
  return [
    '## Run report',
    '',
    `Days with a record: ${days.map((d) => d.date).join(', ') || 'none'}`,
    '',
    table(
      [
        'Date',
        'Delivery',
        'Fetched',
        'In window',
        'Decided',
        ...DECISIONS,
        'Decision calls',
        'Writer calls',
        'Cost',
        'Errors',
        'Calendar',
        'iCloud',
        'Concept',
      ],
      days.map((d) => [
        d.date,
        d.delivery ?? '-',
        String(d.items.fetched ?? '-'),
        String(d.items.inWindow),
        String(d.items.decided),
        ...DECISIONS.map((x) => String(d.decisions[x])),
        roleCell(d.calls.decision),
        roleCell(d.calls.writer),
        usd(d.costUsd),
        cell(d.errors.map((e) => (e.reason ? `${e.source} (${e.reason})` : e.source)).join(', ')) ||
          '-',
        String(d.calendarEvents ?? '-'),
        d.icloud ?? '-',
        cell(d.concept ?? '-'),
      ]),
    ),
    '',
    '### Totals',
    '',
    `- Days run: ${t.daysRun}, delivered: ${t.daysDelivered}`,
    `- Items: ${t.items.fetched} fetched, ${t.items.inWindow} in window, ${t.items.decided} decided`,
    `- Cost: ${usd(t.costUsd)} (mean ${usd(t.meanCostPerDay)} per day)`,
    `- Cost by role: decision ${usd(t.costByRole.decision)}, writer ${usd(t.costByRole.writer)}`,
    `- Cost by model: ${list(t.costByModel, usd)}`,
    `- Mean latency: decision ${ms(t.meanLatencyMs.decision)}, writer ${ms(t.meanLatencyMs.writer)}`,
    `- Writer cache hit ratio: ${t.writerCacheHitRatio.toFixed(2)}`,
    `- Briefs by writer: ${list(t.briefsByWriter)}`,
    `- Errors: ${t.errors} (${list(t.errorsBySource)})`,
    '',
  ].join('\n');
}

export function toJson(summary: ReportSummary): string {
  return `${JSON.stringify(redact(summary, []), null, 2)}\n`;
}
