import { cp, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadJson, pricesSchema } from './config.js';
import { HAIKU_MODEL } from './decide/haiku.js';
import { evalId, loadEvalSet, saveEvalSet, type EvalItem } from './eval/eval-set.js';
import { SMALL_SET, scoreModel } from './eval/score.js';
import { parseEvalArgs, runEval, type EvalArgs, type EvalDeps } from './eval-cli.js';
import type { DecisionModel } from './types.js';

const prices = await loadJson('config/prices.json', pricesSchema);
const deps: EvalDeps = {
  today: '2026-10-11',
  now: new Date('2026-10-11T06:00:00Z'),
  prices,
  keys: { anthropicKey: 'sk-ant-synthetic', openRouterKey: 'sk-or-v1-synthetic' },
  fetchFn: vi.fn<typeof fetch>(),
};
const score: EvalArgs = { command: 'score', models: ['haiku', 'jev'], dryRun: true };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function rootWith(items: EvalItem[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'eval-cli-'));
  await saveEvalSet(join(root, 'eval', 'decisions.json'), { version: 1, items });
  return root;
}

const synthetic = (count: number): EvalItem[] =>
  Array.from({ length: count }, (_, i) => ({
    id: evalId(`Item ${i}`),
    title: `Item ${i}`,
    link: `https://example.com/${i}`,
    summary: '',
    published: '',
    label: 'skip',
    labeledAt: '2026-10-11T06:00:00.000Z',
    source: 'manual',
  }));

describe('eval CLI', () => {
  it.each([
    [['build'], { command: 'build', from: '2026-10-05', to: '2026-10-11' }],
    [
      ['build', '--from', '2026-10-10', '--to', '2026-10-11'],
      { command: 'build', from: '2026-10-10', to: '2026-10-11' },
    ],
    [
      ['label', 'tidy', 'desk', 'skip', '--relabel'],
      { command: 'label', fragment: 'tidy desk', label: 'skip', relabel: true },
    ],
    [['score'], { command: 'score', models: ['haiku', 'jev'], dryRun: false }],
    [
      ['score', '--models', 'jev', '--dry-run'],
      { command: 'score', models: ['jev'], dryRun: true },
    ],
  ])('parses %j', (argv, expected) => {
    expect(parseEvalArgs(argv, '2026-10-11')).toEqual(expected);
  });

  it.each([
    [[]],
    [['grade']],
    [['build', '--from', '2026-10-12', '--to', '2026-10-11']],
    [['label', 'tidy desk']],
    [['label', 'tidy desk', 'keep']],
    [['score', '--models', 'gpt']],
  ])('rejects %j', (argv) => {
    expect(() => parseEvalArgs(argv, '2026-10-11')).toThrow();
  });

  it('v12 criterion 3: "`eval score --dry-run` over a fixture eval set reports accuracy, per-label precision/recall and a 3×3 confusion matrix whose cells sum to the set size, plus cost and latency per model."', async () => {
    const global = vi.spyOn(globalThis, 'fetch');
    const root = await mkdtemp(join(tmpdir(), 'eval-cli-'));
    await cp('test/fixtures/eval', join(root, 'eval'), { recursive: true });
    const size = (await loadEvalSet(join(root, 'eval', 'decisions.json'))).items.length;

    const markdown = await runEval(root, score, deps);
    expect(await readdir(join(root, 'reports'))).toEqual([
      'eval-2026-10-11-haiku.dry-run.json',
      'eval-2026-10-11-jev.dry-run.json',
    ]);
    for (const name of ['haiku', 'jev']) {
      const report = JSON.parse(
        await readFile(join(root, 'reports', `eval-2026-10-11-${name}.dry-run.json`), 'utf8'),
      );
      expect(report).toMatchObject({
        name,
        model: 'fake',
        dryRun: true,
        items: 7,
        accuracy: 3 / 7,
        perLabel: {
          must_read: { precision: 0.5, recall: 0.5 },
          mention: { precision: 1 / 3, recall: 1 / 3 },
          skip: { precision: 0.5, recall: 0.5 },
        },
        confusion: [
          [1, 1, 0],
          [1, 1, 1],
          [0, 1, 1],
        ],
        errors: 0,
        costUsd: 0,
        meanLatencyMs: 0,
      });
      expect(report.confusion.flat().reduce((a: number, b: number) => a + b, 0)).toBe(size);
    }
    expect(markdown).toContain('## Eval 2026-10-11: 7 labelled items (dry run, fake models)');
    expect(markdown).toContain(
      '| haiku (fake) | 43% | 50%/50% | 33%/33% | 50%/50% | 0 | 0.000000 | 0 |',
    );
    expect(markdown).toContain('### jev: label (rows) by prediction (columns)');
    expect(markdown).toContain('| mention | 1 | 1 | 1 |');
    expect(deps.fetchFn).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();

    const priced: DecisionModel = {
      model: HAIKU_MODEL,
      decide: async () => ({
        decision: 'skip',
        call: {
          role: 'decision',
          model: HAIKU_MODEL,
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          latencyMs: 120,
          costUsd: 0.002,
        },
      }),
    };
    const items = (await loadEvalSet(join(root, 'eval', 'decisions.json'))).items;
    const live = await scoreModel('haiku', priced, items, {
      date: deps.today,
      dryRun: false,
      prices,
    });
    expect(live).toMatchObject({ costUsd: expect.closeTo(0.014, 12), meanLatencyMs: 120 });
    expect(live.perLabel.must_read).toEqual({ precision: null, recall: 0 });
  });

  it('v12 criterion 4: "With fewer than 30 items the score output carries the small-set warning; with 30 or more it does not."', async () => {
    const warning = /Warning: only \d+ labelled items \(under 30\)/;
    const small = await runEval(await rootWith(synthetic(SMALL_SET - 1)), score, deps);
    expect(small).toMatch(warning);
    expect(small).toContain(`only ${SMALL_SET - 1} labelled items`);
    const enough = await runEval(await rootWith(synthetic(SMALL_SET)), score, deps);
    expect(enough).not.toMatch(warning);
    expect(enough).toContain('| haiku (fake) | 100% |');
  });
});
