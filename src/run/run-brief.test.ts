import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { briefConfigSchema, loadJson, pricesSchema, type Prices } from '../config.js';
import { FakeDecisionModel } from '../decide/fake.js';
import { TelegramSender } from '../deliver/telegram.js';
import { FileConceptStore } from '../sources/concepts.js';
import { parseFeed } from '../sources/feeds.js';
import type { CallUsage, Item, RunRecord, Sender, Source, WeatherDay, Writer } from '../types.js';
import { templateBrief, TemplateWriter } from '../write/template.js';
import { MAX_DECISIONS, runBrief, type RunDeps } from './run-brief.js';
import { buildDeps } from './wiring.js';

const DATE = '2026-10-10';
const TOKEN = '7012345678:AAH-secret_token-value';
const CHAT_ID = '987654321';
const API_KEY = 'sk-ant-api03-very-secret-key';
const SECTION_TITLES = [
  'בוקר טוב, יום שבת 10.10',
  'מזג אוויר במודיעין',
  'AI היום',
  'מושג היום',
  'נוצר ב-',
];

const fixture = (name: string) => readFile(join('test/fixtures', name), 'utf8');
const prices: Prices = await loadJson('config/prices.json', pricesSchema);
const config = await loadJson('config/brief.json', briefConfigSchema);
const atomItems = parseFeed(await fixture('simonwillison-atom.xml'), 'Simon Willison');
const rssItems = parseFeed(await fixture('openai-rss.xml'), 'OpenAI News');

const weatherDay: WeatherDay = {
  date: DATE,
  min: 19,
  max: 31,
  precipitationProbability: 3,
  code: 3,
  label: 'מעונן',
};

const source = <T>(name: string, value: T | Error): Source<T> => ({
  name,
  fetch: async () => {
    if (value instanceof Error) throw value;
    return value;
  },
});

const usage = (role: CallUsage['role'], model: string, n: number): CallUsage => ({
  role,
  model,
  inputTokens: 1000 * n,
  outputTokens: 100 * n,
  cacheReadTokens: 500 * n,
  cacheWriteTokens: 10 * n,
  latencyMs: 5,
});

class CapturingSender implements Sender {
  readonly name = 'capture';
  sent: string[] = [];
  async send(html: string) {
    this.sent.push(html);
    return { status: 'sent' as const };
  }
}

let root: string;
let records: RunRecord[];
let sender: CapturingSender;

async function deps(over: Partial<RunDeps> = {}): Promise<RunDeps> {
  return {
    weather: source('weather', weatherDay),
    feeds: [source('Simon Willison', atomItems), source('OpenAI News', rssItems)],
    concepts: new FileConceptStore(join(root, 'concepts', 'queue.md')),
    decisionModel: new FakeDecisionModel(),
    writer: new TemplateWriter(),
    sender,
    prices,
    secrets: [TOKEN, CHAT_ID, API_KEY],
    timeZone: 'Asia/Jerusalem',
    localTime: '07:00',
    now: () => new Date('2026-10-10T04:00:00Z'),
    writeRecord: async (record) => {
      records.push(record);
    },
    ...over,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brief-'));
  await mkdir(join(root, 'concepts'));
  await writeFile(join(root, 'concepts', 'queue.md'), await readFile('concepts/queue.md', 'utf8'));
  records = [];
  sender = new CapturingSender();
});

describe('runBrief', () => {
  it('criterion 1: "Running `npm run brief -- --dry-run` offline-safe for AI/Telegram prints a brief with all five sections and writes a run record."', async () => {
    const printed: string[] = [];
    const offline: typeof fetch = async () => {
      throw new TypeError('fetch failed: offline');
    };
    const wired = buildDeps({
      env: { dryRun: true },
      config,
      prices,
      root,
      fetchFn: offline,
      print: (t) => printed.push(t),
    });
    const { record } = await runBrief(wired, { date: DATE, dryRun: true });

    expect(printed).toHaveLength(1);
    for (const title of SECTION_TITLES) expect(printed[0]).toContain(title);
    const written = JSON.parse(await readFile(join(root, 'runs', `${DATE}.dry-run.json`), 'utf8'));
    expect(written).toMatchObject({
      date: DATE,
      dryRun: true,
      delivery: { sender: 'console', status: 'printed' },
    });
    expect(record.calls).toEqual([]);
    expect(record.concept).toEqual({ name: 'agent loop', queueEmpty: false, marked: false });
    expect(await readFile(join(root, 'concepts', 'queue.md'), 'utf8')).toContain(
      '- [ ] agent loop',
    );
  });

  it('a dry run with reachable sources fills every section from the fetched data', async () => {
    const printed: string[] = [];
    const bodies: Record<string, string> = {
      'api.open-meteo.com': await fixture('open-meteo-modiin.json'),
      'simonwillison.net': await fixture('simonwillison-atom.xml'),
      'hnrss.org': await fixture('hnrss-rss.xml'),
      'openai.com': await fixture('openai-rss.xml'),
    };
    const online: typeof fetch = async (url) =>
      new Response(bodies[new URL(String(url)).host] ?? '');
    const wired = buildDeps({
      env: { dryRun: true },
      config,
      prices,
      root,
      fetchFn: online,
      print: (t) => printed.push(t),
    });
    const { record, html } = await runBrief(wired, { date: DATE, dryRun: true });

    expect(record.errors).toEqual([]);
    expect(record.missingSections).toEqual([]);
    expect(html).toContain('מעונן, 19°-31°, סיכוי לגשם 3%.');
    expect(html).toContain('href="https://openai.com/index/asana-browser-agent"');
    expect(record.briefChars).toBeLessThanOrEqual(1200);
  });

  it('criterion 5: "Writer output is validated against the schema; a missing section fails validation and the run falls back to a template brief with a `חסר: <section>` line instead of sending nothing."', async () => {
    const writer: Writer = {
      mode: 'ai',
      write: async (input) => {
        const { concept: _dropped, ...rest } = templateBrief(input);
        return { brief: rest, call: usage('writer', 'claude-sonnet-5-5', 1) };
      },
    };
    const { record } = await runBrief(await deps({ writer }), { date: DATE, dryRun: false });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toContain('<b>מושג היום</b>\nחסר: מושג היום');
    expect(sender.sent[0]).toContain('מעונן, 19°-31°');
    expect(record.writer).toBe('fallback');
    expect(record.missingSections).toEqual(['concept']);
    expect(record.errors).toContainEqual({
      stage: 'writer',
      message: expect.stringContaining('concept'),
    });
    expect(record.calls.map((c) => c.role)).toEqual(['writer']);
  });

  it('a writer that throws still sends the template brief', async () => {
    const writer: Writer = {
      mode: 'ai',
      write: async () => {
        throw new Error('timeout');
      },
    };
    const { record } = await runBrief(await deps({ writer }), { date: DATE, dryRun: false });
    expect(sender.sent).toHaveLength(1);
    expect(record).toMatchObject({ writer: 'fallback', delivery: { status: 'sent' } });
  });

  it('criterion 6: "The record never contains the Telegram token, the chat id or the API key, even when an error message includes the request URL (redaction test)."', async () => {
    const leaky: typeof fetch = async (url) => {
      throw new Error(`request to ${String(url)} failed (chat_id=${CHAT_ID}, key ${API_KEY})`);
    };
    const failingDecision = new FakeDecisionModel(() => {
      throw new Error(`401 for x-api-key ${API_KEY}`);
    });
    const { record } = await runBrief(
      await deps({
        sender: new TelegramSender(TOKEN, CHAT_ID, leaky),
        decisionModel: failingDecision,
      }),
      { date: DATE, dryRun: false },
    );
    const json = JSON.stringify(record);

    expect(record.delivery.status).toBe('failed');
    expect(json).toContain('api.telegram.org/bot[REDACTED]/sendMessage');
    for (const secret of [TOKEN, CHAT_ID, API_KEY, 'AAH-secret_token-value']) {
      expect(json).not.toContain(secret);
    }
  });

  it('criterion 7: "A failing source (e.g. one feed 500s) still produces a brief; the record lists the failure."', async () => {
    const { record } = await runBrief(
      await deps({
        feeds: [
          source('Simon Willison', atomItems),
          source<Item[]>('OpenAI News', new Error('HTTP 500')),
        ],
        decisionModel: new FakeDecisionModel(() => ({ decision: 'must_read' })),
      }),
      { date: DATE, dryRun: false },
    );
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toContain('Quoting The New York Times');
    expect(record.errors).toEqual([
      { stage: 'source', source: 'OpenAI News', message: 'HTTP 500' },
    ]);
    expect(record.missingSections).toEqual([]);
  });

  it('marks weather and news as missing when their sources all fail', async () => {
    const { record } = await runBrief(
      await deps({
        weather: source<WeatherDay>('weather', new Error('down')),
        feeds: [source<Item[]>('a', new Error('x'))],
      }),
      { date: DATE, dryRun: false },
    );
    expect(record.missingSections).toEqual(['weather', 'news']);
    expect(sender.sent[0]).toContain('חסר: מזג אוויר במודיעין');
    expect(sender.sent[0]).toContain('חסר: AI היום');
  });

  it('criterion 8: "Concept queue: the first unused concept is used and marked with today\'s date; if all are used, the brief says the queue is empty."', async () => {
    const queuePath = join(root, 'concepts', 'queue.md');
    const first = await runBrief(await deps(), { date: DATE, dryRun: false });
    expect(first.record.concept).toEqual({ name: 'agent loop', queueEmpty: false, marked: true });
    expect(first.html).toContain('<i>agent loop</i>');
    const queue = await readFile(queuePath, 'utf8');
    expect(queue).toContain(`- [x] ${DATE} agent loop`);
    expect(queue).toContain('- [ ] tool calling');

    await writeFile(queuePath, `- [x] 2026-10-01 agent loop\n`);
    const empty = await runBrief(await deps(), { date: DATE, dryRun: false });
    expect(empty.record.concept).toEqual({ name: null, queueEmpty: true, marked: false });
    expect(empty.html).toContain('תור המושגים ריק');
  });

  it('criterion 9: "Cost: the record total equals the sum of per-call costs computed from the price table in `config/prices.json`."', async () => {
    const decisionModel = new FakeDecisionModel();
    const decide = decisionModel.decide.bind(decisionModel);
    decisionModel.decide = async (item) => ({
      ...(await decide(item)),
      call: usage('decision', 'claude-haiku-4-5-20251001', 1),
    });
    const writer: Writer = {
      mode: 'ai',
      write: async (input) => ({
        brief: templateBrief(input),
        call: usage('writer', 'claude-sonnet-5-5', 3),
      }),
    };
    const { record, html } = await runBrief(await deps({ decisionModel, writer }), {
      date: DATE,
      dryRun: false,
    });

    const { 'claude-haiku-4-5-20251001': haiku, 'claude-sonnet-5-5': sonnet } = prices.models;
    if (!haiku || !sonnet) throw new Error('prices.json lacks a model');
    const expectedCall = (p: NonNullable<typeof haiku>, n: number) =>
      (1000 * n * p.input + 100 * n * p.output + 500 * n * p.cacheRead + 10 * n * p.cacheWrite) /
      1e6;
    const decisions = record.calls.filter((c) => c.role === 'decision');
    expect(decisions).toHaveLength(record.decisions.length);
    for (const call of decisions) expect(call.costUsd).toBeCloseTo(expectedCall(haiku, 1), 12);
    expect(record.calls.at(-1)?.costUsd).toBeCloseTo(expectedCall(sonnet, 3), 12);
    expect(record.totalCostUsd).toBeCloseTo(
      record.calls.reduce((s, c) => s + c.costUsd, 0),
      12,
    );
    expect(record.totalCostUsd).toBeCloseTo(
      decisions.length * expectedCall(haiku, 1) + expectedCall(sonnet, 3),
      12,
    );
    expect(html).toContain(`עלות ~$${record.totalCostUsd.toFixed(3)}`);
  });

  it('decides at most 40 newest items and counts the rest as skipped unseen', async () => {
    const many: Item[] = Array.from({ length: 45 }, (_, i) => ({
      id: `https://x/${i}`,
      title: `Story ${i}`,
      link: `https://x/${i}`,
      published: new Date(Date.UTC(2026, 9, 10, 3, 0) - i * 60_000).toISOString(),
      summary: '',
      sources: ['x'],
    }));
    const { record } = await runBrief(await deps({ feeds: [source('x', many)] }), {
      date: DATE,
      dryRun: false,
    });
    expect(record.decisions).toHaveLength(MAX_DECISIONS);
    expect(record.decisions[0]?.title).toBe('Story 0');
    expect(record.skippedUnseen).toBe(5);
  });

  it('drops writer links to items that were never fetched', async () => {
    const writer: Writer = {
      mode: 'ai',
      write: async (input) => {
        const brief = templateBrief(input);
        brief.news.mention.push({ title: 'Invented', url: 'https://evil.example/' });
        return { brief };
      },
    };
    const { html } = await runBrief(await deps({ writer }), { date: DATE, dryRun: false });
    expect(html).not.toContain('evil.example');
  });
});
