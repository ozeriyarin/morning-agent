import { z } from 'zod';
import { TelegramError } from '../deliver/telegram.js';

const messageSchema = z.object({
  date: z.number(),
  chat: z.object({ id: z.union([z.number(), z.string()]) }),
  text: z.string().optional(),
  reply_to_message: z
    .object({
      date: z.number(),
      text: z.string().optional(),
      from: z.object({ is_bot: z.boolean() }).optional(),
    })
    .optional(),
});

const updatesSchema = z.object({
  ok: z.literal(true),
  result: z.array(z.object({ update_id: z.number(), message: messageSchema.optional() })),
});

export interface InboxMessage {
  chatId: string;
  date: number;
  text: string;
  replyTo: { fromBot: boolean; date: number; text: string } | null;
}

export interface TelegramUpdate {
  updateId: number;
  message: InboxMessage | null;
}

export interface UpdatesSource {
  getUpdates(offset: number | null, limit: number): Promise<TelegramUpdate[]>;
}

// Only text messages matter; other update kinds still advance the offset.
export function mapUpdates(response: unknown): TelegramUpdate[] {
  const parsed = updatesSchema.safeParse(response);
  if (!parsed.success) throw new TelegramError('getUpdates: unexpected response shape');
  return parsed.data.result.map(({ update_id, message: m }) => ({
    updateId: update_id,
    message:
      m?.text === undefined
        ? null
        : {
            chatId: String(m.chat.id),
            date: m.date,
            text: m.text,
            replyTo: m.reply_to_message
              ? {
                  fromBot: m.reply_to_message.from?.is_bot ?? false,
                  date: m.reply_to_message.date,
                  text: m.reply_to_message.text ?? '',
                }
              : null,
          },
  }));
}

export class TelegramUpdatesClient implements UpdatesSource {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async getUpdates(offset: number | null, limit: number): Promise<TelegramUpdate[]> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(offset !== null && { offset }),
        limit,
        timeout: 0,
        allowed_updates: ['message'],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new TelegramError(`getUpdates HTTP ${res.status}`);
    return mapUpdates(await res.json());
  }
}
