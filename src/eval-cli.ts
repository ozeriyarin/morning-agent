import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { useEnvProxy } from './cli.js';
import {
  briefConfigSchema,
  loadAnthropicKey,
  loadJson,
  loadOpenRouterKey,
  pricesSchema,
  type Prices,
} from './config.js';
import { addDays, isIsoDate, todayIn } from './dates.js';
import { buildEvalSet, labelEvalItem, loadEvalSet, saveEvalSet } from './eval/eval-set.js';
import { renderScoreMarkdown, scoreModel } from './eval/score.js';
import { loadFeedbackLabels } from './inbox/feedback.js';
import { latestRecord, loadRecords } from './records.js';
import {
  buildReplayModels,
  parseModels,
  REPLAY_MODELS,
  type ReplayKeys,
  type ReplayModel,
} from './replay-cli.js';
import { redact } from './run/redact.js';
import { DECISIONS, type Decision } from './types.js';

export type EvalArgs =
  | { command: 'build'; from: string; to: string }
  | { command: 'label'; fragment: string; label: Decision; relabel: boolean }
  | { command: 'score'; models: ReplayModel[]; dryRun: boolean };

const USAGE =
  'usage: eval build [--from <date> --to <date>] | label <title fragment> <label> [--relabel]' +
  ' | score [--models haiku,jev] [--dry-run]';

// Without --from/--to, build reads the 7 days ending `today`.
export function parseEvalArgs(argv: string[], today: string): EvalArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      models: { type: 'string', default: REPLAY_MODELS.join(',') },
      'dry-run': { type: 'boolean', default: false },
      relabel: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...rest] = positionals;
  if (command === 'build') {
    const to = values.to ?? today;
    const from = values.from ?? addDays(to, -6);
    if (!isIsoDate(from) || !isIsoDate(to) || from > to)
      throw new Error('--from and --to must be YYYY-MM-DD with --from <= --to');
    return { command, from, to };
  }
  if (command === 'label') {
    const label = rest.at(-1);
    const fragment = rest.slice(0, -1).join(' ').trim();
    if (!fragment || !(DECISIONS as readonly string[]).includes(label ?? ''))
      throw new Error(`label takes <title fragment> <${DECISIONS.join('|')}>`);
    return { command, fragment, label: label as Decision, relabel: values.relabel };
  }
  if (command === 'score')
    return { command, models: parseModels(values.models), dryRun: values['dry-run'] };
  throw new Error(USAGE);
}

export interface EvalDeps {
  today: string;
  now: Date;
  prices: Prices;
  keys: ReplayKeys;
  fetchFn: typeof fetch;
}

function evalReportPath(root: string, date: string, name: string, dryRun: boolean) {
  return join(root, 'reports', `eval-${date}-${name}${dryRun ? '.dry-run' : ''}.json`);
}

// Returns what the command prints; every path is under `root`.
export async function runEval(root: string, args: EvalArgs, deps: EvalDeps): Promise<string> {
  const setPath = join(root, 'eval', 'decisions.json');
  const set = await loadEvalSet(setPath);
  const labeledAt = deps.now.toISOString();
  if (args.command === 'build') {
    const runs = await loadRecords(join(root, 'runs'), args.from, args.to);
    // Feedback sent overnight lands in the next day's file.
    const feedback = await loadFeedbackLabels(
      join(root, 'feedback'),
      args.from,
      addDays(args.to, 1),
    );
    const built = buildEvalSet(set, runs, feedback, labeledAt);
    await saveEvalSet(setPath, built.set);
    return `added ${built.added}, set size ${built.set.items.length}\n`;
  }
  if (args.command === 'label') {
    const record = await latestRecord(join(root, 'runs'), deps.today);
    if (!record) throw new Error(`no run record in the 7 days ending ${deps.today}`);
    const labelled = labelEvalItem(set, record, { ...args, labeledAt });
    await saveEvalSet(setPath, labelled.set);
    const verb = labelled.relabelled ? 'relabelled' : 'labelled';
    return `${verb} "${labelled.item.title}" as ${labelled.item.label}, set size ${labelled.set.items.length}\n`;
  }
  const models = buildReplayModels(args.models, args.dryRun, deps.keys, deps.fetchFn);
  const secrets = [deps.keys.anthropicKey ?? '', deps.keys.openRouterKey ?? ''];
  const opts = { date: deps.today, dryRun: args.dryRun, prices: deps.prices };
  const reports = [];
  for (const [name, model] of Object.entries(models)) {
    const report = await scoreModel(name, model, set.items, opts);
    const path = evalReportPath(root, deps.today, name, args.dryRun);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(redact(report, secrets), null, 2)}\n`);
    console.error(`report: ${path}`);
    reports.push(report);
  }
  return redact(renderScoreMarkdown(reports, set.items.length), secrets);
}

async function main(): Promise<void> {
  useEnvProxy();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = await loadJson(join(root, 'config', 'brief.json'), briefConfigSchema);
  const now = new Date();
  const today = todayIn(config.location.timezone, now);
  const output = await runEval(root, parseEvalArgs(process.argv.slice(2), today), {
    today,
    now,
    prices: await loadJson(join(root, 'config', 'prices.json'), pricesSchema),
    keys: {
      anthropicKey: loadAnthropicKey(process.env),
      openRouterKey: loadOpenRouterKey(process.env),
    },
    fetchFn: fetch,
  });
  process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exit(1);
  });
}
