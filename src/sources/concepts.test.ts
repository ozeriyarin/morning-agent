import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileConceptStore, markUsed, nextConcept, readQueue } from './concepts.js';

const queue = [
  '# Concept queue',
  '',
  '- [x] 2026-10-09 agent loop',
  '- [ ] tool calling',
  '- [ ] RAG',
  '',
].join('\n');

describe('concept queue', () => {
  it('parses used and unused lines and ignores prose', () => {
    expect(readQueue(queue)).toEqual([
      { name: 'agent loop', usedOn: '2026-10-09' },
      { name: 'tool calling', usedOn: null },
      { name: 'RAG', usedOn: null },
    ]);
  });

  it('picks the first unused concept, or null when all are used', () => {
    expect(nextConcept(queue)).toBe('tool calling');
    expect(nextConcept('- [x] 2026-10-09 agent loop\n')).toBeNull();
  });

  it('marks only the chosen line with the date', () => {
    const next = markUsed(queue, 'tool calling', '2026-10-10');
    expect(next).toContain('- [x] 2026-10-10 tool calling');
    expect(next).toContain('- [ ] RAG');
    expect(nextConcept(next)).toBe('RAG');
  });

  it('the committed queue holds 15 concepts, starting with agent loop', async () => {
    const entries = readQueue(await readFile('concepts/queue.md', 'utf8'));
    expect(entries).toHaveLength(15);
    expect(entries[0]?.name).toBe('agent loop');
  });

  it('FileConceptStore reads and rewrites the file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'queue-')), 'queue.md');
    await writeFile(path, queue);
    const store = new FileConceptStore(path);
    expect(await store.next()).toBe('tool calling');
    await store.markUsed('tool calling', '2026-10-10');
    expect(await store.next()).toBe('RAG');
  });
});
