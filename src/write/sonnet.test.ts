import { describe, expect, it } from 'vitest';
import { fakeClient } from '../testing/fake-client.js';
import type { WriterInput } from '../types.js';
import { SONNET_MODEL, SonnetWriter, WRITER_SYSTEM } from './sonnet.js';
import { templateBrief } from './template.js';
import { validateBrief, WriterError } from './writer.js';

const input: WriterInput = {
  greeting: 'בוקר טוב, יום שבת 10.10',
  weather: null,
  mustRead: [],
  mention: [],
  concept: 'RAG',
};

describe('SonnetWriter', () => {
  it('sends a cached system prompt first and asks for the brief schema', async () => {
    const brief = templateBrief(input);
    const client = fakeClient([{ type: 'text', text: JSON.stringify(brief) }]);
    const result = await new SonnetWriter(client).write(input);
    const request = client.requests[0];
    expect(request?.model).toBe(SONNET_MODEL);
    expect(request?.system).toEqual([
      { type: 'text', text: WRITER_SYSTEM, cache_control: { type: 'ephemeral' } },
    ]);
    expect(request?.output_config?.format?.type).toBe('json_schema');
    expect(JSON.stringify(request?.output_config?.format?.schema)).toContain('mustRead');
    expect(result.brief).toEqual(brief);
    expect(result.call).toMatchObject({
      role: 'writer',
      model: SONNET_MODEL,
      cacheReadTokens: 800,
    });
  });

  it('returns unparseable text as a null brief so validation fails', async () => {
    const client = fakeClient([{ type: 'text', text: 'not json' }]);
    const result = await new SonnetWriter(client).write(input);
    expect(validateBrief(result.brief).ok).toBe(false);
  });

  it('throws a WriterError carrying the usage on a refusal', async () => {
    const client = fakeClient([], 'refusal');
    const error: unknown = await new SonnetWriter(client).write(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriterError);
    expect((error as WriterError).call?.model).toBe(SONNET_MODEL);
  });
});

describe('validateBrief', () => {
  it.each([
    ['concept', 'concept'],
    ['weather', 'weather'],
    ['news', 'news'],
  ] as const)('names %s when that section is missing', (key, section) => {
    const brief = Object.fromEntries(
      Object.entries(templateBrief(input)).filter(([k]) => k !== key),
    );
    const result = validateBrief(brief);
    expect(result).toMatchObject({ ok: false, missing: [section] });
  });

  it('rejects a news url that is not a url', () => {
    const brief = templateBrief({ ...input, mention: [] });
    brief.news.mention.push({ title: 'x', url: 'not a url' });
    expect(validateBrief(brief)).toMatchObject({ ok: false, missing: ['news'] });
  });
});
