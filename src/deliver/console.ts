import type { Sender, SendResult } from '../types.js';

export class ConsoleSender implements Sender {
  readonly name = 'console';

  constructor(private readonly print: (text: string) => void = console.log) {}

  async send(html: string): Promise<SendResult> {
    this.print(html);
    return { status: 'printed', attempts: 1 };
  }
}
