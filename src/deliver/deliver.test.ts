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
    expect(result).toEqual({ status: 'sent', attempts: 1 });
    expect(calls[0]?.url).toBe('https://api.telegram.org/bot1:tok/sendMessage');
    expect(calls[0]?.body).toMatchObject({ chat_id: '42', text: '<b>hi</b>', parse_mode: 'HTML' });
  });

  const scripted = (...replies: (number | Error)[]) => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      const reply = replies[calls++] ?? 200;
      if (reply instanceof Error) throw reply;
      return new Response(reply === 200 ? '{"ok":true}' : 'nope', { status: reply });
    };
    return { fetchFn, calls: () => calls };
  };
  const sender = (fetchFn: typeof fetch) => new TelegramSender('1:tok', '42', fetchFn, 15_000, 0);

  it('v10 criterion 5: "The Telegram sender retries once on a 500, a 429 and a network error, and succeeds on the second attempt with `attempts: 2`; it does not retry a 400 or a 401 and throws after one attempt."', async () => {
    for (const first of [500, 429, new TypeError('fetch failed')]) {
      const fake = scripted(first, 200);
      expect(await sender(fake.fetchFn).send('x')).toEqual({ status: 'sent', attempts: 2 });
      expect(fake.calls()).toBe(2);
    }
    for (const status of [400, 401]) {
      const fake = scripted(status, 200);
      const error: unknown = await sender(fake.fetchFn)
        .send('x')
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'TelegramError', attempts: 1, retryable: false });
      expect(fake.calls()).toBe(1);
    }
  });

  it('waits retryDelayMs before the retry and gives up after the second failure', async () => {
    const fake = scripted(503, 502);
    const started = performance.now();
    const failing = new TelegramSender('1:tok', '42', fake.fetchFn, 15_000, 30);
    const error: unknown = await failing.send('x').catch((e: unknown) => e);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(error).toMatchObject({ attempts: 2, message: expect.stringContaining('HTTP 502') });
    expect(fake.calls()).toBe(2);
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
      attempts: 1,
    });
    expect(printed).toEqual(['hello']);
  });
});
