import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesClient } from '../cost.js';

export interface FakeClient extends MessagesClient {
  requests: Anthropic.MessageCreateParamsNonStreaming[];
}

export const usage = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 800,
  cache_creation_input_tokens: 0,
};

export function fakeClient(
  content: unknown[],
  stopReason: Anthropic.StopReason = 'end_turn',
): FakeClient {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    messages: {
      async create(body) {
        requests.push(body);
        return { content, stop_reason: stopReason, usage } as unknown as Anthropic.Message;
      },
    },
  };
}
