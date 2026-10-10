import { z } from 'zod';
import {
  DECISIONS,
  type Decision,
  type DecisionModel,
  type DecisionResult,
  type Item,
} from '../types.js';
import { DECISION_RULES, mapDecision } from './decision-model.js';

export const JEV_MODEL = 'typesafe/jev-1.13';
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

class JevError extends Error {
  override name = 'JevError';
}

const responseSchema = z.object({
  model: z.string(),
  answers: z.object({
    decision: z.object({
      choice: z.unknown(),
      confidence: z.number().optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
    }),
  }),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number().default(0),
    cost: z.number(),
  }),
});

// Instructions and criteria are cut from the same DECISION_RULES text Haiku gets, for parity.
function decisionQuestion() {
  const lines = DECISION_RULES.split('\n');
  const criterion = (d: Decision) =>
    lines.find((line) => line.startsWith(`- ${d}: `))?.slice(d.length + 4) ?? d;
  return {
    type: 'choice' as const,
    instructions: `${lines[0]} Classify state.item following state.rules.`,
    criteria: Object.fromEntries(DECISIONS.map((d) => [d, criterion(d)])) as Record<
      Decision,
      string
    >,
  };
}

function jevRequest(model: string, item: Item) {
  return {
    model,
    state: {
      item: {
        title: item.title,
        summary: item.summary,
        source: item.sources.join(', '),
        publishedAt: item.published,
      },
      rules: DECISION_RULES,
    },
    questions: { decision: decisionQuestion() },
  };
}

export interface JevOptions {
  model?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
}

const retryable = (status: number) => status === 429 || status >= 500;

// One OpenRouter decisions call per item; a 429/5xx is retried once, a timeout is not.
export class JevDecisionModel implements DecisionModel {
  readonly model: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch,
    options: JevOptions = {},
  ) {
    this.model = options.model ?? JEV_MODEL;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  async decide(item: Item): Promise<DecisionResult> {
    const started = performance.now();
    const body = JSON.stringify(jevRequest(this.model, item));
    let response = await this.post(body);
    if (retryable(response.status)) {
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      response = await this.post(body);
    }
    if (!response.ok) throw new JevError(`openrouter decisions returned HTTP ${response.status}`);
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success)
      throw new JevError('openrouter decisions response has an unexpected shape');
    const { model, answers, usage } = parsed.data;
    const { choice, confidence, probabilities } = answers.decision;
    return {
      ...mapDecision({ decision: choice }),
      ...(confidence !== undefined && { confidence }),
      ...(probabilities && { probabilities }),
      call: {
        role: 'decision',
        model,
        provider: 'openrouter',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencyMs: performance.now() - started,
        costUsd: usage.cost,
      },
    };
  }

  private post(body: string): Promise<Response> {
    return this.fetchFn(OPENROUTER_DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
