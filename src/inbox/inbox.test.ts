import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sender } from '../types.js';
import { runInbox, summaryLine, THANKS, type InboxDeps } from './inbox.js';
import type { InboxMessage, TelegramUpdate, UpdatesSource } from './telegram-updates.js';

const CHAT = '987654321';
const TOKEN = '123456789:AAH-secret-token';
const NOW = new Date('2026-10-10T09:00:00Z');
const nowS = NOW.getTime() / 1000;

class FakeUpdates implements UpdatesSource {
  calls: [number | null, number][] = [];
  constructor(private readonly updates: TelegramUpdate[]) {}
  async getUpdates(offset: number | null, limit: number): Promise<TelegramUpdate[]> {
    this.calls.push([offset, limit]);
    return this.updates;
  }
}

class FakeSender implements Sender {
  readonly name = 'fake';
  sent: string[] = [];
  async send(html: string) {
    this.sent.push(html);
    return { status: 'sent' as const };
  }
}

const message = (
  updateId: number,
  text: string,
  over: Partial<InboxMessage> = {},
): TelegramUpdate => ({
  updateId,
  message: { chatId: CHAT, date: nowS - 60, text, replyTo: null, ...over },
});

const briefReply = { fromBot: true, date: nowS - 7200, text: 'בוקר טוב\nAI היום\n...' };

async function makeRoot(offset?: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'inbox-'));
  await mkdir(join(root, 'runs'));
  await writeFile(
    join(root, 'runs', '2026-10-10.json'),
    JSON.stringify({
      date: '2026-10-10',
      items: [
        { title: 'Anthropic ships Claude Code hooks', link: 'l1' },
        { title: 'Ten tips for a tidy desk', link: 'l2' },
      ],
    }),
  );
  if (offset !== undefined) {
    await mkdir(join(root, 'state'));
    await writeFile(join(root, 'state', 'telegram-offset.json'), JSON.stringify({ offset }));
  }
  return root;
}

function deps(root: string, updates: UpdatesSource, sender: Sender, fetchFn?: typeof fetch) {
  const fetched: string[] = [];
  const inboxDeps: InboxDeps = {
    updates,
    sender,
    chatId: CHAT,
    root,
    timeZone: 'Asia/Jerusalem',
    fetchFn:
      fetchFn ??
      (async (input) => {
        fetched.push(String(input));
        return new Response('unexpected', { status: 500 });
      }),
    now: () => NOW,
    secrets: [TOKEN, CHAT],
  };
  return { inboxDeps, fetched };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const out: Record<string, string> = {};
  for (const f of files.filter((f) => f.isFile())) {
    const path = join(f.parentPath, f.name);
    out[path] = await readFile(path, 'utf8');
  }
  return out;
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

describe('inbox', () => {
  it('v6 criterion 1: "`getUpdates` is called with the stored offset and the new offset (last update id + 1) is persisted; with no updates nothing else is called and no file changes."', async () => {
    const root = await makeRoot(100);
    const updates = new FakeUpdates([message(100, '/help'), message(101, 'נחמד')]);
    const result = await runInbox(deps(root, updates, new FakeSender()).inboxDeps);
    expect(updates.calls).toEqual([[100, 20]]);
    expect(result.offset).toBe(102);
    expect(await readJson(join(root, 'state', 'telegram-offset.json'))).toEqual({ offset: 102 });

    const idle = await makeRoot(102);
    const before = await snapshot(idle);
    const sender = new FakeSender();
    const quiet = deps(idle, new FakeUpdates([]), sender);
    const none = await runInbox(quiet.inboxDeps);
    expect(none).toMatchObject({ updates: 0, offset: 102 });
    expect(sender.sent).toEqual([]);
    expect(quiet.fetched).toEqual([]);
    expect(await snapshot(idle)).toEqual(before);
  });

  it('v6 criterion 2: "Messages from a chat id other than the configured one are ignored and counted in the run output."', async () => {
    const root = await makeRoot(1);
    const sender = new FakeSender();
    const updates = new FakeUpdates([
      message(1, '/cost', { chatId: '5' }),
      message(2, 'hello', { chatId: '-100200' }),
      message(3, '/help'),
    ]);
    const result = await runInbox(deps(root, updates, sender).inboxDeps);
    expect(result).toMatchObject({ ignoredChats: 2, commands: 1, feedback: 0, offset: 4 });
    expect(sender.sent).toHaveLength(1);
    expect(summaryLine(result)).toContain('2 ignored from other chats');
    await expect(readdir(join(root, 'feedback'))).rejects.toThrow();
  });

  it("v6 criterion 7: \"A reply to the latest brief containing 👎 and a fragment of an item title stores `{ title, label: 'drop' }` in today's feedback file; plain text stores free text; both reply `תודה, נרשם.`\"", async () => {
    const root = await makeRoot(10);
    const sender = new FakeSender();
    const updates = new FakeUpdates([
      message(10, '👎 tidy desk', { replyTo: briefReply }),
      message(11, 'הבריף היה ארוך מדי היום'),
    ]);
    const result = await runInbox(deps(root, updates, sender).inboxDeps);
    expect(result.feedback).toBe(2);
    expect(sender.sent).toEqual([THANKS, THANKS]);
    expect(THANKS).toBe('תודה, נרשם.');
    expect(await readJson(join(root, 'feedback', '2026-10-10.json'))).toEqual([
      {
        at: '2026-10-10T08:59:00.000Z',
        text: '👎 tidy desk',
        replyToBriefDate: '2026-10-10',
        title: 'Ten tips for a tidy desk',
        label: 'drop',
      },
      { at: '2026-10-10T08:59:00.000Z', text: 'הבריף היה ארוך מדי היום' },
    ]);
  });

  it('a reply to a bot message that is not the brief carries no brief date', async () => {
    const root = await makeRoot(1);
    const notBrief = { fromBot: true, date: nowS - 60, text: 'תודה, נרשם.' };
    await runInbox(
      deps(root, new FakeUpdates([message(1, 'ok', { replyTo: notBrief })]), new FakeSender())
        .inboxDeps,
    );
    expect(await readJson(join(root, 'feedback', '2026-10-10.json'))).toEqual([
      { at: '2026-10-10T08:59:00.000Z', text: 'ok' },
    ]);
  });

  it('v6 criterion 9: "No secret (bot token, chat id) appears in state, feedback or reply text (redaction test)."', async () => {
    const root = await makeRoot(5);
    await mkdir(join(root, 'concepts'));
    await writeFile(join(root, 'concepts', 'queue.md'), '- [ ] RAG\n');
    const sender = new FakeSender();
    const leaky: typeof fetch = async () => {
      throw new Error(`connect failed https://api.telegram.org/bot${TOKEN}/x chat ${CHAT}`);
    };
    const updates = new FakeUpdates([
      message(5, `my token is ${TOKEN} and chat ${CHAT}`),
      message(6, `/weather ${CHAT}`),
      message(7, `/concept ${TOKEN}`),
    ]);
    const result = await runInbox(deps(root, updates, sender, leaky).inboxDeps);
    expect(sender.sent[1]).toBe('שירות המיקום (geocoding-api.open-meteo.com) לא זמין כרגע');
    expect(sender.sent[2]).toBe('נוסף לתור: "[REDACTED]", מקום 2');
    const written = Object.values(await snapshot(root)).join('\n');
    const output = [...sender.sent, ...result.errors, summaryLine(result), written].join('\n');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(CHAT);
    expect(output).not.toContain('AAH-secret-token');
  });

  it('on a first run ignores messages older than 24 hours and asks for at most 20 updates', async () => {
    const root = await makeRoot();
    const sender = new FakeSender();
    const updates = new FakeUpdates([
      message(40, 'old', { date: nowS - 25 * 3600 }),
      message(41, 'new'),
      { updateId: 42, message: null },
    ]);
    const result = await runInbox(deps(root, updates, sender).inboxDeps);
    expect(updates.calls).toEqual([[null, 20]]);
    expect(result).toMatchObject({ stale: 1, feedback: 1, offset: 43 });
    expect(sender.sent).toEqual([THANKS]);
    expect(await readJson(join(root, 'state', 'telegram-offset.json'))).toEqual({ offset: 43 });
  });

  it('a failed reply is counted as an error and the offset still advances', async () => {
    const root = await makeRoot(1);
    const sender: Sender = {
      name: 'down',
      send: async () => {
        throw new Error('sendMessage HTTP 502');
      },
    };
    const result = await runInbox(
      deps(root, new FakeUpdates([message(1, '/help')]), sender).inboxDeps,
    );
    expect(result.errors).toEqual(['sendMessage HTTP 502']);
    expect(result.offset).toBe(2);
  });
});
