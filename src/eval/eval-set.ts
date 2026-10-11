import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { FeedbackLabel } from '../inbox/feedback.js';
import { matchTitle } from '../inbox/feedback.js';
import type { StoredRecord } from '../records.js';
import { collectItems } from '../replay/replay.js';
import { normalizeTitle } from '../sources/feeds.js';
import { DECISIONS, type Decision } from '../types.js';

const itemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    link: z.string(),
    summary: z.string(),
    published: z.string(),
    label: z.enum(DECISIONS),
    labeledAt: z.string(),
    source: z.enum(['feedback', 'manual']),
  })
  .strict();
const fileSchema = z.object({ version: z.literal(1), items: z.array(itemSchema) }).strict();

export type EvalItem = z.infer<typeof itemSchema>;
export type EvalSet = z.infer<typeof fileSchema>;

export const evalId = (title: string) =>
  createHash('sha1').update(normalizeTitle(title)).digest('hex').slice(0, 12);

export async function loadEvalSet(path: string): Promise<EvalSet> {
  const text = await readFile(path, 'utf8').catch(() => null);
  return text === null ? { version: 1, items: [] } : fileSchema.parse(JSON.parse(text));
}

export async function saveEvalSet(path: string, set: EvalSet): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(fileSchema.parse(set), null, 2)}\n`);
}

type ItemFields = Pick<EvalItem, 'title' | 'link' | 'summary' | 'published'>;

// Copies only the item fields, so nothing else from a record or feedback can reach the file.
const toEvalItem = (
  { title, link, summary, published }: ItemFields,
  label: Decision,
  labeledAt: string,
  source: EvalItem['source'],
): EvalItem => ({ id: evalId(title), title, link, summary, published, label, labeledAt, source });

// A keep cannot say must_read or mention, so the stored decision decides, defaulting to mention.
const labelFor = (feedback: FeedbackLabel, stored: Decision | null): Decision =>
  feedback === 'drop' ? 'skip' : stored === 'must_read' ? 'must_read' : 'mention';

export function buildEvalSet(
  set: EvalSet,
  runs: StoredRecord[],
  feedback: Map<string, FeedbackLabel>,
  labeledAt: string,
): { set: EvalSet; added: number } {
  const known = new Set(set.items.map((i) => i.id));
  const added = collectItems(runs).flatMap(({ item, original }) => {
    const label = feedback.get(normalizeTitle(item.title));
    if (!label || known.has(evalId(item.title))) return [];
    return [toEvalItem(item, labelFor(label, original), labeledAt, 'feedback')];
  });
  return { set: { ...set, items: [...set.items, ...added] }, added: added.length };
}

interface LabelInput {
  fragment: string;
  label: Decision;
  relabel: boolean;
  labeledAt: string;
}

export function labelEvalItem(
  set: EvalSet,
  record: StoredRecord,
  input: LabelInput,
): { set: EvalSet; item: EvalItem; relabelled: boolean } {
  const title = matchTitle(
    input.fragment,
    record.items.map((i) => i.title),
  );
  const item = title && record.items.find((i) => i.title === title);
  if (!item)
    throw new Error(`no single item in the ${record.date} record matches "${input.fragment}"`);
  const id = evalId(item.title);
  const existing = set.items.find((i) => i.id === id);
  if (!existing) {
    const added = toEvalItem(item, input.label, input.labeledAt, 'manual');
    return { set: { ...set, items: [...set.items, added] }, item: added, relabelled: false };
  }
  if (!input.relabel)
    throw new Error(`"${existing.title}" is already labelled ${existing.label}; pass --relabel`);
  const relabelled = { ...existing, label: input.label };
  const items = set.items.map((i) => (i.id === id ? relabelled : i));
  return { set: { ...set, items }, item: relabelled, relabelled: true };
}
