import type Anthropic from '@anthropic-ai/sdk';
import type { Prices } from './config.js';
import type { CallRecord, CallUsage } from './types.js';

export interface MessagesClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export function callUsage(
  role: CallUsage['role'],
  model: string,
  usage: Anthropic.Usage,
  latencyMs: number,
): CallUsage {
  return {
    role,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    latencyMs,
  };
}

export function priceCall(call: CallUsage, prices: Prices): CallRecord {
  if (call.costUsd !== undefined) return { ...call, costUsd: call.costUsd };
  const p = prices.models[call.model];
  if (!p) throw new Error(`no price for model ${call.model} in config/prices.json`);
  const micro =
    call.inputTokens * p.input +
    call.outputTokens * p.output +
    call.cacheReadTokens * p.cacheRead +
    call.cacheWriteTokens * p.cacheWrite;
  return { ...call, costUsd: micro / 1_000_000 };
}

export function totalCost(calls: CallRecord[]): number {
  return calls.reduce((sum, call) => sum + call.costUsd, 0);
}
