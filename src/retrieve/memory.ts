import type { MemoryConfig } from '../config.js';
import { addDays } from '../dates.js';
import { evalId } from '../eval/eval-set.js';
import { SourceError, type CallUsage, type DecisionExample, type Item } from '../types.js';
import type { Embedder } from './embed.js';
import { loadIndex } from './memory-index.js';
import { search, type Hit } from './search.js';

const RELATED = { k: 2, minScore: 0.6 };

export interface Recall {
  indexSize: number;
  seenBefore: Map<string, { title: string; link: string; date: string; score: number }>;
  examples: Map<string, DecisionExample[]>;
  relatedConcepts: { name: string; score: number }[];
  chunkIds: string[];
  calls: CallUsage[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Summary: one index load and one query embedding per run, keyed by item id.
// Details: any failure becomes a SourceError('memory'), so the run records it and goes on.
export class MemorySource {
  readonly name = 'memory';

  constructor(
    private readonly indexPath: string,
    private readonly embedder: Embedder,
    private readonly config: MemoryConfig,
  ) {}

  async recall(date: string, items: Item[], concept: string | null): Promise<Recall> {
    try {
      return await this.lookup(date, items, concept);
    } catch (error) {
      throw new SourceError('memory', message(error));
    }
  }

  private async lookup(date: string, items: Item[], concept: string | null): Promise<Recall> {
    const index = await loadIndex(this.indexPath);
    if (!index) throw new Error('memory index not found');
    const recall: Recall = {
      indexSize: index.chunks.length,
      seenBefore: new Map(),
      examples: new Map(),
      relatedConcepts: [],
      chunkIds: [],
      calls: [],
    };
    const texts = [...items.map((i) => i.title), ...(concept === null ? [] : [concept])];
    if (index.chunks.length === 0 || texts.length === 0) return recall;
    const { vectors, calls } = await this.embedder.embed(texts, 'query');
    recall.calls = calls;
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== index.dims))
      throw new Error(`query embeddings do not match the index dims ${index.dims}`);
    const used = new Set<string>();
    const use = (hits: Hit[]) => hits.forEach((h) => used.add(h.chunk.id));
    const { seenThreshold, exampleThreshold, examples, seenDays } = this.config;
    items.forEach((item, i) => {
      const query = vectors[i] ?? [];
      const seen = search(index, query, {
        kind: 'news',
        k: 2,
        minScore: seenThreshold,
        before: date,
        after: addDays(date, -seenDays),
      }).find((h) => h.chunk.id !== evalId(item.title));
      if (seen) {
        use([seen]);
        const { title = seen.chunk.text, link = '' } = seen.chunk.meta;
        recall.seenBefore.set(item.id, { title, link, date: seen.chunk.date, score: seen.score });
      }
      const labelled = search(index, query, {
        kind: 'news',
        labelled: true,
        k: examples,
        minScore: exampleThreshold,
      });
      if (labelled.length === 0) return;
      use(labelled);
      recall.examples.set(
        item.id,
        labelled.map((h) => ({
          title: h.chunk.meta.title ?? h.chunk.text,
          label: h.chunk.meta.label ?? 'skip',
          score: h.score,
        })),
      );
    });
    if (concept !== null) {
      const related = search(index, vectors[items.length] ?? [], { kind: 'concept', ...RELATED });
      use(related);
      recall.relatedConcepts = related.map((h) => ({
        name: h.chunk.meta.name ?? h.chunk.text,
        score: h.score,
      }));
    }
    recall.chunkIds = [...used];
    return recall;
  }
}
