import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useEnvProxy } from './cli.js';
import { briefConfigSchema, loadJson, loadTelegramEnv } from './config.js';
import { TelegramSender } from './deliver/telegram.js';
import { runInbox, summaryLine } from './inbox/inbox.js';
import { TelegramUpdatesClient } from './inbox/telegram-updates.js';
import { redactText } from './run/redact.js';

// Per-message errors are reported but exit 0, so the routine still commits the new offset.
async function main(): Promise<void> {
  useEnvProxy();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const config = await loadJson(join(root, 'config', 'brief.json'), briefConfigSchema);
  const env = loadTelegramEnv(process.env);
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID];
  const result = await runInbox({
    updates: new TelegramUpdatesClient(env.TELEGRAM_BOT_TOKEN, fetch),
    sender: new TelegramSender(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, fetch),
    chatId: env.TELEGRAM_CHAT_ID,
    root,
    timeZone: config.location.timezone,
    fetchFn: fetch,
    now: () => new Date(),
    secrets,
  });
  for (const error of result.errors) console.error(`error: ${error}`);
  console.error(redactText(summaryLine(result), secrets));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exit(1);
  });
}
