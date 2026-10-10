import type { Sender, SendResult } from '../types.js';

export class TelegramError extends Error {
  override name = 'TelegramError';
}

export class TelegramSender implements Sender {
  readonly name = 'telegram';

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchFn: typeof fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async send(html: string): Promise<SendResult> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new TelegramError(`sendMessage HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return { status: 'sent' };
  }
}
