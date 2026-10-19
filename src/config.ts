import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ICloudCredentials } from './sources/icloud-calendar.js';
import { FEED_KINDS } from './types.js';

const secret = (name: string) =>
  z.string({ error: `${name} is required` }).min(1, `${name} is required`);

const liveEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: secret('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_CHAT_ID: secret('TELEGRAM_CHAT_ID'),
  ANTHROPIC_API_KEY: secret('MORNING_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY'),
});

export type LiveEnv = z.infer<typeof liveEnvSchema>;
export type Env = LiveEnv | { dryRun: true };

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// Throws naming every missing variable and never echoes values; dry runs need no secrets.
export function loadEnv(source: Record<string, string | undefined>, dryRun: boolean): Env {
  if (dryRun) return { dryRun: true };
  const parsed = liveEnvSchema.safeParse({
    ...source,
    ANTHROPIC_API_KEY: loadAnthropicKey(source),
  });
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}

const telegramEnvSchema = liveEnvSchema.pick({ TELEGRAM_BOT_TOKEN: true, TELEGRAM_CHAT_ID: true });
export type TelegramEnv = z.infer<typeof telegramEnvSchema>;

// The inbox talks to Telegram only, so it needs no Anthropic key.
export function loadTelegramEnv(source: Record<string, string | undefined>): TelegramEnv {
  const parsed = telegramEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}

// Cloud sessions withhold ANTHROPIC_API_KEY from the shell, so a project-specific name comes first.
export function loadAnthropicKey(source: Record<string, string | undefined>): string | undefined {
  return source.MORNING_ANTHROPIC_API_KEY || source.ANTHROPIC_API_KEY || undefined;
}

// Both are optional; iCloud is enabled only when both are set, in live and dry runs alike.
export function loadICloudCredentials(
  source: Record<string, string | undefined>,
): ICloudCredentials | null {
  const username = source.ICLOUD_USERNAME?.trim();
  const password = source.ICLOUD_APP_PASSWORD?.trim();
  return username && password ? { username, password } : null;
}

// Optional: without it a configured or requested Jev falls back to Haiku.
export function loadOpenRouterKey(source: Record<string, string | undefined>): string | null {
  return source.OPENROUTER_API_KEY?.trim() || null;
}

// Optional: without it live runs skip memory with a warning.
export function loadVoyageKey(source: Record<string, string | undefined>): string | null {
  return source.VOYAGE_API_KEY?.trim() || null;
}

const memoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    seenThreshold: z.number().min(0).max(1).default(0.8),
    exampleThreshold: z.number().min(0).max(1).default(0.6),
    examples: z.number().int().nonnegative().default(3),
    seenDays: z.number().int().positive().default(30),
  })
  .prefault({});

export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

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
  feeds: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.url(),
        kind: z.enum(FEED_KINDS).default('news'),
        windowHours: z.number().positive().optional(),
      }),
    )
    .min(1),
  decisionModel: z.enum(['haiku', 'jev']).default('haiku'),
  memory: memoryConfigSchema,
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
