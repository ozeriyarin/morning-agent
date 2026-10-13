import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMemoryArgs, runMemory, type MemoryArgs } from './memory-cli.js';
import { FakeEmbedder, type Embedder } from './retrieve/embed.js';
import { loadIndex } from './retrieve/memory-index.js';

const QUEUE = '# Concept queue\n\n- [x] 2026-10-01 agent loop\n- [x] 2026-10-02 RAG\n- [ ] MCP\n';
const SUMMARY = 'private summary sentinel';
const build: MemoryArgs = { command: 'build', from: '2026-10-01', to: '2026-10-02', dryRun: false };

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memory-cli-'));
  await cp('test/fixtures/runs', join(root, 'runs'), { recursive: true });
  await cp('test/fixtures/feedback', join(root, 'feedback'), { recursive: true });
  await mkdir(join(root, 'eval'));
  await cp('test/fixtures/eval/decisions.json', join(root, 'eval', 'decisions.json'));
  await mkdir(join(root, 'concepts'));
  await writeFile(join(root, 'concepts', 'queue.md'), QUEUE);
  const first = join(root, 'runs', '2026-10-01.json');
  const record = JSON.parse(await readFile(first, 'utf8')) as { items: { summary?: string }[] };
  record.items.forEach((i) => (i.summary = SUMMARY));
  await writeFile(first, JSON.stringify(record));
  return root;
}

const counting = (): Embedder & { texts: string[] } => {
  const fake = new FakeEmbedder();
  const texts: string[] = [];
  return {
    model: 'counting',
    texts,
    embed: async (batch) => {
      texts.push(...batch);
      return fake.embed(batch);
    },
  };
};

describe('memory CLI', () => {
  it('v13 criterion 1: "`memory build` over fixture records, the eval fixture and a concept queue embeds each new id once (a second build adds nothing), stores decision and label in `meta`, and never stores feedback text or anything beyond title, link, decision, label, name (redaction test)."', async () => {
    const root = await fixtureRoot();
    const embedder = counting();
    expect(await runMemory(root, build, () => embedder)).toBe('added 7, index size 7\n');
    expect(await runMemory(root, build, () => embedder)).toBe('added 0, index size 7\n');
    expect(embedder.texts).toEqual([
      'Anthropic ships Claude Code hooks',
      'Startup raises $20M for LLM evals',
      'Ten tips for a tidy desk',
      'A benchmark of local models',
      'Weekend gardening notes',
      'agent loop',
      'RAG',
    ]);

    const index = await loadIndex(join(root, 'memory', 'index.json'));
    expect(index?.dims).toBe(8);
    const byText = new Map(index?.chunks.map((c) => [c.text, c]));
    expect(byText.get('Startup raises $20M for LLM evals')?.meta).toEqual({
      title: 'Startup raises $20M for LLM evals',
      link: 'https://example.com/a/raise',
      decision: 'skip',
      label: 'mention',
    });
    expect(byText.get('RAG')).toMatchObject({
      id: 'concept:rag',
      date: '2026-10-02',
      meta: { name: 'RAG' },
    });
    for (const chunk of index?.chunks ?? []) {
      expect(Object.keys(chunk).sort()).toEqual(['date', 'id', 'kind', 'meta', 'text', 'vector']);
      for (const key of Object.keys(chunk.meta))
        expect(['title', 'link', 'decision', 'label', 'name']).toContain(key);
    }
    const file = await readFile(join(root, 'memory', 'index.json'), 'utf8');
    for (const leak of [SUMMARY, 'Example Feed', 'chat_id', 'thanks for the brief', 'מעניין'])
      expect(file).not.toContain(leak);
    expect(file.endsWith('}\n')).toBe(true);
  });

  it('a later eval label reaches an already indexed chunk without embedding it again', async () => {
    const root = await fixtureRoot();
    const setPath = join(root, 'eval', 'decisions.json');
    const full = await readFile(setPath, 'utf8');
    await writeFile(setPath, JSON.stringify({ version: 1, items: [] }));
    const embedder = counting();
    await runMemory(root, build, () => embedder);
    await writeFile(setPath, full);
    expect(await runMemory(root, build, () => embedder)).toBe('added 0, index size 7\n');
    const index = await loadIndex(join(root, 'memory', 'index.json'));
    expect(index?.chunks.find((c) => c.text === 'Ten tips for a tidy desk')?.meta.label).toBe(
      'skip',
    );
    expect(embedder.texts).toHaveLength(7);
  });

  it('--dry-run uses the fake embedder and writes nothing', async () => {
    const root = await fixtureRoot();
    const output = await runMemory(root, { ...build, dryRun: true }, () => {
      throw new Error('no key in a dry run');
    });
    expect(output).toBe('added 7, index size 7 (dry run, nothing written)\n');
    expect(await loadIndex(join(root, 'memory', 'index.json'))).toBeNull();
  });

  it.each([
    [['build'], { command: 'build', from: '2026-10-07', to: '2026-10-13', dryRun: false }],
    [
      ['build', '--from', '2026-10-01', '--to', '2026-10-02', '--dry-run'],
      { command: 'build', from: '2026-10-01', to: '2026-10-02', dryRun: true },
    ],
  ])('parses %j', (argv, expected) => {
    expect(parseMemoryArgs(argv, '2026-10-13')).toEqual(expected);
  });

  it.each([[[]], [['score']], [['build', '--from', '2026-10-05', '--to', '2026-10-01']]])(
    'rejects %j',
    (argv) => {
      expect(() => parseMemoryArgs(argv, '2026-10-13')).toThrow();
    },
  );
});
