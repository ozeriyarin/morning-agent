import { z } from 'zod';
import { SECTIONS, type Brief, type CallUsage, type Section } from '../types.js';

export type { Writer, WriterInput, WriterResult } from '../types.js';

const text = z.string().trim().min(1);

export const BriefSchema = z.object({
  greeting: z.string(),
  weather: z.object({ summary: text, advice: text }),
  news: z.object({
    mustRead: z.array(z.object({ title: text, why: text, url: z.url() })),
    mention: z.array(z.object({ title: text, url: z.url() })),
    quietDay: z.boolean(),
  }),
  concept: z.object({ name: text, explanation: text, question: text }),
  footer: z.string(),
});

export type BriefValidation =
  { ok: true; brief: Brief } | { ok: false; missing: Section[]; error: string };

export function validateBrief(raw: unknown): BriefValidation {
  const parsed = BriefSchema.safeParse(raw);
  if (parsed.success) return { ok: true, brief: parsed.data };
  const keys = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')));
  return {
    ok: false,
    missing: SECTIONS.filter((section) => keys.has(section)),
    error: parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  };
}

export class WriterError extends Error {
  override name = 'WriterError';

  constructor(
    message: string,
    readonly call?: CallUsage,
  ) {
    super(message);
  }
}
