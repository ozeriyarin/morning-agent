import { describe, expect, it } from 'vitest';
import {
  briefConfigSchema,
  ConfigError,
  loadEnv,
  loadICloudCredentials,
  loadJson,
  pricesSchema,
} from './config.js';

const full = {
  TELEGRAM_BOT_TOKEN: '1:abc',
  TELEGRAM_CHAT_ID: '42',
  ANTHROPIC_API_KEY: 'sk-ant-x',
};

describe('loadEnv', () => {
  it('accepts a complete environment', () => {
    expect(loadEnv(full, false)).toMatchObject(full);
  });

  it.each(Object.keys(full))('fails fast naming the missing %s', (name) => {
    const env = Object.fromEntries(Object.entries(full).filter(([key]) => key !== name));
    expect(() => loadEnv(env, false)).toThrow(ConfigError);
    expect(() => loadEnv(env, false)).toThrow(`${name} is required`);
  });

  it('treats an empty value as missing', () => {
    expect(() => loadEnv({ ...full, ANTHROPIC_API_KEY: '' }, false)).toThrow(
      'MORNING_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY is required',
    );
  });

  it('accepts MORNING_ANTHROPIC_API_KEY in place of ANTHROPIC_API_KEY', () => {
    const { ANTHROPIC_API_KEY: _dropped, ...rest } = full;
    expect(loadEnv({ ...rest, MORNING_ANTHROPIC_API_KEY: 'sk-ant-m' }, false)).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-ant-m',
    });
  });

  it('never echoes a secret value in the error', () => {
    try {
      loadEnv({ TELEGRAM_BOT_TOKEN: 'secret-token-value' }, false);
    } catch (error) {
      expect(String(error)).not.toContain('secret-token-value');
    }
  });

  it('needs no secrets in a dry run', () => {
    expect(loadEnv({}, true)).toEqual({ dryRun: true });
  });
});

describe('committed config files', () => {
  it('config/brief.json and config/prices.json validate', async () => {
    const brief = await loadJson('config/brief.json', briefConfigSchema);
    const prices = await loadJson('config/prices.json', pricesSchema);
    expect(brief.location.timezone).toBe('Asia/Jerusalem');
    expect(Object.keys(prices.models)).toEqual(
      expect.arrayContaining(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5']),
    );
  });
});

describe('loadICloudCredentials', () => {
  it.each([
    [{}, null],
    [{ ICLOUD_USERNAME: 'u@example.invalid', ICLOUD_APP_PASSWORD: ' ' }, null],
    [
      { ICLOUD_USERNAME: 'u@example.invalid', ICLOUD_APP_PASSWORD: 'p' },
      { username: 'u@example.invalid', password: 'p' },
    ],
  ])('reads %j as %j', (env, expected) => {
    expect(loadICloudCredentials(env)).toEqual(expected);
  });
});
