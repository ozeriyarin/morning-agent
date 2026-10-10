import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { briefConfigSchema, loadJson } from './config.js';
import { addDays, isIsoDate, todayIn } from './dates.js';
import { loadRecords } from './records.js';
import { summarise, toJson, toMarkdown } from './report/report.js';
import { redactText } from './run/redact.js';

export interface ReportArgs {
  from: string;
  to: string;
  format: 'md' | 'json';
}

// Without --from/--to the range is the 7 days ending `today`.
export function parseReportArgs(argv: string[], today: string): ReportArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      format: { type: 'string', default: 'md' },
    },
    strict: true,
  });
  const to = values.to ?? today;
  const from = values.from ?? addDays(to, -6);
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
    throw new Error('--from and --to must be YYYY-MM-DD with --from <= --to');
  }
  if (values.format !== 'md' && values.format !== 'json') {
    throw new Error(`--format takes md or json, got "${values.format}"`);
  }
  return { from, to, format: values.format };
}

export async function runReport(root: string, args: ReportArgs): Promise<string> {
  const summary = summarise(await loadRecords(join(root, 'runs'), args.from, args.to));
  const json = toJson(summary);
  const path = join(root, 'reports', `report-${args.from}-${args.to}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json);
  console.error(`report: ${path}`);
  return args.format === 'json' ? json : redactText(toMarkdown(summary), []);
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = await loadJson(join(root, 'config', 'brief.json'), briefConfigSchema);
  const args = parseReportArgs(
    process.argv.slice(2),
    todayIn(config.location.timezone, new Date()),
  );
  process.stdout.write(await runReport(root, args));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exit(1);
  });
}
