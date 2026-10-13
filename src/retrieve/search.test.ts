import { describe, expect, it } from 'vitest';
import type { MemoryChunk, MemoryIndex } from './memory-index.js';
import { cosine, search } from './search.js';

const chunk = (id: string, vector: number[], over: Partial<MemoryChunk> = {}): MemoryChunk => ({
  id,
  kind: 'news',
  text: id,
  date: '2026-10-10',
  vector,
  meta: { title: id },
  ...over,
});

const index: MemoryIndex = {
  version: 1,
  model: 'test',
  dims: 2,
  chunks: [
    chunk('same', [1, 0]),
    chunk('close', [0.9, 0.1]),
    chunk('diagonal', [1, 1]),
    chunk('orthogonal', [0, 1]),
    chunk('concept', [1, 0], { kind: 'concept', meta: { name: 'concept' } }),
    chunk('today', [1, 0.05], { date: '2026-10-14' }),
  ],
};

const ids = (hits: { chunk: MemoryChunk }[]) => hits.map((h) => h.chunk.id);

describe('search', () => {
  it('v13 criterion 2: "`search` returns the top-k by cosine similarity, honours `kind` and `before` filters, and excludes chunks below `minScore` (pure unit test with hand-built vectors)."', () => {
    expect(ids(search(index, [1, 0], { k: 3 }))).toEqual(['same', 'concept', 'today']);
    expect(ids(search(index, [1, 0], { kind: 'news', k: 3 }))).toEqual(['same', 'today', 'close']);
    expect(ids(search(index, [1, 0], { kind: 'news', k: 2, before: '2026-10-14' }))).toEqual([
      'same',
      'close',
    ]);
    expect(ids(search(index, [1, 0], { kind: 'concept', k: 5 }))).toEqual(['concept']);
    const above = search(index, [1, 0], { kind: 'news', k: 10, minScore: 0.7 });
    expect(ids(above)).toEqual(['same', 'today', 'close', 'diagonal']);
    expect(above.map((h) => h.score)).toEqual([...above.map((h) => h.score)].sort((a, b) => b - a));
    expect(ids(search(index, [1, 0], { kind: 'news', k: 10, minScore: 0.8 }))).not.toContain(
      'diagonal',
    );
  });

  it('filters by an inclusive `after` date and by carrying a label', () => {
    const labelled = {
      ...index,
      chunks: [...index.chunks, chunk('l', [1, 0], { meta: { label: 'skip' } })],
    };
    expect(ids(search(labelled, [1, 0], { k: 5, after: '2026-10-11' }))).toEqual(['today']);
    expect(ids(search(labelled, [1, 0], { k: 5, labelled: true }))).toEqual(['l']);
  });

  it('cosine is 1 for parallel, 0 for orthogonal and for a zero vector', () => {
    expect(cosine([2, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 3])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});
