import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadJson, pricesSchema } from './config.js';
import { FakeDecisionModel } from './decide/fake.js';
import { HaikuDecisionModel } from './decide/haiku.js';
import { JevDecisionModel } from './decide/jev.js';
import { loadRecords } from './records.js';
import { replay } from './replay/replay.js';
import { buildReplayModels, parseReplayArgs, reportPath } from './replay-cli.js';

const KEYS = { anthropicKey: 'sk-ant-synthetic', openRouterKey: 'sk-or-v1-synthetic' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('replay CLI', () => {
  it.each([
    [
      ['--from', '2026-10-01', '--to', '2026-10-02'],
      { from: '2026-10-01', to: '2026-10-02', models: ['haiku', 'jev'], dryRun: false },
    ],
    [
      ['--from', '2026-10-10', '--to', '2026-10-10', '--models', 'jev', '--dry-run'],
      { from: '2026-10-10', to: '2026-10-10', models: ['jev'], dryRun: true },
    ],
  ])('parses %j', (argv, expected) => {
    expect(parseReplayArgs(argv)).toEqual(expected);
  });

  it.each([
    [['--from', '2026-10-02', '--to', '2026-10-01']],
    [['--from', '2026-10-01']],
    [['--from', '2026-10-01', '--to', '2026-10-02', '--models', 'gpt']],
  ])('rejects %j', (argv) => {
    expect(() => parseReplayArgs(argv)).toThrow();
  });

  it('writes reports/replay-<from>-<to>.json, with a .dry-run suffix for dry runs', () => {
    const args = { from: '2026-10-01', to: '2026-10-31', models: [], dryRun: false };
    expect(reportPath('root', args).replace(/\\/g, '/')).toBe(
      'root/reports/replay-2026-10-01-2026-10-31.json',
    );
    expect(reportPath('root', { ...args, dryRun: true })).toMatch(/\.dry-run\.json$/);
  });

  it("a live replay builds the real clients and needs each model's key", () => {
    const noNetwork: typeof fetch = async () => new Response('', { status: 500 });
    const models = buildReplayModels(['haiku', 'jev'], false, KEYS, noNetwork);
    expect(models.haiku).toBeInstanceOf(HaikuDecisionModel);
    expect(models.jev).toBeInstanceOf(JevDecisionModel);
    expect(() => buildReplayModels(['jev'], false, { openRouterKey: null }, noNetwork)).toThrow(
      ConfigError,
    );
    expect(() => buildReplayModels(['haiku'], false, { openRouterKey: null }, noNetwork)).toThrow(
      'ANTHROPIC_API_KEY',
    );
  });

  it('v4 criterion 8: "Replay with `--dry-run` uses fakes for both models and writes no network calls."', async () => {
    const injected = vi.fn<typeof fetch>();
    const global = vi.spyOn(globalThis, 'fetch');
    const models = buildReplayModels(['haiku', 'jev'], true, KEYS, injected);
    expect(models.haiku).toBeInstanceOf(FakeDecisionModel);
    expect(models.jev).toBeInstanceOf(FakeDecisionModel);

    const report = await replay({
      from: '2026-10-01',
      to: '2026-10-02',
      dryRun: true,
      runs: await loadRecords('test/fixtures/runs', '2026-10-01', '2026-10-02'),
      models,
      prices: await loadJson('config/prices.json', pricesSchema),
    });
    expect(report.models.haiku).toMatchObject({ model: 'fake', decisions: 5, costUsd: 0 });
    expect(report.models.jev).toMatchObject({ model: 'fake', decisions: 5, costUsd: 0 });
    expect(injected).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
  });
});
