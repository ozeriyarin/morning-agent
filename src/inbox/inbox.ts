import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { todayIn } from '../dates.js';
import { latestRecord } from '../records.js';
import { redactText } from '../run/redact.js';
import type { Sender } from '../types.js';
import { TITLES } from '../write/template.js';
import { parseCommand, runCommand } from './commands.js';
import { appendFeedback, toFeedbackEntry, type FeedbackEntry } from './feedback.js';
import type { InboxMessage, UpdatesSource } from './telegram-updates.js';

const MAX_UPDATES_PER_RUN = 20;
const FIRST_RUN_MAX_AGE_S = 24 * 60 * 60;
export const THANKS = 'תודה, נרשם.';
export const COMMAND_FAILED = 'משהו השתבש, נסו שוב מאוחר יותר.';

export interface InboxDeps {
  updates: UpdatesSource;
  sender: Sender;
  chatId: string;
  root: string;
  timeZone: string;
  fetchFn: typeof fetch;
  now: () => Date;
  secrets: string[];
}

export interface InboxResult {
  updates: number;
  commands: number;
  feedback: number;
  ignoredChats: number;
  stale: number;
  errors: string[];
  offset: number | null;
}

const offsetSchema = z.object({ offset: z.number().int() });

const offsetPath = (root: string) => join(root, 'state', 'telegram-offset.json');

async function readOffset(path: string): Promise<number | null> {
  const text = await readFile(path, 'utf8').catch(() => null);
  return text === null ? null : offsetSchema.parse(JSON.parse(text)).offset;
}

// The brief is the bot message carrying the fixed news heading; its send day is the brief date.
function briefDate(message: InboxMessage, timeZone: string): string | undefined {
  const r = message.replyTo;
  if (!r?.fromBot || !r.text.includes(TITLES.news)) return undefined;
  return todayIn(timeZone, new Date(r.date * 1000));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Handles at most 20 updates from the configured chat, replies, stores feedback, then the offset.
export async function runInbox(deps: InboxDeps): Promise<InboxResult> {
  const path = offsetPath(deps.root);
  const stored = await readOffset(path);
  const updates = await deps.updates.getUpdates(stored, MAX_UPDATES_PER_RUN);
  const result: InboxResult = {
    updates: updates.length,
    commands: 0,
    feedback: 0,
    ignoredChats: 0,
    stale: 0,
    errors: [],
    offset: stored,
  };
  const last = updates.at(-1);
  if (!last) return result;

  const now = deps.now();
  const today = todayIn(deps.timeZone, now);
  const ctx = { root: deps.root, timeZone: deps.timeZone, now, fetchFn: deps.fetchFn };
  const scrub = (text: string) => redactText(text, deps.secrets);
  const entries: FeedbackEntry[] = [];
  let titles: string[] | null = null;

  for (const { message } of updates) {
    if (!message) continue;
    if (message.chatId !== deps.chatId) {
      result.ignoredChats++;
      continue;
    }
    if (stored === null && now.getTime() / 1000 - message.date > FIRST_RUN_MAX_AGE_S) {
      result.stale++;
      continue;
    }
    let reply = THANKS;
    // Scrubbed on the way in, so no secret reaches a reply, the queue or a feedback file.
    const text = scrub(message.text);
    try {
      const command = parseCommand(text);
      if (command) {
        result.commands++;
        reply = await runCommand(command, ctx);
      } else {
        result.feedback++;
        titles ??=
          (await latestRecord(join(deps.root, 'runs'), today))?.items.map((i) => i.title) ?? [];
        const replyToBriefDate = briefDate(message, deps.timeZone);
        const at = new Date(message.date * 1000).toISOString();
        entries.push(
          toFeedbackEntry({ at, text, ...(replyToBriefDate && { replyToBriefDate }) }, titles),
        );
      }
    } catch (error) {
      result.errors.push(scrub(errorText(error)));
      reply = COMMAND_FAILED;
    }
    try {
      await deps.sender.send(scrub(reply));
    } catch (error) {
      result.errors.push(scrub(errorText(error)));
    }
  }

  await appendFeedback(join(deps.root, 'feedback'), today, entries, deps.secrets);
  result.offset = last.updateId + 1;
  if (result.offset !== stored) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ offset: result.offset })}\n`);
  }
  return result;
}

export function summaryLine(r: InboxResult): string {
  return (
    `inbox: ${r.updates} updates, ${r.commands} commands, ${r.feedback} feedback, ` +
    `${r.ignoredChats} ignored from other chats, ${r.stale} stale, ${r.errors.length} errors` +
    ` · offset ${r.offset ?? 'none'}`
  );
}
