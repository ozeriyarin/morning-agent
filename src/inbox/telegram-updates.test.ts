import { describe, expect, it } from 'vitest';
import { TelegramError } from '../deliver/telegram.js';
import { mapUpdates, TelegramUpdatesClient } from './telegram-updates.js';

// Shaped like a Bot API getUpdates reply.
const response = {
  ok: true,
  result: [
    {
      update_id: 501,
      message: {
        message_id: 9,
        date: 1791622800,
        chat: { id: 987654321, type: 'private' },
        text: '👎 desk tips',
        reply_to_message: {
          message_id: 8,
          date: 1791604800,
          from: { id: 1, is_bot: true },
          text: 'בוקר טוב\nAI היום',
        },
      },
    },
    { update_id: 502, message: { message_id: 10, date: 1791622900, chat: { id: 5 }, text: 'hi' } },
    { update_id: 503, message: { message_id: 11, date: 1791623000, chat: { id: 5 } } },
    { update_id: 504, edited_message: { message_id: 10 } },
  ],
};

describe('telegram updates', () => {
  it('maps text messages and keeps non-text updates for the offset', () => {
    expect(mapUpdates(response)).toEqual([
      {
        updateId: 501,
        message: {
          chatId: '987654321',
          date: 1791622800,
          text: '👎 desk tips',
          replyTo: { fromBot: true, date: 1791604800, text: 'בוקר טוב\nAI היום' },
        },
      },
      { updateId: 502, message: { chatId: '5', date: 1791622900, text: 'hi', replyTo: null } },
      { updateId: 503, message: null },
      { updateId: 504, message: null },
    ]);
  });

  it('posts the offset and the limit to getUpdates, omitting a missing offset', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, result: [] });
    };
    const client = new TelegramUpdatesClient('1:tok', fetchFn);
    expect(await client.getUpdates(77, 20)).toEqual([]);
    await client.getUpdates(null, 20);
    expect(calls[0]?.url).toBe('https://api.telegram.org/bot1:tok/getUpdates');
    expect(calls[0]?.body).toEqual({
      offset: 77,
      limit: 20,
      timeout: 0,
      allowed_updates: ['message'],
    });
    expect(calls[1]?.body).not.toHaveProperty('offset');
  });

  it('throws a TelegramError without the token on HTTP or shape failures', async () => {
    const down: typeof fetch = async () => new Response('nope', { status: 401 });
    const error = await new TelegramUpdatesClient('1:tok', down).getUpdates(1, 20).catch((e) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect(String(error)).not.toContain('1:tok');
    expect(() => mapUpdates({ ok: false })).toThrow(TelegramError);
  });
});
