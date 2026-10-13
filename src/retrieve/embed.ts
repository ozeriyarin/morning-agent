import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CallUsage } from '../types.js';

export const VOYAGE_MODEL = 'voyage-3.5-lite';
export const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
export const EMBED_BATCH = 128;
const FAKE_DIMS = 8;

export type InputType = 'document' | 'query';

export interface Embedding {
  vectors: number[][];
  calls: CallUsage[];
}

export interface Embedder {
  readonly model: string;
  embed(texts: string[], inputType: InputType): Promise<Embedding>;
}

class VoyageError extends Error {
  override name = 'VoyageError';
}

const responseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
  usage: z.object({ total_tokens: z.number() }),
});

const retryable = (status: number) => status === 429 || status >= 500;

interface VoyageOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
}

// One call per batch of 128 texts; a 429/5xx is retried once, priced as input tokens.
export class VoyageEmbedder implements Embedder {
  readonly model = VOYAGE_MODEL;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch,
    options: VoyageOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  async embed(texts: string[], inputType: InputType): Promise<Embedding> {
    const result: Embedding = { vectors: [], calls: [] };
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const { vectors, call } = await this.batch(texts.slice(i, i + EMBED_BATCH), inputType);
      result.vectors.push(...vectors);
      result.calls.push(call);
    }
    return result;
  }

  private async batch(input: string[], inputType: InputType) {
    const started = performance.now();
    const body = JSON.stringify({ input, model: this.model, input_type: inputType });
    let response = await this.post(body);
    if (retryable(response.status)) {
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      response = await this.post(body);
    }
    if (!response.ok) throw new VoyageError(`voyage embeddings returned HTTP ${response.status}`);
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.data.length !== input.length)
      throw new VoyageError('voyage embeddings response has an unexpected shape');
    const vectors = [...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    const call: CallUsage = {
      role: 'embed',
      model: this.model,
      inputTokens: parsed.data.usage.total_tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: performance.now() - started,
    };
    return { vectors, call };
  }

  private post(body: string): Promise<Response> {
    return this.fetchFn(VOYAGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

// Deterministic offline vectors from a hash of the text: equal texts score 1, others at random.
export class FakeEmbedder implements Embedder {
  readonly model = 'fake';

  constructor(private readonly dims = FAKE_DIMS) {}

  async embed(texts: string[]): Promise<Embedding> {
    return { vectors: texts.map((text) => fakeVector(text, this.dims)), calls: [] };
  }
}

function fakeVector(text: string, dims = FAKE_DIMS): number[] {
  const bytes = createHash('sha256').update(text).digest();
  return Array.from({ length: dims }, (_, i) => (bytes[i % bytes.length] ?? 0) / 127.5 - 1);
}
