import { describe, expect, it } from 'vitest';
import type { Prices } from './config.js';
import { priceCall, totalCost } from './cost.js';
import type { CallUsage } from './types.js';

const prices: Prices = {
  asOf: '2026-10-10',
  models: { m: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
};

const call = (over: Partial<CallUsage>): CallUsage => ({
  role: 'writer',
  model: 'm',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 1,
  ...over,
});

describe('cost', () => {
  it.each([
    [{ inputTokens: 1_000_000 }, 2],
    [{ outputTokens: 1_000_000 }, 10],
    [{ cacheReadTokens: 1_000_000 }, 0.2],
    [{ cacheWriteTokens: 1_000_000 }, 2.5],
    [{ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 }, 0.0074],
  ])('prices %j at $%f', (over, usd) => {
    expect(priceCall(call(over), prices).costUsd).toBeCloseTo(usd, 10);
  });

  it('fails loudly for a model missing from the price table', () => {
    expect(() => priceCall(call({ model: 'unknown' }), prices)).toThrow('no price for model');
  });

  it('totals per-call costs', () => {
    const calls = [
      priceCall(call({ inputTokens: 1000 }), prices),
      priceCall(call({ outputTokens: 1000 }), prices),
    ];
    expect(totalCost(calls)).toBeCloseTo(0.012, 10);
  });
});
