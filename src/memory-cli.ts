import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { useEnvProxy } from './cli.js';
import { briefConfigSchema, ConfigError, loadJson, loadVoyageKey } from './config.js';
import { addDays, isIsoDate, todayIn } from './dates.js';
import { loadEvalSet } from './eval/eval-set.js';
import { loadRecords } from './records.js';
import { FakeEmbedder, VoyageEmbedder, type Embedder } from './retrieve/embed.js';
import { buildIndex, EMPTY_INDEX, loadIndex, saveIndex } from './retrieve/memory-index.js';

export interface MemoryArgs {
  command: 'build';
  from: string;
  to: string;
  dryRun: boolean;
}

const USAGE = 'usage: memory build [--from <date> --to <date>] [--dry-run]';

// Without --from/--to, build reads the 7 days ending `today`, like `eval build`.
export function parseMemoryArgs(argv: string[], today: string): MemoryArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...rest] = positionals;
  if (command !== 'build' || rest.length) throw new Error(USAGE);
  const to = values.to ?? today;
  const from = values.from ?? addDays(to, -6);
  if (!isIsoDate(from) || !isIsoDate(to) || from > to)
    throw new Error('--from and --to must be YYYY-MM-DD with --from <= --to');
  return { command, from, to, dryRun: values['dry-run'] };
}

// Summary: returns what the command prints; every path is under `root`.
// Details: a dry run embeds with the fake and writes nothing, so it needs no key.
export async function runMemory(
  root: string,
  args: MemoryArgs,
  embedder: () => Embedder,
): Promise<string> {
  const path = join(root, 'memory', 'index.json');
  const index = (await loadIndex(path)) ?? EMPTY_INDEX;
  const built = await buildIndex(
    index,
    {
      runs: await loadRecords(join(root, 'runs'), args.from, args.to),
      evalSet: await loadEvalSet(join(root, 'eval', 'decisions.json')),
      queue: await readFile(join(root, 'concepts', 'queue.md'), 'utf8'),
    },
    args.dryRun ? new FakeEmbedder(index.dims || undefined) : embedder(),
  );
  if (!args.dryRun) await saveIndex(path, built.index);
  const suffix = args.dryRun ? ' (dry run, nothing written)' : '';
  return `added ${built.added}, index size ${built.index.chunks.length}${suffix}\n`;
}

async function main(): Promise<void> {
  useEnvProxy();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = await loadJson(join(root, 'config', 'brief.json'), briefConfigSchema);
  const today = todayIn(config.location.timezone, new Date());
  const output = await runMemory(root, parseMemoryArgs(process.argv.slice(2), today), () => {
    const key = loadVoyageKey(process.env);
    if (!key) throw new ConfigError('VOYAGE_API_KEY is required');
    return new VoyageEmbedder(key, fetch);
  });
  process.stdout.write(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exit(1);
  });
}
