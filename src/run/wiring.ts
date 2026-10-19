import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BriefConfig, Env, Prices } from '../config.js';
import { loadRecords } from '../records.js';
import { HAIKU_MODEL } from '../decide/haiku.js';
import { selectDecisionModel, type Decider } from '../decide/select.js';
import { ConsoleSender } from '../deliver/console.js';
import { TelegramSender } from '../deliver/telegram.js';
import { CalendarFileSource } from '../sources/calendar-file.js';
import { FileConceptStore } from '../sources/concepts.js';
import { FileInterviewStore } from '../sources/interview.js';
import {
  ICloudCalendarSource,
  ICloudFileSource,
  type ICloudCredentials,
} from '../sources/icloud-calendar.js';
import { FeedSource } from '../sources/feeds.js';
import { RemindersFileSource } from '../sources/reminders-file.js';
import { OpenMeteoSource } from '../sources/weather.js';
import { FakeEmbedder, VoyageEmbedder } from '../retrieve/embed.js';
import { MemorySource } from '../retrieve/memory.js';
import { ChainWriter } from '../write/chain.js';
import { SonnetWriter } from '../write/sonnet.js';
import { TemplateWriter } from '../write/template.js';
import type { RunDeps } from './run-brief.js';

export interface WiringOptions {
  env: Env;
  config: BriefConfig;
  prices: Prices;
  root: string;
  fetchFn: typeof fetch;
  calendarPath?: string;
  icloud?: ICloudCredentials | null;
  icloudPath?: string;
  remindersPath?: string;
  decider?: Decider;
  openRouterKey?: string | null;
  voyageKey?: string | null;
  memoryPath?: string;
  print?: (text: string) => void;
}

export const MEMORY_DISABLED_WARNING = 'memory: disabled in config, skipped';
export const MEMORY_NO_KEY_WARNING = 'memory: no VOYAGE_API_KEY, skipped';

// Summary: live runs use Voyage over memory/index.json; dry runs use the fake over --memory only.
// Details: a dry run without --memory skips silently; a live run without memory warns once.
function memorySource(options: WiringOptions): {
  memory: MemorySource | null;
  warnings: string[];
} {
  const { env, config, root, fetchFn, memoryPath } = options;
  const dryRun = 'dryRun' in env;
  if (!config.memory.enabled)
    return { memory: null, warnings: dryRun ? [] : [MEMORY_DISABLED_WARNING] };
  if (dryRun)
    return {
      memory: memoryPath ? new MemorySource(memoryPath, new FakeEmbedder(), config.memory) : null,
      warnings: [],
    };
  if (!options.voyageKey) return { memory: null, warnings: [MEMORY_NO_KEY_WARNING] };
  const embedder = new VoyageEmbedder(options.voyageKey, fetchFn);
  const path = join(root, 'memory', 'index.json');
  return { memory: new MemorySource(path, embedder, config.memory), warnings: [] };
}

export function recordPath(root: string, date: string, dryRun: boolean): string {
  return join(root, 'runs', `${date}${dryRun ? '.dry-run' : ''}.json`);
}

export function anthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
}

// Dry runs swap only the AI and Telegram clients; weather and feeds are still fetched.
export function buildDeps(options: WiringOptions): RunDeps {
  const { env, config, prices, root, fetchFn, calendarPath, icloud, icloudPath, print } = options;
  const openRouterKey = options.openRouterKey ?? null;
  const timeZone = config.location.timezone;
  const live = 'dryRun' in env ? null : env;
  const icloudSource = icloudPath
    ? new ICloudFileSource(icloudPath, timeZone)
    : icloud
      ? new ICloudCalendarSource(icloud, timeZone, fetchFn)
      : null;
  const client = live ? anthropicClient(live.ANTHROPIC_API_KEY) : null;
  const decision = selectDecisionModel({
    flag: options.decider,
    configured: config.decisionModel,
    client,
    openRouterKey,
    fetchFn,
  });
  const memory = memorySource(options);
  return {
    weather: new OpenMeteoSource(config.location, fetchFn),
    calendar: new CalendarFileSource(root, timeZone, calendarPath),
    icloud: icloudSource,
    reminders: icloudSource && {
      name: 'icloud-reminders',
      fetch: (ctx) => icloudSource.reminders(ctx),
    },
    remindersFile: new RemindersFileSource(root, timeZone, options.remindersPath),
    feeds: config.feeds.map((feed) => new FeedSource(feed, fetchFn)),
    concepts: new FileConceptStore(join(root, 'concepts', 'queue.md')),
    interview: new FileInterviewStore(
      join(root, 'interview', 'problems.md'),
      join(root, 'interview', 'tips.md'),
    ),
    decisionModel: decision.model,
    memory: memory.memory,
    warnings: [...decision.warnings, ...memory.warnings],
    writer: client
      ? new ChainWriter([
          new SonnetWriter(client),
          new SonnetWriter(client, { model: HAIKU_MODEL }),
          new TemplateWriter(),
        ])
      : new TemplateWriter(),
    sender: live
      ? new TelegramSender(live.TELEGRAM_BOT_TOKEN, live.TELEGRAM_CHAT_ID, fetchFn)
      : new ConsoleSender(print),
    prices,
    secrets: [
      ...(live ? [live.TELEGRAM_BOT_TOKEN, live.TELEGRAM_CHAT_ID, live.ANTHROPIC_API_KEY] : []),
      ...(icloud ? [icloud.username, icloud.password] : []),
      ...(openRouterKey ? [openRouterKey] : []),
      ...(options.voyageKey ? [options.voyageKey] : []),
    ],
    timeZone,
    localTime: config.schedule.localTime,
    now: () => new Date(),
    history: (from, to) => loadRecords(join(root, 'runs'), from, to),
    writeRecord: async (record) => {
      const path = recordPath(root, record.date, record.dryRun);
      await mkdir(join(root, 'runs'), { recursive: true });
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    },
  };
}
