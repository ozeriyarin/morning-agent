import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { addDays, datesBetween } from './dates.js';
import { DECISIONS } from './types.js';

const callSchema = z.object({
  role: z.enum(['decision', 'writer']),
  model: z.string(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  latencyMs: z.number().default(0),
  costUsd: z.number().default(0),
});

// Lenient on purpose: older records lack fields that newer runs write.
export const recordSchema = z.object({
  date: z.string(),
  dryRun: z.boolean().default(false),
  fetchedCount: z.number().optional(),
  items: z.array(
    z.object({
      title: z.string(),
      link: z.string(),
      published: z.string().default(''),
      summary: z.string().default(''),
      sources: z.array(z.string()).default([]),
    }),
  ),
  calendar: z.array(z.unknown()).nullable().default(null),
  icloud: z.enum(['ok', 'disabled', 'failed']).optional(),
  decisions: z
    .array(
      z.object({ title: z.string(), decision: z.enum(DECISIONS), model: z.string().optional() }),
    )
    .default([]),
  calls: z.array(callSchema).default([]),
  concept: z.object({ name: z.string().nullable() }).optional(),
  delivery: z.object({ status: z.enum(['sent', 'printed', 'failed']) }).optional(),
  errors: z
    .array(
      z.object({ stage: z.string(), source: z.string().optional(), reason: z.string().optional() }),
    )
    .default([]),
});

export type StoredRecord = z.infer<typeof recordSchema>;
export type StoredCall = z.infer<typeof callSchema>;

// Reads runs/<date>.json per day in range; missing days and dry-run records are skipped.
export async function loadRecords(dir: string, from: string, to: string): Promise<StoredRecord[]> {
  const records: StoredRecord[] = [];
  for (const date of datesBetween(from, to)) {
    const text = await readFile(join(dir, `${date}.json`), 'utf8').catch(() => null);
    const record = text === null ? null : recordSchema.parse(JSON.parse(text));
    if (record && !record.dryRun) records.push(record);
  }
  return records;
}

// The newest non-dry-run record within `days` days ending `today`, or null.
export async function latestRecord(
  dir: string,
  today: string,
  days = 7,
): Promise<StoredRecord | null> {
  return (await loadRecords(dir, addDays(today, 1 - days), today)).at(-1) ?? null;
}
