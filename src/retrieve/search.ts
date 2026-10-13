import type { MemoryChunk, MemoryIndex } from './memory-index.js';

export interface SearchOptions {
  kind?: MemoryChunk['kind'];
  k: number;
  minScore?: number;
  before?: string;
  after?: string;
  labelled?: boolean;
}

export interface Hit {
  chunk: MemoryChunk;
  score: number;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Top-k by cosine similarity; `before` is exclusive and `after` inclusive, both on chunk dates.
export function search(index: MemoryIndex, query: number[], opts: SearchOptions): Hit[] {
  return index.chunks
    .filter(
      (c) =>
        (opts.kind === undefined || c.kind === opts.kind) &&
        (opts.before === undefined || c.date < opts.before) &&
        (opts.after === undefined || c.date >= opts.after) &&
        (!opts.labelled || c.meta.label !== undefined),
    )
    .map((chunk) => ({ chunk, score: cosine(chunk.vector, query) }))
    .filter((hit) => hit.score >= (opts.minScore ?? -1))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.k);
}
