import type { Prices } from '../config.js';
import { priceCall } from '../cost.js';
import type { FeedbackLabel } from '../inbox/feedback.js';
import type { StoredRecord } from '../records.js';
import { decideAll } from '../run/run-brief.js';
import { normalizeTitle } from '../sources/feeds.js';
import { DECISIONS, type Decision, type DecisionModel, type Item } from '../types.js';

export interface ReplayItem {
  date: string;
  item: Item;
  original: Decision | null;
}

export interface ModelChoice {
  decision: Decision;
  costUsd: number;
  latencyMs: number | null;
  confidence?: number;
  error?: string;
}

export interface ModelStats {
  model: string;
  decisions: number;
  counts: Record<Decision, number>;
  errors: number;
  costUsd: number;
  meanLatencyMs: number;
}

export interface AgreementCell {
  agree: number;
  total: number;
}

export interface ReplayReport {
  from: string;
  to: string;
  dryRun: boolean;
  runs: string[];
  storedItems: number;
  items: {
    date: string;
    title: string;
    original: Decision | null;
    feedback?: FeedbackLabel;
    choices: Record<string, ModelChoice>;
  }[];
  models: Record<string, ModelStats>;
  agreement: { labels: string[]; cells: AgreementCell[][]; feedback?: AgreementCell[] };
  disagreements: { title: string; choices: Record<string, Decision | null> }[];
}

// The first day an item appeared wins, together with the decision made that day.
export function collectItems(runs: StoredRecord[]): ReplayItem[] {
  const byTitle = new Map<string, ReplayItem>();
  for (const run of runs) {
    const decided = new Map(run.decisions.map((d) => [normalizeTitle(d.title), d.decision]));
    for (const { title, link, published, summary, sources } of run.items) {
      const key = normalizeTitle(title);
      if (byTitle.has(key)) continue;
      const item = { id: link, title, link, published, summary, sources };
      byTitle.set(key, { date: run.date, item, original: decided.get(key) ?? null });
    }
  }
  return [...byTitle.values()];
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function stats(model: string, choices: ModelChoice[]): ModelStats {
  const latencies = choices.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]));
  const counts = Object.fromEntries(
    DECISIONS.map((d) => [d, choices.filter((c) => c.decision === d).length]),
  ) as Record<Decision, number>;
  return {
    model,
    decisions: choices.length,
    counts,
    errors: choices.filter((c) => c.error).length,
    costUsd: sum(choices.map((c) => c.costUsd)),
    meanLatencyMs: latencies.length ? sum(latencies) / latencies.length : 0,
  };
}

export interface ReplayInput {
  from: string;
  to: string;
  dryRun: boolean;
  runs: StoredRecord[];
  models: Record<string, DecisionModel>;
  prices: Prices;
  feedback?: Map<string, FeedbackLabel>;
}

// A keep label agrees with must_read or mention, a drop label with skip.
const agreesWith = (label: FeedbackLabel, decision: Decision) =>
  (label === 'keep') === (decision !== 'skip');

// Each deduped item is decided once per model; `original` is the decision stored in the record.
export async function replay(input: ReplayInput): Promise<ReplayReport> {
  const replayItems = collectItems(input.runs);
  const items = replayItems.map((r) => r.item);
  const models = Object.entries(input.models);
  const perModel = await Promise.all(
    models.map(async ([, model]) =>
      (await decideAll(model, items)).map((r): ModelChoice => ({
        decision: r.decision,
        costUsd: r.call ? priceCall(r.call, input.prices).costUsd : 0,
        latencyMs: r.call ? r.call.latencyMs : null,
        ...(r.confidence !== undefined && { confidence: r.confidence }),
        ...(r.error && { error: r.error }),
      })),
    ),
  );
  const names = models.map(([name]) => name);
  const rows = replayItems.map((r, i) => ({
    date: r.date,
    title: r.item.title,
    original: r.original,
    feedback: input.feedback?.get(normalizeTitle(r.item.title)),
    choices: Object.fromEntries(names.map((name, m) => [name, perModel[m]?.[i] as ModelChoice])),
  }));
  const labels = ['original', ...names];
  const pick = (row: (typeof rows)[number], label: string) =>
    label === 'original' ? row.original : (row.choices[label]?.decision ?? null);
  const cells = labels.map((a) =>
    labels.map((b): AgreementCell => {
      const compared = rows.filter((row) => pick(row, a) !== null && pick(row, b) !== null);
      const agree = compared.filter((row) => pick(row, a) === pick(row, b)).length;
      return { agree, total: compared.length };
    }),
  );
  const labelled = rows.flatMap((row) => (row.feedback ? [{ row, label: row.feedback }] : []));
  const feedback = labels.map((l): AgreementCell => {
    const compared = labelled.flatMap(({ row, label }) => {
      const decision = pick(row, l);
      return decision === null ? [] : [agreesWith(label, decision)];
    });
    return { agree: compared.filter(Boolean).length, total: compared.length };
  });
  // With one model the comparison is against the stored decision instead.
  const contenders = names.length > 1 ? names : labels;
  const disagreements = rows
    .filter((row) => new Set(contenders.map((l) => pick(row, l))).size > 1)
    .map((row) => ({
      title: row.title,
      choices: Object.fromEntries(labels.map((l) => [l, pick(row, l)])),
    }));
  return {
    from: input.from,
    to: input.to,
    dryRun: input.dryRun,
    runs: input.runs.map((r) => r.date),
    storedItems: sum(input.runs.map((r) => r.items.length)),
    items: rows,
    models: Object.fromEntries(
      models.map(([name, model], m) => [name, stats(model.model, perModel[m] ?? [])]),
    ),
    agreement: { labels, cells, ...(labelled.length && { feedback }) },
    disagreements,
  };
}

const table = (head: string[], body: string[][]) =>
  [head, head.map(() => '---'), ...body].map((r) => `| ${r.join(' | ')} |`).join('\n');

const share = ({ agree, total }: AgreementCell) =>
  total ? `${agree}/${total} (${Math.round((agree / total) * 100)}%)` : '-';

export function renderMarkdown(report: ReplayReport): string {
  const { labels, cells, feedback } = report.agreement;
  const head = ['Model', 'Decisions', ...DECISIONS, 'Errors', 'Cost (USD)', 'Mean latency (ms)'];
  return [
    `## Replay ${report.from} to ${report.to}${report.dryRun ? ' (dry run, fake models)' : ''}`,
    '',
    `Runs: ${report.runs.join(', ') || 'none'} · ${report.items.length} unique items of ${report.storedItems} stored`,
    '',
    table(
      head,
      Object.entries(report.models).map(([name, s]) => [
        `${name} (${s.model})`,
        String(s.decisions),
        ...DECISIONS.map((d) => String(s.counts[d])),
        String(s.errors),
        s.costUsd.toFixed(6),
        s.meanLatencyMs.toFixed(0),
      ]),
    ),
    '',
    '### Agreement',
    '',
    table(
      ['', ...labels],
      [
        ...labels.map((label, i) => [label, ...(cells[i] ?? []).map(share)]),
        ...(feedback ? [['feedback', ...feedback.map(share)]] : []),
      ],
    ),
    '',
    '### Disagreements',
    '',
    report.disagreements.length
      ? table(
          ['Title', ...labels],
          report.disagreements.map((d) => [
            d.title.replace(/\|/g, '\\|'),
            ...labels.map((l) => d.choices[l] ?? '-'),
          ]),
        )
      : 'None.',
    '',
  ].join('\n');
}
