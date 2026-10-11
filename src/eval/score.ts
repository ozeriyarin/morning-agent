import type { Prices } from '../config.js';
import { priceCall } from '../cost.js';
import { table } from '../replay/replay.js';
import { decideAll } from '../run/run-brief.js';
import { DECISIONS, type Decision, type DecisionModel } from '../types.js';
import type { EvalItem } from './eval-set.js';

export const SMALL_SET = 30;

export interface EvalReport {
  date: string;
  name: string;
  model: string;
  dryRun: boolean;
  items: number;
  accuracy: number | null;
  perLabel: Record<Decision, { precision: number | null; recall: number | null }>;
  // Rows are the label, columns the prediction, both in DECISIONS order.
  confusion: number[][];
  errors: number;
  costUsd: number;
  meanLatencyMs: number;
  mismatches: { title: string; label: Decision; predicted: Decision }[];
}

const ratio = (hits: number, total: number) => (total ? hits / total : null);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export async function scoreModel(
  name: string,
  model: DecisionModel,
  items: EvalItem[],
  opts: { date: string; dryRun: boolean; prices: Prices },
): Promise<EvalReport> {
  const results = await decideAll(
    model,
    items.map((i) => ({ ...i, sources: [] })),
  );
  const rows = items.map((item, i) => ({ item, result: results[i] ?? { decision: 'skip' } }));
  const confusion = DECISIONS.map((label) =>
    DECISIONS.map(
      (predicted) =>
        rows.filter((r) => r.item.label === label && r.result.decision === predicted).length,
    ),
  );
  const at = (row: number, col: number) => confusion[row]?.[col] ?? 0;
  const column = (col: number) => sum(DECISIONS.map((_, row) => at(row, col)));
  const perLabel = Object.fromEntries(
    DECISIONS.map((d, i) => [
      d,
      { precision: ratio(at(i, i), column(i)), recall: ratio(at(i, i), sum(confusion[i] ?? [])) },
    ]),
  ) as EvalReport['perLabel'];
  const calls = results.flatMap((r) => (r.call ? [r.call] : []));
  return {
    date: opts.date,
    name,
    model: model.model,
    dryRun: opts.dryRun,
    items: items.length,
    accuracy: ratio(sum(DECISIONS.map((_, i) => at(i, i))), items.length),
    perLabel,
    confusion,
    errors: results.filter((r) => r.error).length,
    costUsd: sum(calls.map((c) => priceCall(c, opts.prices).costUsd)),
    meanLatencyMs: calls.length ? sum(calls.map((c) => c.latencyMs)) / calls.length : 0,
    mismatches: rows
      .filter((r) => r.item.label !== r.result.decision)
      .map((r) => ({ title: r.item.title, label: r.item.label, predicted: r.result.decision })),
  };
}

const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`);

function smallSetWarning(size: number): string | null {
  return size < SMALL_SET
    ? `Warning: only ${size} labelled items (under ${SMALL_SET}); do not over-read these numbers.`
    : null;
}

export function renderScoreMarkdown(reports: EvalReport[], size: number): string {
  const warning = smallSetWarning(size);
  const dryRun = reports.some((r) => r.dryRun) ? ' (dry run, fake models)' : '';
  return [
    `## Eval ${reports[0]?.date ?? ''}: ${size} labelled items${dryRun}`,
    '',
    ...(warning ? [warning, ''] : []),
    table(
      [
        'Model',
        'Accuracy',
        ...DECISIONS.map((d) => `${d} P/R`),
        'Errors',
        'Cost (USD)',
        'Mean latency (ms)',
      ],
      reports.map((r) => [
        `${r.name} (${r.model})`,
        percent(r.accuracy),
        ...DECISIONS.map(
          (d) => `${percent(r.perLabel[d].precision)}/${percent(r.perLabel[d].recall)}`,
        ),
        String(r.errors),
        r.costUsd.toFixed(6),
        r.meanLatencyMs.toFixed(0),
      ]),
    ),
    ...reports.flatMap((r) => [
      '',
      `### ${r.name}: label (rows) by prediction (columns)`,
      '',
      table(
        ['', ...DECISIONS],
        DECISIONS.map((d, i) => [d, ...(r.confusion[i] ?? []).map(String)]),
      ),
    ]),
    '',
  ].join('\n');
}
