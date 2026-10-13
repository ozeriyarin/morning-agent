import { describe, expect, it, vi } from 'vitest';
import { EMBED_BATCH, FakeEmbedder, VOYAGE_MODEL, VOYAGE_URL, VoyageEmbedder } from './embed.js';

const reply = (count: number, tokens = 10) =>
  new Response(
    JSON.stringify({
      data: Array.from({ length: count }, (_, i) => ({ embedding: [i, 1], index: i })).reverse(),
      usage: { total_tokens: tokens },
    }),
  );

const body = (fetchFn: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(String((fetchFn.mock.calls[call]?.[1] as RequestInit).body)) as {
    input: string[];
    model: string;
    input_type: string;
  };

describe('VoyageEmbedder', () => {
  it('posts the model, input type and key, and returns vectors in index order with usage', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => reply(2, 7));
    const result = await new VoyageEmbedder('pa-synthetic', fetchFn).embed(['a', 'b'], 'query');
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(VOYAGE_URL);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer pa-synthetic');
    expect(body(fetchFn)).toEqual({ input: ['a', 'b'], model: VOYAGE_MODEL, input_type: 'query' });
    expect(result.vectors).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(result.calls).toEqual([
      expect.objectContaining({
        role: 'embed',
        model: VOYAGE_MODEL,
        inputTokens: 7,
        outputTokens: 0,
      }),
    ]);
  });

  it('sends at most 128 texts per call', async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) =>
      reply((JSON.parse(String(init?.body)) as { input: string[] }).input.length),
    );
    const texts = Array.from({ length: EMBED_BATCH + 2 }, (_, i) => `t${i}`);
    const result = await new VoyageEmbedder('k', fetchFn).embed(texts, 'document');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(body(fetchFn, 0).input).toHaveLength(EMBED_BATCH);
    expect(body(fetchFn, 1).input).toEqual([`t${EMBED_BATCH}`, `t${EMBED_BATCH + 1}`]);
    expect(result.vectors).toHaveLength(EMBED_BATCH + 2);
    expect(result.calls).toHaveLength(2);
  });

  it('retries a 429 or 5xx once, then throws without echoing the key', async () => {
    const flaky = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(reply(1));
    const ok = new VoyageEmbedder('k', flaky, { retryDelayMs: 0 });
    expect((await ok.embed(['a'], 'query')).vectors).toHaveLength(1);
    const down = vi.fn<typeof fetch>(async () => new Response('', { status: 503 }));
    const failing = new VoyageEmbedder('pa-secret', down, { retryDelayMs: 0 });
    const error: unknown = await failing.embed(['a'], 'query').catch((e: unknown) => e);
    expect(down).toHaveBeenCalledTimes(2);
    expect(String(error)).toContain('HTTP 503');
    expect(String(error)).not.toContain('pa-secret');
  });

  it('rejects a response with the wrong number of vectors', async () => {
    const short = vi.fn<typeof fetch>(async () => reply(1));
    await expect(new VoyageEmbedder('k', short).embed(['a', 'b'], 'query')).rejects.toThrow(
      'unexpected shape',
    );
  });
});

describe('FakeEmbedder', () => {
  it('is deterministic per text, sized to its dims and makes no calls', async () => {
    const fake = new FakeEmbedder(4);
    const first = await fake.embed(['a', 'b', 'a']);
    expect(first.vectors[0]).toEqual(first.vectors[2]);
    expect(first.vectors[0]).not.toEqual(first.vectors[1]);
    expect(first.vectors[0]).toHaveLength(4);
    expect(first.calls).toEqual([]);
  });
});
