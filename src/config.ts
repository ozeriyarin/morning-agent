import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const secret = (name: string) =>
  z.string({ error: `${name} is required` }).min(1, `${name} is required`);

const liveEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: secret('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_CHAT_ID: secret('TELEGRAM_CHAT_ID'),
  ANTHROPIC_API_KEY: secret('MORNING_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY'),
  ICLOUD_APP_PASSWORD: z.string().optional(),
});

export type LiveEnv = z.infer<typeof liveEnvSchema>;
export type Env = LiveEnv | { dryRun: true };

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// Throws naming every missing variable and never echoes values; dry runs need no secrets.
export function loadEnv(source: Record<string, string | undefined>, dryRun: boolean): Env {
  if (dryRun) return { dryRun: true };
  // Cloud sessions withhold ANTHROPIC_API_KEY from the shell, so a project-specific name comes first.
  const parsed = liveEnvSchema.safeParse({
    ...source,
    ANTHROPIC_API_KEY: source.MORNING_ANTHROPIC_API_KEY || source.ANTHROPIC_API_KEY,
  });
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}

export const briefConfigSchema = z.object({
  recipient: z.string().min(1),
  language: z.literal('he'),
  location: z.object({
    name: z.string().min(1),
    latitude: z.number(),
    longitude: z.number(),
    timezone: z.string().min(1),
  }),
  schedule: z.object({ localTime: z.string().regex(/^\d{2}:\d{2}$/) }),
  feeds: z.array(z.object({ name: z.string().min(1), url: z.url() })).min(1),
});

export type BriefConfig = z.infer<typeof briefConfigSchema>;

const priceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

export const pricesSchema = z.object({
  asOf: z.string(),
  models: z.record(z.string(), priceSchema),
});

export type Prices = z.infer<typeof pricesSchema>;

export async function loadJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')));
}
