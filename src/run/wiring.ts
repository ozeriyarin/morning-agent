import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BriefConfig, Env, Prices } from '../config.js';
import { loadRecords } from '../records.js';
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
import { OpenMeteoSource } from '../sources/weather.js';
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
  decider?: Decider;
  openRouterKey?: string | null;
  print?: (text: string) => void;
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
  const client = live ? anthropicClient(live.ANTHROPIC_API_KEY) : null;
  const decision = selectDecisionModel({
    flag: options.decider,
    configured: config.decisionModel,
    client,
    openRouterKey,
    fetchFn,
  });
  return {
    weather: new OpenMeteoSource(config.location, fetchFn),
    calendar: new CalendarFileSource(root, timeZone, calendarPath),
    icloud: icloudPath
      ? new ICloudFileSource(icloudPath, timeZone)
      : icloud
        ? new ICloudCalendarSource(icloud, timeZone, fetchFn)
        : null,
    feeds: config.feeds.map((feed) => new FeedSource(feed.name, feed.url, fetchFn)),
    concepts: new FileConceptStore(join(root, 'concepts', 'queue.md')),
    interview: new FileInterviewStore(
      join(root, 'interview', 'problems.md'),
      join(root, 'interview', 'tips.md'),
    ),
    decisionModel: decision.model,
    warnings: decision.warnings,
    writer: client ? new SonnetWriter(client) : new TemplateWriter(),
    sender: live
      ? new TelegramSender(live.TELEGRAM_BOT_TOKEN, live.TELEGRAM_CHAT_ID, fetchFn)
      : new ConsoleSender(print),
    prices,
    secrets: [
      ...(live ? [live.TELEGRAM_BOT_TOKEN, live.TELEGRAM_CHAT_ID, live.ANTHROPIC_API_KEY] : []),
      ...(icloud ? [icloud.username, icloud.password] : []),
      ...(openRouterKey ? [openRouterKey] : []),
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
