import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addConcept, FileConceptStore, markUsed, nextConcept, readQueue } from './concepts.js';

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

  it('the committed queue parses, starts with agent loop and has no duplicate names', async () => {
    const entries = readQueue(await readFile('concepts/queue.md', 'utf8'));
    expect(entries.length).toBeGreaterThanOrEqual(15);
    expect(entries[0]?.name).toBe('agent loop');
    const names = entries.map((e) => e.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('FileConceptStore reads and rewrites the file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'queue-')), 'queue.md');
    await writeFile(path, queue);
    const store = new FileConceptStore(path);
    expect(await store.next()).toBe('tool calling');
    await store.markUsed('tool calling', '2026-10-10');
    expect(await store.next()).toBe('RAG');
  });

  it('addConcept appends a missing concept with the file line ending and reports its position', () => {
    const crlf = queue.replace(/\n/g, '\r\n');
    const added = addConcept(crlf, 'MCP');
    expect(added).toMatchObject({ added: true, position: 3, entry: { name: 'MCP', usedOn: null } });
    expect(added.markdown).toBe(`${crlf}- [ ] MCP\r\n`);
    expect(addConcept('- [ ] RAG', 'MCP').markdown).toBe('- [ ] RAG\n- [ ] MCP\n');
  });

  it('addConcept leaves a present concept alone, matching case-insensitively', () => {
    expect(addConcept(queue, 'rag')).toEqual({
      markdown: queue,
      added: false,
      entry: { name: 'RAG', usedOn: null },
      position: 2,
    });
    expect(addConcept(queue, 'Agent Loop')).toMatchObject({ added: false, position: null });
  });
});
