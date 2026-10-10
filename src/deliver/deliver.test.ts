import { describe, expect, it } from 'vitest';
import { ConsoleSender } from './console.js';
import { TelegramError, TelegramSender } from './telegram.js';

describe('TelegramSender', () => {
  it('posts the brief as HTML to sendMessage', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    };
    const result = await new TelegramSender('1:tok', '42', fetchFn).send('<b>hi</b>');
    expect(result).toEqual({ status: 'sent' });
    expect(calls[0]?.url).toBe('https://api.telegram.org/bot1:tok/sendMessage');
    expect(calls[0]?.body).toMatchObject({ chat_id: '42', text: '<b>hi</b>', parse_mode: 'HTML' });
  });

  it('throws a TelegramError on a non-2xx reply', async () => {
    const fetchFn: typeof fetch = async () => new Response('Bad Request', { status: 400 });
    await expect(new TelegramSender('1:tok', '42', fetchFn).send('x')).rejects.toThrow(
      TelegramError,
    );
  });
});

describe('ConsoleSender', () => {
  it('prints the brief', async () => {
    const printed: string[] = [];
    expect(await new ConsoleSender((t) => printed.push(t)).send('hello')).toEqual({
      status: 'printed',
    });
    expect(printed).toEqual(['hello']);
  });
});
