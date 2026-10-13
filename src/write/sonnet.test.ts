import { describe, expect, it } from 'vitest';
import { HAIKU_MODEL } from '../decide/haiku.js';
import { fakeClient } from '../testing/fake-client.js';
import type { WriterInput } from '../types.js';
import { SONNET_MODEL, SonnetWriter, WRITER_SYSTEM } from './sonnet.js';
import { formatBrief, templateBrief } from './template.js';
import { validateBrief, WriterError } from './writer.js';

const input: WriterInput = {
  greeting: 'בוקר טוב, יום שבת 10.10',
  weather: null,
  mustRead: [],
  mention: [],
  concept: { name: 'RAG', related: [] },
  calendar: null,
  interview: {
    problem: {
      slug: 'two-sum',
      title: 'Two Sum',
      difficulty: 'easy',
      pattern: 'hash map',
      url: 'https://leetcode.com/problems/two-sum/',
    },
    tip: { index: 3, text: 'פתחו בעוזר שרץ בפרודקשן' },
  },
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

  it('the Haiku rung is the same writer with the Haiku model, prompt, cache and schema', async () => {
    const brief = JSON.stringify(templateBrief(input));
    const sonnet = fakeClient([{ type: 'text', text: brief }]);
    const haiku = fakeClient([{ type: 'text', text: brief }]);
    await new SonnetWriter(sonnet).write(input);
    const writer = new SonnetWriter(haiku, { model: HAIKU_MODEL });
    const result = await writer.write(input);
    expect(writer).toMatchObject({ name: 'haiku', model: HAIKU_MODEL });
    expect(haiku.requests[0]).toEqual({ ...sonnet.requests[0], model: HAIKU_MODEL });
    expect(result.call?.model).toBe(HAIKU_MODEL);
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

  it('v2 criterion 6: "The writer schema requires `concept.answer`; a writer output without it fails validation and the template fallback includes `תשובה:`."', async () => {
    const client = fakeClient([{ type: 'text', text: '{}' }]);
    await new SonnetWriter(client).write(input);
    const schema = client.requests[0]?.output_config?.format?.schema as {
      properties: { concept: { required: string[] } };
    };
    expect(schema.properties.concept.required).toContain('answer');
    const brief = templateBrief(input);
    const { answer: _dropped, ...concept } = brief.concept;
    expect(validateBrief({ ...brief, concept })).toMatchObject({ ok: false, missing: ['concept'] });
    expect(formatBrief(brief)).toContain('<b>תשובה:</b> ראו את ההסבר למעלה.');
  });

  it('v7 criterion 3: "The writer schema requires `interview.approach`, `complexity` and `trap`; a writer output without them fails validation and the template fallback renders title, link, pattern and tip."', async () => {
    const client = fakeClient([{ type: 'text', text: '{}' }]);
    await new SonnetWriter(client).write(input);
    const schema = client.requests[0]?.output_config?.format?.schema as {
      required: string[];
      properties: { interview: { required: string[] } };
    };
    expect(schema.required).toContain('interview');
    expect(schema.properties.interview.required).toEqual(['approach', 'complexity', 'trap']);
    const brief = templateBrief(input);
    for (const field of ['approach', 'complexity', 'trap'] as const) {
      const { [field]: _dropped, ...interview } = brief.interview;
      expect(validateBrief({ ...brief, interview }).ok).toBe(false);
    }
    expect(formatBrief(brief)).toContain(
      [
        '<b>שאלת ראיון</b>',
        '<a href="https://leetcode.com/problems/two-sum/">Two Sum</a> · easy · hash map',
        'הסבר: ראו את הקישור',
        '<b>טיפ:</b> פתחו בעוזר שרץ בפרודקשן',
      ].join('\n'),
    );
  });

  it('sends the problem and the tip to the writer, never the slug or the tip index', async () => {
    const client = fakeClient([{ type: 'text', text: '{}' }]);
    await new SonnetWriter(client).write(input);
    const sent = JSON.parse(String(client.requests[0]?.messages[0]?.content)) as {
      interview: unknown;
    };
    expect(sent.interview).toEqual({
      problem: {
        title: 'Two Sum',
        difficulty: 'easy',
        pattern: 'hash map',
        url: 'https://leetcode.com/problems/two-sum/',
      },
      tip: 'פתחו בעוזר שרץ בפרודקשן',
    });
    expect(WRITER_SYSTEM).toContain('never a full solution');
  });

  it('v13 criterion 5: "The writer prompt gains the `seenBefore` rule and the related-concept rule; the template fallback prefixes a seen-before must-read with `המשך ל"<title>" מה-<D.M>:`." (prompt)', async () => {
    expect(WRITER_SYSTEM).toContain(
      'when an item has seen_before, its why starts with המשך ל"<seen_before.title>" מה-<seen_before.date>:',
    );
    expect(WRITER_SYSTEM).toContain('mention items ignore seen_before');
    expect(WRITER_SYSTEM).toContain(
      'when concept.related is non-empty, connect the explanation to one related concept in one clause',
    );
    const client = fakeClient([{ type: 'text', text: '{}' }]);
    const news = {
      id: 'https://example.com/1',
      title: 'Hooks v2',
      link: 'https://example.com/1',
      published: '2026-10-10T01:00:00.000Z',
      summary: '',
      sources: ['Simon Willison'],
    };
    const seenBefore = { title: 'Hooks v1', date: '2026-10-03' };
    const concept = { name: 'RAG', related: ['embeddings and chunking'] };
    await new SonnetWriter(client).write({
      ...input,
      mustRead: [{ ...news, seenBefore }],
      concept,
    });
    const sent = JSON.parse(String(client.requests[0]?.messages[0]?.content)) as {
      must_read: unknown[];
      concept: unknown;
    };
    expect(sent.must_read[0]).toMatchObject({ seen_before: { title: 'Hooks v1', date: '3.10' } });
    expect(sent.concept).toEqual(concept);
  });

  it('sends calendar titles and times, never locations', async () => {
    const client = fakeClient([{ type: 'text', text: '{}' }]);
    const event = {
      title: 'ראיון',
      start: '2026-10-10T14:00:00+03:00',
      end: '2026-10-10T15:00:00+03:00',
      allDay: false,
      location: 'Zoom',
      time: '14:00–15:00',
      source: 'google' as const,
    };
    await new SonnetWriter(client).write({ ...input, calendar: [event] });
    const sent = JSON.stringify(client.requests[0]?.messages);
    expect(sent).toContain('14:00–15:00');
    expect(sent).not.toContain('Zoom');
  });

  it('rejects a news url that is not a url', () => {
    const brief = templateBrief({ ...input, mention: [] });
    brief.news.mention.push({ title: 'x', url: 'not a url' });
    expect(validateBrief(brief)).toMatchObject({ ok: false, missing: ['news'] });
  });
});
