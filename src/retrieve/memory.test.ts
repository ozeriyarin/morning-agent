import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { briefConfigSchema } from '../config.js';
import { evalId } from '../eval/eval-set.js';
import { SourceError, type Item } from '../types.js';
import type { Embedder } from './embed.js';
import { saveIndex, type MemoryChunk } from './memory-index.js';
import { MemorySource } from './memory.js';

const TODAY = '2026-10-14';
const { memory: config } = briefConfigSchema.parse({
  recipient: 'r',
  language: 'he',
  location: { name: 'x', latitude: 0, longitude: 0, timezone: 'Asia/Jerusalem' },
  schedule: { localTime: '07:00' },
  feeds: [{ name: 'f', url: 'https://example.com/feed' }],
});

// Hand-built 2-d vectors: the angle from [1, 0] sets each cosine score.
const at = (score: number) => [score, Math.sqrt(1 - score * score)];
const QUERY = [1, 0];

const item = (title: string): Item => ({
  id: `https://example.com/${encodeURIComponent(title)}`,
  title,
  link: `https://example.com/${encodeURIComponent(title)}`,
  published: '2026-10-14T03:00:00.000Z',
  summary: '',
  sources: ['Example'],
});

const news = (id: string, score: number, over: Partial<MemoryChunk> = {}): MemoryChunk => ({
  id,
  kind: 'news',
  text: id,
  date: '2026-10-10',
  vector: at(score),
  meta: { title: `title ${id}`, link: `https://example.com/past/${id}` },
  ...over,
});

const embedder = (vectors: Record<string, number[]> = {}): Embedder & { texts: string[][] } => ({
  model: 'stub',
  texts: [],
  async embed(texts) {
    this.texts.push(texts);
    return { vectors: texts.map((t) => vectors[t] ?? QUERY), calls: [] };
  },
});

let path: string;
const withIndex = async (chunks: MemoryChunk[]) =>
  saveIndex(path, { version: 1, model: 'stub', dims: 2, chunks });

beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), 'memory-')), 'memory', 'index.json');
});

describe('MemorySource', () => {
  it('v13 criterion 3: "A must-read whose nearest past news chunk scores ≥ 0.8 and is dated before today gets `seenBefore` with that chunk\'s title and date; a chunk dated today or scoring below the threshold does not."', async () => {
    const source = new MemorySource(path, embedder(), config);
    const day = [item('Claude ships memory')];
    await withIndex([news('past', 0.85), news('weaker', 0.82)]);
    const seen = (await source.recall(TODAY, day, null)).seenBefore.get(day[0]?.id ?? '');
    expect(seen).toMatchObject({ title: 'title past', date: '2026-10-10' });
    expect(seen?.score).toBeCloseTo(0.85);

    await withIndex([news('today', 0.99, { date: TODAY }), news('low', 0.79)]);
    expect((await source.recall(TODAY, day, null)).seenBefore.size).toBe(0);
  });

  it('never marks an item as a follow-up of itself, nor of a chunk older than seenDays', async () => {
    const day = [item('Claude ships memory')];
    await withIndex([
      news(evalId('Claude ships memory'), 1),
      news('old', 0.95, { date: '2026-09-01' }),
    ]);
    const recall = await new MemorySource(path, embedder(), config).recall(TODAY, day, null);
    expect(recall.seenBefore.size).toBe(0);
  });

  it('v13 criterion 4: "Decisions receive at most `examples` labelled chunks each, ordered by score, and the Haiku prompt contains an `Examples` block with `"<title>" → <label>` lines; with no labelled chunks the block is absent and the prompt is byte-identical to v12." (retrieval)', async () => {
    await withIndex([
      news('a', 0.7, { meta: { title: 'A', label: 'skip' } }),
      news('b', 0.95, { meta: { title: 'B', label: 'must_read' } }),
      news('c', 0.65, { meta: { title: 'C', label: 'mention' } }),
      news('d', 0.9, { meta: { title: 'D', label: 'mention' } }),
      news('unlabelled', 0.99),
      news('below', 0.5, { meta: { title: 'E', label: 'skip' } }),
    ]);
    const day = [item('x'), item('y')];
    const recall = await new MemorySource(path, embedder({ y: [-1, 0] }), config).recall(
      TODAY,
      day,
      null,
    );
    expect(recall.examples.get(day[0]?.id ?? '')?.map((e) => [e.title, e.label])).toEqual([
      ['B', 'must_read'],
      ['D', 'mention'],
      ['A', 'skip'],
    ]);
    expect(recall.examples.has(day[1]?.id ?? '')).toBe(false);
  });

  it('finds up to two related concepts and embeds every query in one call', async () => {
    const concept = (name: string, score: number): MemoryChunk => ({
      id: `concept:${name}`,
      kind: 'concept',
      text: name,
      date: '2026-10-12',
      vector: at(score),
      meta: { name },
    });
    await withIndex([
      concept('RAG', 0.9),
      concept('agent loop', 0.7),
      concept('far', 0.3),
      concept('mid', 0.65),
    ]);
    const stub = embedder();
    const recall = await new MemorySource(path, stub, config).recall(
      TODAY,
      [item('x')],
      'embeddings',
    );
    expect(recall.relatedConcepts.map((c) => c.name)).toEqual(['RAG', 'agent loop']);
    expect(recall.chunkIds).toEqual(['concept:RAG', 'concept:agent loop']);
    expect(stub.texts).toEqual([['x', 'embeddings']]);
  });

  it('makes no embed call for an empty index, and a missing index throws a memory SourceError', async () => {
    const stub = embedder();
    await withIndex([]);
    const recall = await new MemorySource(path, stub, config).recall(TODAY, [item('x')], 'c');
    expect(recall).toMatchObject({ indexSize: 0, chunkIds: [] });
    expect(stub.texts).toEqual([]);
    const missing = new MemorySource(join(path, '..', 'none.json'), stub, config);
    const error: unknown = await missing.recall(TODAY, [item('x')], null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ source: 'memory', message: 'memory index not found' });
  });
});
