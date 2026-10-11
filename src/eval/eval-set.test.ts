import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadJson, pricesSchema } from '../config.js';
import { runEval, type EvalDeps } from '../eval-cli.js';
import { evalId, loadEvalSet, saveEvalSet } from './eval-set.js';

const KEYS = { anthropicKey: 'sk-ant-synthetic', openRouterKey: null };
const noNetwork: typeof fetch = async () => new Response('', { status: 500 });
const deps: EvalDeps = {
  today: '2026-10-02',
  now: new Date('2026-10-02T06:00:00Z'),
  prices: await loadJson('config/prices.json', pricesSchema),
  keys: KEYS,
  fetchFn: noNetwork,
};

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'eval-set-'));
  await cp('test/fixtures/runs', join(root, 'runs'), { recursive: true });
  await cp('test/fixtures/feedback', join(root, 'feedback'), { recursive: true });
  return root;
}

const setPath = (root: string) => join(root, 'eval', 'decisions.json');
const build = { command: 'build', from: '2026-10-01', to: '2026-10-02' } as const;
const label = (fragment: string, decision: 'must_read' | 'mention' | 'skip', relabel = false) =>
  ({ command: 'label', fragment, label: decision, relabel }) as const;

describe('eval set', () => {
  it('ids are a 12-char sha1 of the normalised title', () => {
    expect(evalId('Anthropic Ships Claude Code Hooks!')).toBe(
      evalId('anthropic ships claude code hooks'),
    );
    expect(evalId('x')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('v12 criterion 1: "`eval build` over fixture records and feedback adds each labelled item once (a second build adds nothing), maps `drop → skip` and `keep → stored decision`, and leaves unlabelled items out."', async () => {
    const root = await tempRoot();
    expect(await runEval(root, build, deps)).toBe('added 4, set size 4\n');
    const first = await readFile(setPath(root), 'utf8');
    expect(first.endsWith('}\n')).toBe(true);
    const set = await loadEvalSet(setPath(root));
    expect(set.items.map((i) => [i.title, i.label, i.source])).toEqual([
      ['Anthropic ships Claude Code hooks', 'must_read', 'feedback'],
      // Stored skip with a keep falls back to mention.
      ['Startup raises $20M for LLM evals', 'mention', 'feedback'],
      ['A benchmark of local models', 'skip', 'feedback'],
      ['Weekend gardening notes', 'mention', 'feedback'],
    ]);
    expect(set.items.map((i) => i.title)).not.toContain('Ten tips for a tidy desk');

    expect(await runEval(root, build, deps)).toBe('added 0, set size 4\n');
    expect(await readFile(setPath(root), 'utf8')).toBe(first);
  });

  it('v12 criterion 2: "`eval label` appends one item from the latest record with `source: \'manual\'` and refuses an unknown fragment with a clear message; `--relabel` changes an existing label and nothing else."', async () => {
    const root = await tempRoot();
    const later = { ...deps, now: new Date('2026-10-03T06:00:00Z') };
    expect(await runEval(root, label('gardening', 'mention'), deps)).toBe(
      'labelled "Weekend gardening notes" as mention, set size 1\n',
    );
    await runEval(root, label('benchmark local', 'must_read'), deps);
    const before = await loadEvalSet(setPath(root));
    expect(before.items[0]).toEqual({
      id: evalId('Weekend gardening notes'),
      title: 'Weekend gardening notes',
      link: 'https://example.com/b/garden',
      summary: '',
      published: '2026-10-01T22:00:00.000Z',
      label: 'mention',
      labeledAt: '2026-10-02T06:00:00.000Z',
      source: 'manual',
    });

    // The tidy desk item is only in the older record.
    for (const fragment of ['quantum teapot', 'tidy desk'])
      await expect(runEval(root, label(fragment, 'skip'), deps)).rejects.toThrow(
        `no single item in the 2026-10-02 record matches "${fragment}"`,
      );
    await expect(runEval(root, label('gardening', 'skip'), deps)).rejects.toThrow(
      '"Weekend gardening notes" is already labelled mention; pass --relabel',
    );
    expect(await loadEvalSet(setPath(root))).toEqual(before);

    expect(await runEval(root, label('gardening', 'skip', true), later)).toBe(
      'relabelled "Weekend gardening notes" as skip, set size 2\n',
    );
    const after = await loadEvalSet(setPath(root));
    expect(after).toEqual({
      ...before,
      items: [{ ...before.items[0], label: 'skip' }, before.items[1]],
    });
  });
  it('v12 criterion 5: "The eval file never stores feedback text, chat ids or anything beyond the item fields and the label (redaction test)."', async () => {
    const root = await tempRoot();
    await runEval(root, build, deps);
    await runEval(root, label('benchmark local', 'mention', true), deps);
    const text = await readFile(setPath(root), 'utf8');
    for (const leaked of ['chat_id', '123456789', '👍', 'כן', 'thanks for the brief', '"at"'])
      expect(text).not.toContain(leaked);
    const fields = ['id', 'title', 'link', 'summary', 'published', 'label', 'labeledAt', 'source'];
    const parsed = JSON.parse(text) as { items: Record<string, unknown>[] };
    expect(Object.keys(parsed)).toEqual(['version', 'items']);
    for (const item of parsed.items) expect(Object.keys(item)).toEqual(fields);

    const set = await loadEvalSet(setPath(root));
    const smuggled = { ...set, items: [{ ...set.items[0], text: 'feedback text' }] };
    await expect(saveEvalSet(setPath(root), smuggled as typeof set)).rejects.toThrow();
    expect(await readFile(setPath(root), 'utf8')).toBe(text);
  });
});
