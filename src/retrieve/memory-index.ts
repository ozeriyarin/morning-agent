import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { evalId, type EvalSet } from '../eval/eval-set.js';
import type { StoredRecord } from '../records.js';
import { collectItems } from '../replay/replay.js';
import { readQueue } from '../sources/concepts.js';
import { normalizeTitle } from '../sources/feeds.js';
import { DECISIONS } from '../types.js';
import { VOYAGE_MODEL, type Embedder } from './embed.js';

const chunkSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['news', 'concept']),
    text: z.string(),
    date: z.string(),
    vector: z.array(z.number()),
    meta: z
      .object({
        title: z.string().optional(),
        link: z.string().optional(),
        decision: z.enum(DECISIONS).optional(),
        label: z.enum(DECISIONS).optional(),
        name: z.string().optional(),
      })
      .strict(),
  })
  .strict();
const indexSchema = z
  .object({
    version: z.literal(1),
    model: z.string(),
    dims: z.number().int().nonnegative(),
    chunks: z.array(chunkSchema),
  })
  .strict();

export type MemoryChunk = z.infer<typeof chunkSchema>;
export type MemoryIndex = z.infer<typeof indexSchema>;
type Candidate = Omit<MemoryChunk, 'vector'>;

export const EMPTY_INDEX: MemoryIndex = { version: 1, model: VOYAGE_MODEL, dims: 0, chunks: [] };

// Null when the file does not exist; an unreadable or invalid file throws.
export async function loadIndex(path: string): Promise<MemoryIndex | null> {
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  return text === null ? null : indexSchema.parse(JSON.parse(text));
}

export async function saveIndex(path: string, index: MemoryIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(indexSchema.parse(index), null, 2)}\n`);
}

export interface MemorySources {
  runs: StoredRecord[];
  evalSet: EvalSet;
  queue: string;
}

const labelsOf = (set: EvalSet) => new Map(set.items.map((i) => [evalId(i.title), i.label]));

// Only titles, links, decisions, labels and concept names leave the sources.
function candidates({ runs, evalSet, queue }: MemorySources): Candidate[] {
  const labels = labelsOf(evalSet);
  const news = collectItems(runs).map(({ date, item, original }): Candidate => {
    const id = evalId(item.title);
    const label = labels.get(id);
    const meta = { title: item.title, link: item.link };
    return {
      id,
      kind: 'news',
      text: item.title,
      date,
      meta: { ...meta, ...(original && { decision: original }), ...(label && { label }) },
    };
  });
  const concepts = readQueue(queue).flatMap(({ name, usedOn }): Candidate[] =>
    usedOn === null
      ? []
      : [
          {
            id: `concept:${normalizeTitle(name)}`,
            kind: 'concept',
            text: name,
            date: usedOn,
            meta: { name },
          },
        ],
  );
  const seen = new Set<string>();
  return [...news, ...concepts].filter((c) => !seen.has(c.id) && seen.add(c.id));
}

// Summary: embeds only ids not yet in the index and appends them.
// Details: labels arrive after an item is indexed, so existing news chunks take the eval label.
export async function buildIndex(
  index: MemoryIndex,
  sources: MemorySources,
  embedder: Embedder,
): Promise<{ index: MemoryIndex; added: number }> {
  const labels = labelsOf(sources.evalSet);
  const chunks = index.chunks.map((chunk) => {
    const label = chunk.kind === 'news' ? labels.get(chunk.id) : undefined;
    return label ? { ...chunk, meta: { ...chunk.meta, label } } : chunk;
  });
  const known = new Set(chunks.map((c) => c.id));
  const fresh = candidates(sources).filter((c) => !known.has(c.id));
  if (fresh.length === 0) return { index: { ...index, chunks }, added: 0 };
  const { vectors } = await embedder.embed(
    fresh.map((c) => c.text),
    'document',
  );
  const dims = vectors[0]?.length ?? 0;
  if (vectors.some((v) => v.length !== (index.dims || dims)))
    throw new Error(`embedding dims ${dims} do not match the index dims ${index.dims}`);
  const added = fresh.map((c, i) => ({ ...c, vector: vectors[i] ?? [] }));
  return {
    index: { ...index, dims: index.dims || dims, chunks: [...chunks, ...added] },
    added: added.length,
  };
}
