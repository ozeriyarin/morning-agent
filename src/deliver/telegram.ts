import type { Sender, SendResult } from '../types.js';

const MAX_ATTEMPTS = 2;

export class TelegramError extends Error {
  override name = 'TelegramError';

  readonly retryable: boolean;
  readonly attempts: number;

  constructor(
    message: string,
    options: ErrorOptions & { retryable?: boolean; attempts?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.retryable = options.retryable ?? false;
    this.attempts = options.attempts ?? 1;
  }
}

export class TelegramSender implements Sender {
  readonly name = 'telegram';

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchFn: typeof fetch,
    private readonly timeoutMs = 15_000,
    private readonly retryDelayMs = 2_000,
  ) {}

  // A network error, a timeout, a 429 or a 5xx is retried once; other 4xx will not get better.
  async send(html: string): Promise<SendResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.post(html, attempt);
        return { status: 'sent', attempts: attempt };
      } catch (error) {
        if (!(error instanceof TelegramError && error.retryable) || attempt === MAX_ATTEMPTS)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }

  private async post(html: string, attempt: number): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
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
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // Keeps the original cause so the record reads exactly as a direct fetch failure did.
      throw new TelegramError(failure.message, {
        cause: failure.cause,
        retryable: true,
        attempts: attempt,
      });
    }
    if (!res.ok) {
      const body = await res.text();
      const retryable = res.status === 429 || res.status >= 500;
      throw new TelegramError(`sendMessage HTTP ${res.status}: ${body.slice(0, 200)}`, {
        retryable,
        attempts: attempt,
      });
    }
  }
}
