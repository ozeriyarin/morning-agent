import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { briefConfigSchema, loadEnv, loadJson, pricesSchema } from './config.js';
import { isIsoDate, todayIn } from './dates.js';
import { runBrief } from './run/run-brief.js';
import { buildDeps, recordPath } from './run/wiring.js';

export function parseCli(argv: string[]): { dryRun: boolean; date?: string } {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean', default: false }, date: { type: 'string' } },
    strict: true,
  });
  if (values.date !== undefined && !isIsoDate(values.date)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${values.date}"`);
  }
  return { dryRun: values['dry-run'], date: values.date };
}

async function main(): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = parseCli(process.argv.slice(2));
  const config = await loadJson(join(root, 'config', 'brief.json'), briefConfigSchema);
  const prices = await loadJson(join(root, 'config', 'prices.json'), pricesSchema);
  const env = loadEnv(process.env, args.dryRun);
  const date = args.date ?? todayIn(config.location.timezone, new Date());
  const deps = buildDeps({ env, config, prices, root, fetchFn: fetch });
  const { record } = await runBrief(deps, { date, dryRun: args.dryRun });
  console.error(
    `record: ${recordPath(root, date, args.dryRun)} · delivery: ${record.delivery.status}` +
      ` · cost: $${record.totalCostUsd.toFixed(4)} · errors: ${record.errors.length}`,
  );
  return record.delivery.status === 'failed' ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
      process.exit(1);
    },
  );
}
