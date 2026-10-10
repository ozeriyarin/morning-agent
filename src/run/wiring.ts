import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BriefConfig, Env, Prices } from '../config.js';
import { FakeDecisionModel } from '../decide/fake.js';
import { HaikuDecisionModel } from '../decide/haiku.js';
import { ConsoleSender } from '../deliver/console.js';
import { TelegramSender } from '../deliver/telegram.js';
import { FileConceptStore } from '../sources/concepts.js';
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
  print?: (text: string) => void;
}

export function recordPath(root: string, date: string, dryRun: boolean): string {
  return join(root, 'runs', `${date}${dryRun ? '.dry-run' : ''}.json`);
}

// Dry runs swap only the AI and Telegram clients; weather and feeds are still fetched.
export function buildDeps({ env, config, prices, root, fetchFn, print }: WiringOptions): RunDeps {
  const live = 'dryRun' in env ? null : env;
  const client = live
    ? new Anthropic({ apiKey: live.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 })
    : null;
  return {
    weather: new OpenMeteoSource(config.location, fetchFn),
    feeds: config.feeds.map((feed) => new FeedSource(feed.name, feed.url, fetchFn)),
    concepts: new FileConceptStore(join(root, 'concepts', 'queue.md')),
    decisionModel: client ? new HaikuDecisionModel(client) : new FakeDecisionModel(),
    writer: client ? new SonnetWriter(client) : new TemplateWriter(),
    sender: live
      ? new TelegramSender(live.TELEGRAM_BOT_TOKEN, live.TELEGRAM_CHAT_ID, fetchFn)
      : new ConsoleSender(print),
    prices,
    secrets: live ? [live.TELEGRAM_BOT_TOKEN, live.TELEGRAM_CHAT_ID, live.ANTHROPIC_API_KEY] : [],
    timeZone: config.location.timezone,
    localTime: config.schedule.localTime,
    now: () => new Date(),
    writeRecord: async (record) => {
      const path = recordPath(root, record.date, record.dryRun);
      await mkdir(join(root, 'runs'), { recursive: true });
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    },
  };
}
