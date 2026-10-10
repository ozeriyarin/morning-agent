import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { datesBetween } from '../dates.js';
import { redact } from '../run/redact.js';
import { normalizeTitle } from '../sources/feeds.js';

const FEEDBACK_LABELS = ['keep', 'drop'] as const;
export type FeedbackLabel = (typeof FEEDBACK_LABELS)[number];

const entrySchema = z.object({
  at: z.string(),
  text: z.string(),
  replyToBriefDate: z.string().optional(),
  title: z.string().optional(),
  label: z.enum(FEEDBACK_LABELS).optional(),
});
const fileSchema = z.array(entrySchema);

export type FeedbackEntry = z.infer<typeof entrySchema>;

const LABEL_WORDS = new Set(['כן', 'לא', 'מעניין']);
const MIN_FRAGMENT_CHARS = 4;

// Any negation wins, so "לא מעניין" is a drop even though it contains "מעניין".
export function feedbackLabel(text: string): FeedbackLabel | null {
  const words = normalizeTitle(text).split(' ');
  if (text.includes('👎') || words.includes('לא')) return 'drop';
  if (text.includes('👍') || words.includes('כן') || words.includes('מעניין')) return 'keep';
  return null;
}

// The longest run of the message's words found in exactly one title wins; ties are ambiguous.
export function matchTitle(text: string, titles: string[]): string | null {
  const words = normalizeTitle(text)
    .split(' ')
    .filter((w) => w && !LABEL_WORDS.has(w));
  const normalised = [...new Set(titles)].map((t) => ({ title: t, key: normalizeTitle(t) }));
  for (let size = words.length; size > 0; size--) {
    const hits = new Set<string>();
    for (let start = 0; start + size <= words.length; start++) {
      const fragment = words.slice(start, start + size).join(' ');
      if (fragment.length < MIN_FRAGMENT_CHARS) continue;
      const found = normalised.filter((n) => n.key.includes(fragment));
      for (const n of found) hits.add(n.title);
    }
    if (hits.size) return hits.size === 1 ? ([...hits][0] ?? null) : null;
  }
  return null;
}

export function toFeedbackEntry(
  base: Pick<FeedbackEntry, 'at' | 'text' | 'replyToBriefDate'>,
  titles: string[],
): FeedbackEntry {
  const label = feedbackLabel(base.text);
  const title = label && matchTitle(base.text, titles);
  return title && label ? { ...base, title, label } : base;
}

const feedbackPath = (dir: string, date: string) => join(dir, `${date}.json`);

async function readFeedback(dir: string, date: string): Promise<FeedbackEntry[]> {
  const text = await readFile(feedbackPath(dir, date), 'utf8').catch(() => null);
  return text === null ? [] : fileSchema.parse(JSON.parse(text));
}

// Appends to feedback/<date>.json; every string is redacted before it reaches the file.
export async function appendFeedback(
  dir: string,
  date: string,
  entries: FeedbackEntry[],
  secrets: string[],
): Promise<void> {
  if (!entries.length) return;
  const all = [...(await readFeedback(dir, date)), ...redact(entries, secrets)];
  await mkdir(dir, { recursive: true });
  await writeFile(feedbackPath(dir, date), `${JSON.stringify(all, null, 2)}\n`);
}

// Normalised title -> label over the range; a later label for the same title wins.
export async function loadFeedbackLabels(
  dir: string,
  from: string,
  to: string,
): Promise<Map<string, FeedbackLabel>> {
  const labels = new Map<string, FeedbackLabel>();
  for (const date of datesBetween(from, to))
    for (const e of await readFeedback(dir, date))
      if (e.title && e.label) labels.set(normalizeTitle(e.title), e.label);
  return labels;
}
