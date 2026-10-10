import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { useEnvProxy } from './cli.js';
import {
  ConfigError,
  loadAnthropicKey,
  loadJson,
  loadOpenRouterKey,
  pricesSchema,
} from './config.js';
import { addDays, isIsoDate } from './dates.js';
import { FakeDecisionModel } from './decide/fake.js';
import { HaikuDecisionModel } from './decide/haiku.js';
import { JevDecisionModel } from './decide/jev.js';
import { loadFeedbackLabels } from './inbox/feedback.js';
import { loadRecords } from './records.js';
import { renderMarkdown, replay } from './replay/replay.js';
import { redact } from './run/redact.js';
import { anthropicClient } from './run/wiring.js';
import type { DecisionModel } from './types.js';

const REPLAY_MODELS = ['haiku', 'jev'] as const;
type ReplayModel = (typeof REPLAY_MODELS)[number];

export interface ReplayArgs {
  from: string;
  to: string;
  models: ReplayModel[];
  dryRun: boolean;
}

export function parseReplayArgs(argv: string[]): ReplayArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      models: { type: 'string', default: REPLAY_MODELS.join(',') },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const { from, to } = values;
  if (!from || !to || !isIsoDate(from) || !isIsoDate(to) || from > to) {
    throw new Error('--from and --to are required as YYYY-MM-DD with --from <= --to');
  }
  const models = [...new Set(values.models.split(',').map((m) => m.trim()))];
  for (const m of models)
    if (!(REPLAY_MODELS as readonly string[]).includes(m))
      throw new Error(`--models takes ${REPLAY_MODELS.join(',')}, got "${m}"`);
  return { from, to, models: models as ReplayModel[], dryRun: values['dry-run'] };
}

interface ReplayKeys {
  anthropicKey?: string;
  openRouterKey: string | null;
}

// Dry runs use the offline fake for every model, so no request leaves the machine.
export function buildReplayModels(
  names: ReplayModel[],
  dryRun: boolean,
  keys: ReplayKeys,
  fetchFn: typeof fetch,
): Record<string, DecisionModel> {
  const build = (name: ReplayModel): DecisionModel => {
    if (dryRun) return new FakeDecisionModel();
    if (name === 'jev') {
      if (!keys.openRouterKey) throw new ConfigError('OPENROUTER_API_KEY is required for jev');
      return new JevDecisionModel(keys.openRouterKey, fetchFn);
    }
    if (!keys.anthropicKey)
      throw new ConfigError('MORNING_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY is required for haiku');
    return new HaikuDecisionModel(anthropicClient(keys.anthropicKey));
  };
  return Object.fromEntries(names.map((name) => [name, build(name)]));
}

export function reportPath(root: string, args: ReplayArgs): string {
  const suffix = args.dryRun ? '.dry-run' : '';
  return join(root, 'reports', `replay-${args.from}-${args.to}${suffix}.json`);
}

async function main(): Promise<void> {
  useEnvProxy();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = parseReplayArgs(process.argv.slice(2));
  const keys = {
    anthropicKey: loadAnthropicKey(process.env),
    openRouterKey: loadOpenRouterKey(process.env),
  };
  const report = await replay({
    from: args.from,
    to: args.to,
    dryRun: args.dryRun,
    runs: await loadRecords(join(root, 'runs'), args.from, args.to),
    models: buildReplayModels(args.models, args.dryRun, keys, fetch),
    prices: await loadJson(join(root, 'config', 'prices.json'), pricesSchema),
    // Feedback sent overnight lands in the next day's file.
    feedback: await loadFeedbackLabels(join(root, 'feedback'), args.from, addDays(args.to, 1)),
  });
  const secrets = [keys.anthropicKey ?? '', keys.openRouterKey ?? ''];
  const path = reportPath(root, args);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(redact(report, secrets), null, 2)}\n`);
  console.log(redact(renderMarkdown(report), secrets));
  console.error(`report: ${path}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exit(1);
  });
}
