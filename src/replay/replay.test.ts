import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadJson, pricesSchema } from '../config.js';
import { HAIKU_MODEL } from '../decide/haiku.js';
import { JEV_MODEL } from '../decide/jev.js';
import type { Decision, DecisionModel, DecisionResult, Item } from '../types.js';
import { datesBetween } from '../dates.js';
import { loadRecords } from '../records.js';
import { normalizeTitle } from '../sources/feeds.js';
import { collectItems, renderMarkdown, replay } from './replay.js';

const RUNS = 'test/fixtures/runs';
const prices = await loadJson('config/prices.json', pricesSchema);

class ScriptedModel implements DecisionModel {
  decided: string[] = [];
  constructor(
    readonly model: string,
    private readonly choose: (item: Item) => Decision,
    private readonly costUsd: number,
    private readonly latencyMs: number,
  ) {}
  async decide(item: Item): Promise<DecisionResult> {
    this.decided.push(item.title);
    const call = { role: 'decision' as const, model: this.model, costUsd: this.costUsd };
    return {
      decision: this.choose(item),
      call: {
        ...call,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: this.latencyMs,
      },
    };
  }
}

const haikuChoice = (item: Item): Decision =>
  /claude/i.test(item.title)
    ? 'must_read'
    : /raises|benchmark/i.test(item.title)
      ? 'mention'
      : 'skip';
const jevChoice = (item: Item): Decision =>
  /claude|benchmark/i.test(item.title) ? 'must_read' : 'skip';

describe('replay', () => {
  it('lists every day of the range and skips days without a record', async () => {
    expect(datesBetween('2026-09-30', '2026-10-02')).toEqual([
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect((await loadRecords(RUNS, '2026-09-30', '2026-10-03')).map((r) => r.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it("keeps the first day an item appeared with that day's decision, and tolerates a missing summary", async () => {
    const items = collectItems(await loadRecords(RUNS, '2026-10-01', '2026-10-02'));
    expect(items[0]).toMatchObject({
      date: '2026-10-01',
      original: 'must_read',
      item: { title: 'Anthropic ships Claude Code hooks', summary: '' },
    });
  });

  it('passes the recorded summary through to the replayed decision model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'replay-'));
    const item = { title: 'Claude ships', link: 'https://x/1', summary: 'What the model saw.' };
    await writeFile(
      join(dir, '2026-10-05.json'),
      JSON.stringify({ date: '2026-10-05', items: [item] }),
    );
    const seen: string[] = [];
    const model = new ScriptedModel('m', (i) => (seen.push(i.summary), 'skip'), 0, 1);
    const runs = await loadRecords(dir, '2026-10-05', '2026-10-05');
    await replay({
      from: '2026-10-05',
      to: '2026-10-05',
      dryRun: true,
      runs,
      models: { m: model },
      prices,
    });
    expect(seen).toEqual(['What the model saw.']);
  });

  it('v4 criterion 7: "Replay over two fixture run records with overlapping items dedupes by title, decides each item once per model, and produces the agreement matrix, per-model cost and latency, and the disagreement list; the Markdown table renders the same numbers."', async () => {
    const haiku = new ScriptedModel(HAIKU_MODEL, haikuChoice, 0.001, 100);
    const jev = new ScriptedModel(JEV_MODEL, jevChoice, 0.0001, 40);
    const runs = await loadRecords(RUNS, '2026-10-01', '2026-10-02');
    const report = await replay({
      from: '2026-10-01',
      to: '2026-10-02',
      dryRun: false,
      runs,
      models: { haiku, jev },
      prices,
    });

    expect(report.storedItems).toBe(6);
    expect(report.items.map((i) => i.title)).toEqual([
      'Anthropic ships Claude Code hooks',
      'Startup raises $20M for LLM evals',
      'Ten tips for a tidy desk',
      'A benchmark of local models',
      'Weekend gardening notes',
    ]);
    for (const model of [haiku, jev])
      expect(model.decided).toEqual(report.items.map((i) => i.title));

    expect(report.models.haiku).toEqual({
      model: HAIKU_MODEL,
      decisions: 5,
      counts: { must_read: 1, mention: 2, skip: 2 },
      errors: 0,
      costUsd: expect.closeTo(0.005, 12),
      meanLatencyMs: 100,
    });
    expect(report.models.jev).toMatchObject({
      model: JEV_MODEL,
      counts: { must_read: 2, mention: 0, skip: 3 },
      costUsd: expect.closeTo(0.0005, 12),
      meanLatencyMs: 40,
    });

    const cell = (agree: number) => ({ agree, total: 5 });
    expect(report.agreement).toEqual({
      labels: ['original', 'haiku', 'jev'],
      cells: [
        [cell(5), cell(3), cell(3)],
        [cell(3), cell(5), cell(3)],
        [cell(3), cell(3), cell(5)],
      ],
    });
    expect(report.disagreements).toEqual([
      {
        title: 'Startup raises $20M for LLM evals',
        choices: { original: 'skip', haiku: 'mention', jev: 'skip' },
      },
      {
        title: 'A benchmark of local models',
        choices: { original: 'mention', haiku: 'mention', jev: 'must_read' },
      },
    ]);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain('5 unique items of 6 stored');
    expect(markdown).toContain(`| haiku (${HAIKU_MODEL}) | 5 | 1 | 2 | 2 | 0 | 0.005000 | 100 |`);
    expect(markdown).toContain(`| jev (${JEV_MODEL}) | 5 | 2 | 0 | 3 | 0 | 0.000500 | 40 |`);
    expect(markdown).toContain('| haiku | 3/5 (60%) | 5/5 (100%) | 3/5 (60%) |');
    expect(markdown).toContain('| Startup raises $20M for LLM evals | skip | mention | skip |');
    expect(markdown).toContain('| A benchmark of local models | mention | mention | must_read |');
  });

  it('with one model, disagreements are against the stored decision and failures count as errors', async () => {
    const failing: DecisionModel = {
      model: JEV_MODEL,
      decide: async () => {
        throw new Error('HTTP 503');
      },
    };
    const report = await replay({
      from: '2026-10-01',
      to: '2026-10-02',
      dryRun: false,
      runs: await loadRecords(RUNS, '2026-10-01', '2026-10-02'),
      models: { jev: failing },
      prices,
    });
    expect(report.models.jev).toMatchObject({ errors: 5, costUsd: 0, meanLatencyMs: 0 });
    expect(report.disagreements.map((d) => d.title)).toEqual([
      'Anthropic ships Claude Code hooks',
      'A benchmark of local models',
      'Weekend gardening notes',
    ]);
  });

  it('v6 criterion 8: "Replay reports a feedback agreement row when labelled items exist."', async () => {
    const input = {
      from: '2026-10-01',
      to: '2026-10-02',
      dryRun: false,
      runs: await loadRecords(RUNS, '2026-10-01', '2026-10-02'),
      prices,
    };
    const models = () => ({
      haiku: new ScriptedModel(HAIKU_MODEL, haikuChoice, 0.001, 100),
      jev: new ScriptedModel(JEV_MODEL, jevChoice, 0.0001, 40),
    });
    const feedback = new Map([
      [normalizeTitle('Anthropic ships Claude Code hooks'), 'keep' as const],
      [normalizeTitle('Startup raises $20M for LLM evals'), 'drop' as const],
      [normalizeTitle('A benchmark of local models'), 'drop' as const],
    ]);
    const report = await replay({ ...input, models: models(), feedback });
    const cell = (agree: number) => ({ agree, total: 3 });
    expect(report.agreement.feedback).toEqual([cell(2), cell(1), cell(2)]);
    expect(report.items.filter((i) => i.feedback).map((i) => [i.title, i.feedback])).toEqual([
      ['Anthropic ships Claude Code hooks', 'keep'],
      ['Startup raises $20M for LLM evals', 'drop'],
      ['A benchmark of local models', 'drop'],
    ]);
    expect(renderMarkdown(report)).toContain('| feedback | 2/3 (67%) | 1/3 (33%) | 2/3 (67%) |');

    const unlabelled = await replay({ ...input, models: models(), feedback: new Map() });
    expect(unlabelled.agreement).not.toHaveProperty('feedback');
    expect(renderMarkdown(unlabelled)).not.toContain('| feedback |');
  });
});
