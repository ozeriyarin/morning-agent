import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  briefConfigSchema,
  loadICloudCredentials,
  loadJson,
  pricesSchema,
  type Prices,
} from '../config.js';
import { FakeDecisionModel } from '../decide/fake.js';
import { HAIKU_MODEL, HaikuDecisionModel } from '../decide/haiku.js';
import { JEV_MODEL, JevDecisionModel } from '../decide/jev.js';
import { JEV_NO_KEY_WARNING } from '../decide/select.js';
import { TelegramSender } from '../deliver/telegram.js';
import { CalendarFileSource } from '../sources/calendar-file.js';
import { ICloudCalendarSource, ICloudFileSource } from '../sources/icloud-calendar.js';
import { FileConceptStore } from '../sources/concepts.js';
import { FileInterviewStore } from '../sources/interview.js';
import { parseFeed } from '../sources/feeds.js';
import { RemindersFileSource } from '../sources/reminders-file.js';
import type {
  CalendarEvent,
  CallUsage,
  DecisionExample,
  Item,
  Reminder,
  RunRecord,
  Sender,
  Source,
  WeatherDay,
  Writer,
  WriterInput,
} from '../types.js';
import { ChainWriter } from '../write/chain.js';
import { SONNET_MODEL } from '../write/sonnet.js';
import { WriterError } from '../write/writer.js';
import { MAX_BRIEF_CHARS, templateBrief, TemplateWriter } from '../write/template.js';
import { MAX_DECISIONS, RECORD_SUMMARY_CHARS, runBrief, type RunDeps } from './run-brief.js';
import { exitCode, parseCli } from '../cli.js';
import { buildDeps, MEMORY_DISABLED_WARNING, MEMORY_NO_KEY_WARNING } from './wiring.js';
import { FakeEmbedder, VoyageEmbedder, type Embedder } from '../retrieve/embed.js';
import { saveIndex, type MemoryChunk } from '../retrieve/memory-index.js';
import { MemorySource } from '../retrieve/memory.js';

const DATE = '2026-10-10';
const CALENDAR_DATE = '2026-10-11';
const CALENDAR_SAMPLE = 'test/fixtures/calendar-sample.json';
const SAMPLE_SECTION = [
  '<b>היום ביומן</b>',
  'כל היום: יום הולדת לנוי',
  '09:30–10:00 סנכרון צוות (משרד)',
  '14:00–15:00 ראיון טכני (Zoom)',
].join('\n');
const TOKEN = '7012345678:AAH-secret_token-value';
const CHAT_ID = '987654321';
const API_KEY = 'sk-ant-api03-very-secret-key';
const SECTION_TITLES = [
  'בוקר טוב, יום שבת 10.10',
  'מזג אוויר במודיעין',
  'היום ביומן',
  'AI היום',
  'מושג היום',
  'שאלת ראיון',
  'נוצר ב-',
];
const PROBLEMS = () => join(root, 'interview', 'problems.md');
const TIPS = () => join(root, 'interview', 'tips.md');

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
    return { status: 'sent' as const, attempts: 1 };
  }
}

let root: string;
let records: RunRecord[];
let sender: CapturingSender;

async function deps(over: Partial<RunDeps> = {}): Promise<RunDeps> {
  return {
    weather: source('weather', weatherDay),
    calendar: source<CalendarEvent[]>('calendar', []),
    feeds: [source('Simon Willison', atomItems), source('OpenAI News', rssItems)],
    concepts: new FileConceptStore(join(root, 'concepts', 'queue.md')),
    interview: new FileInterviewStore(PROBLEMS(), TIPS()),
    decisionModel: new FakeDecisionModel(),
    writer: new TemplateWriter(),
    sender,
    prices,
    secrets: [TOKEN, CHAT_ID, API_KEY],
    timeZone: 'Asia/Jerusalem',
    localTime: '07:00',
    now: () => new Date('2026-10-10T04:00:00Z'),
    history: async () => [],
    writeRecord: async (record) => {
      records.push(record);
    },
    ...over,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brief-'));
  await mkdir(join(root, 'concepts'));
  await mkdir(join(root, 'interview'));
  for (const queue of ['concepts/queue.md', 'interview/problems.md', 'interview/tips.md']) {
    const text = await readFile(queue, 'utf8');
    await writeFile(join(root, queue), text.replace(/- \[x\] \d{4}-\d{2}-\d{2} /g, '- [ ] '));
  }
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
      'hn.algolia.com': await fixture('hn-algolia.json'),
      'openai.com': await fixture('openai-rss.xml'),
      'huggingface.co': await fixture('openai-rss.xml'),
      'blog.google': await fixture('hnrss-rss.xml'),
      'pypi.org': await fixture('openai-rss.xml'),
      'api.github.com': await fixture('github-releases.json'),
    };
    await mkdir(join(root, 'input'));
    await writeFile(
      join(root, 'input', `calendar-${DATE}.json`),
      JSON.stringify({ date: DATE, timezone: 'Asia/Jerusalem', source: 'google', events: [] }),
    );
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
    expect(html).toContain('<b>היום ביומן</b>\nאין אירועים היום');
    expect(record.briefChars).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
  });

  it('criterion 5: "Writer output is validated against the schema; a missing section fails validation and the run falls back to a template brief with a `חסר: <section>` line instead of sending nothing."', async () => {
    const writer: Writer = {
      name: 'sonnet',
      write: async (input) => {
        const { concept: _dropped, ...rest } = templateBrief(input);
        return { brief: rest, call: usage('writer', 'claude-sonnet-5-5', 1) };
      },
    };
    const { record } = await runBrief(await deps({ writer }), { date: DATE, dryRun: false });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toContain('<b>מושג היום</b>\nחסר: מושג היום');
    expect(sender.sent[0]).toContain('מעונן, 19°-31°');
    expect(record.writer).toBe('template');
    expect(record.missingSections).toEqual(['concept']);
    expect(record.errors).toContainEqual({
      stage: 'writer',
      message: expect.stringContaining('concept'),
    });
    expect(record.calls.map((c) => c.role)).toEqual(['writer']);
  });

  it('a writer that throws still sends the template brief', async () => {
    const writer: Writer = {
      name: 'sonnet',
      write: async () => {
        throw new Error('timeout');
      },
    };
    const { record } = await runBrief(await deps({ writer }), { date: DATE, dryRun: false });
    expect(sender.sent).toHaveLength(1);
    expect(record).toMatchObject({ writer: 'template', delivery: { status: 'sent' } });
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
        sender: new TelegramSender(TOKEN, CHAT_ID, leaky, 15_000, 0),
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

  it('v7 criterion 1: "The first unused problem and tip are selected; on a delivered run both are marked with the date; a dry run marks nothing."', async () => {
    const dry = await runBrief(await deps(), { date: DATE, dryRun: true });
    expect(dry.record.interview).toEqual({ slug: 'two-sum', tipIndex: 0, marked: false });
    expect(await readFile(PROBLEMS(), 'utf8')).not.toContain(`- [x] ${DATE}`);
    expect(await readFile(TIPS(), 'utf8')).not.toContain(`- [x] ${DATE}`);

    const real = await runBrief(await deps(), { date: DATE, dryRun: false });
    expect(real.record.interview).toEqual({ slug: 'two-sum', tipIndex: 0, marked: true });
    expect(real.html).toContain('href="https://leetcode.com/problems/two-sum/">Two Sum</a>');
    expect(await readFile(PROBLEMS(), 'utf8')).toContain(`- [x] ${DATE} two-sum | Two Sum |`);
    expect(await readFile(TIPS(), 'utf8')).toContain(`- [x] ${DATE} בראיון התנהגותי`);
    const next = await runBrief(await deps(), { date: '2026-10-11', dryRun: false });
    expect(next.record.interview).toMatchObject({ slug: 'valid-palindrome', tipIndex: 1 });
  });

  it('a failed delivery marks neither interview queue', async () => {
    const failing: Sender = {
      name: 'capture',
      send: async () => Promise.reject(new Error('down')),
    };
    const { record } = await runBrief(await deps({ sender: failing }), {
      date: DATE,
      dryRun: false,
    });
    expect(record.interview.marked).toBe(false);
    expect(await readFile(PROBLEMS(), 'utf8')).not.toContain(`- [x] ${DATE}`);
  });

  it('v7 criterion 2: "When the problem queue is empty the section says `תור השאלות ריק` and the tip still renders; when the tip queue is exhausted it restarts from the first tip." (end to end)', async () => {
    await writeFile(PROBLEMS(), '- [x] 2026-10-01 two-sum | Two Sum | easy | hash map | u\n');
    await writeFile(TIPS(), '- [x] 2026-10-01 טיפ ראשון\n- [x] 2026-10-02 טיפ שני\n');
    const { html, record } = await runBrief(await deps(), { date: DATE, dryRun: false });
    expect(html).toContain('<b>שאלת ראיון</b>\nתור השאלות ריק\n<b>טיפ:</b> טיפ ראשון');
    expect(record.interview).toEqual({ slug: null, tipIndex: 0, marked: true });
    expect(await readFile(TIPS(), 'utf8')).toBe(`- [x] ${DATE} טיפ ראשון\n- [ ] טיפ שני\n`);
  });

  it('an unreadable interview queue marks the section missing and still sends', async () => {
    const { html, record } = await runBrief(
      await deps({ interview: new FileInterviewStore(join(root, 'nope.md'), TIPS()) }),
      { date: DATE, dryRun: false },
    );
    expect(html).toContain('<b>שאלת ראיון</b>\nחסר: שאלת ראיון');
    expect(record.missingSections).toContain('interview');
    expect(record.errors).toContainEqual(expect.objectContaining({ stage: 'interview' }));
    expect(record.interview).toEqual({ slug: null, tipIndex: null, marked: false });
    expect(sender.sent).toHaveLength(1);
  });

  it('v7 criterion 6: "The record stores `interview.slug` and `tipIndex`; no problem text beyond title/slug is stored."', async () => {
    const writer: Writer = {
      name: 'sonnet',
      write: async (input) => ({
        brief: {
          ...templateBrief(input),
          interview: { approach: 'מפת ערכים', complexity: 'O(n) זמן', trap: 'אותו איבר פעמיים' },
        },
      }),
    };
    const { html, record } = await runBrief(await deps({ writer }), { date: DATE, dryRun: false });
    expect(html).toContain('<b>גישה:</b> מפת ערכים\n<b>סיבוכיות:</b> O(n) זמן');
    expect(record.interview).toEqual({ slug: 'two-sum', tipIndex: 0, marked: true });
    const stored = JSON.stringify(record);
    for (const text of ['Two Sum', 'leetcode.com', 'hash map', 'מפת ערכים', 'בראיון התנהגותי'])
      expect(stored).not.toContain(text);
  });

  it('criterion 9: "Cost: the record total equals the sum of per-call costs computed from the price table in `config/prices.json`."', async () => {
    const decisionModel = new FakeDecisionModel();
    const decide = decisionModel.decide.bind(decisionModel);
    decisionModel.decide = async (item) => ({
      ...(await decide(item)),
      call: usage('decision', 'claude-haiku-4-5-20251001', 1),
    });
    const writer: Writer = {
      name: 'sonnet',
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

  it('records each item with the summary the decision model saw, trimmed and redacted', async () => {
    const summary = `Leaked ${API_KEY} ${'x'.repeat(500)}`;
    const item: Item = {
      id: 'https://x/1',
      title: 'Story',
      link: 'https://x/1',
      published: '2026-10-10T03:00:00.000Z',
      summary,
      sources: ['x'],
    };
    const seen: string[] = [];
    const decisionModel = new FakeDecisionModel((i) => {
      seen.push(i.summary);
      return { decision: 'skip' };
    });
    const { record } = await runBrief(await deps({ feeds: [source('x', [item])], decisionModel }), {
      date: DATE,
      dryRun: false,
    });
    const expected = summary.slice(0, RECORD_SUMMARY_CHARS).replace(API_KEY, '[REDACTED]');
    expect(seen).toEqual([summary]);
    expect(record.items).toEqual([
      {
        title: 'Story',
        link: item.link,
        published: item.published,
        summary: expected,
        sources: ['x'],
      },
    ]);
  });

  it('drops writer links to items that were never fetched', async () => {
    const writer: Writer = {
      name: 'sonnet',
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

describe('runBrief calendar', () => {
  const calendarRun = async (calendar: Source<CalendarEvent[]>) =>
    runBrief(await deps({ calendar }), { date: CALENDAR_DATE, dryRun: false });
  const unavailable = (reason: string) => ({
    stage: 'source',
    source: 'calendar',
    reason,
    message: expect.any(String),
  });

  it('v2 criterion 1: "Given a valid hand-off file with three events (one all-day), the brief\'s calendar section lists the all-day event first, then the two timed events in start order with `HH:MM–HH:MM` in Asia/Jerusalem."', async () => {
    const { html, record } = await calendarRun(
      new CalendarFileSource(root, 'Asia/Jerusalem', CALENDAR_SAMPLE),
    );
    expect(html).toContain(`<b>מזג אוויר במודיעין</b>`);
    expect(html.indexOf('<b>היום ביומן</b>')).toBeGreaterThan(html.indexOf('מזג אוויר'));
    expect(html).toContain(SAMPLE_SECTION);
    expect(record.errors).toEqual([]);
  });

  it('v2 criterion 2: "Given a hand-off file with `events: []`, the section says `אין אירועים היום`."', async () => {
    await mkdir(join(root, 'input'));
    await writeFile(
      join(root, 'input', `calendar-${CALENDAR_DATE}.json`),
      JSON.stringify({
        date: CALENDAR_DATE,
        timezone: 'Asia/Jerusalem',
        source: 'google',
        events: [],
      }),
    );
    const { html } = await calendarRun(new CalendarFileSource(root, 'Asia/Jerusalem'));
    expect(html).toContain('<b>היום ביומן</b>\nאין אירועים היום');
  });

  it('v2 criterion 3: "Given no hand-off file, the brief still sends and the section says `היומן לא היה זמין`; the record lists a `calendar` source error with reason `missing`."', async () => {
    const { record } = await calendarRun(new CalendarFileSource(root, 'Asia/Jerusalem'));
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toContain('<b>היום ביומן</b>\nהיומן לא היה זמין');
    expect(record.errors).toEqual([unavailable('missing')]);
    expect(record).toMatchObject({ calendar: null, missingSections: ['calendar'] });
  });

  it.each([
    ['bad JSON', '{"date": "2026-10-11", "events": ['],
    ['wrong shape', JSON.stringify({ date: CALENDAR_DATE, events: [{ title: 'x' }] })],
  ])(
    'v2 criterion 4: "Given an invalid hand-off file (bad JSON or wrong shape), same as 3 with reason `invalid`." (%s)',
    async (_, content) => {
      const path = join(root, 'calendar.json');
      await writeFile(path, content);
      const { record } = await calendarRun(new CalendarFileSource(root, 'Asia/Jerusalem', path));
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]).toContain('<b>היום ביומן</b>\nהיומן לא היה זמין');
      expect(record.errors).toEqual([unavailable('invalid')]);
    },
  );

  it('v2 criterion 5: "The record stores for each event only `title`, `start`, `end`, `allDay`; attendee emails or descriptions present in the file never reach the record (redaction test)."', async () => {
    const { record } = await calendarRun(
      new CalendarFileSource(root, 'Asia/Jerusalem', CALENDAR_SAMPLE),
    );
    expect(record.calendar).toEqual({
      count: 3,
      allDay: 1,
      timed: 2,
      bySource: { google: 3, icloud: 0 },
    });
    const json = JSON.stringify(record);
    for (const leak of ['noy.private@example.com', 'קוד כניסה', 'secret-event-id', 'Zoom', 'משרד'])
      expect(json).not.toContain(leak);
  });

  it('v2 criterion 8: "`--dry-run` reads `test/fixtures/calendar-sample.json` when `--calendar <path>` is passed, so the calendar section can be previewed offline."', async () => {
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
      calendarPath: CALENDAR_SAMPLE,
      print: (t) => printed.push(t),
    });
    const { record } = await runBrief(wired, { date: CALENDAR_DATE, dryRun: true });
    expect(printed[0]).toContain(SAMPLE_SECTION);
    expect(record.errors.some((e) => e.source === 'calendar')).toBe(false);
  });
});

describe('runBrief iCloud', () => {
  const ICLOUD = { username: 'fixture.user@example.invalid', password: 'abcd-efgh-ijkl-mnop' };
  const offline: typeof fetch = async () => {
    throw new TypeError('fetch failed: offline');
  };
  const google = () => new CalendarFileSource(root, 'Asia/Jerusalem', CALENDAR_SAMPLE);
  const icloudVia = (fetchFn: typeof fetch) =>
    new ICloudCalendarSource(ICLOUD, 'Asia/Jerusalem', fetchFn);
  const dryWired = (over: Partial<Parameters<typeof buildDeps>[0]>, printed: string[]) =>
    buildDeps({
      env: { dryRun: true },
      config,
      prices,
      root,
      fetchFn: offline,
      print: (t) => printed.push(t),
      ...over,
    });

  it.each([
    ['ICLOUD_USERNAME', { ICLOUD_APP_PASSWORD: ICLOUD.password }],
    ['ICLOUD_APP_PASSWORD', { ICLOUD_USERNAME: ICLOUD.username }],
  ])(
    'v3 criterion 5: "When `ICLOUD_USERNAME` or `ICLOUD_APP_PASSWORD` is missing, the iCloud source is disabled, the record says so, and the Google file still renders." (%s)',
    async (_, env) => {
      const printed: string[] = [];
      const icloud = loadICloudCredentials(env);
      expect(icloud).toBeNull();
      const wired = dryWired({ icloud, calendarPath: CALENDAR_SAMPLE }, printed);
      expect(wired.icloud).toBeNull();
      const { record } = await runBrief(wired, { date: CALENDAR_DATE, dryRun: true });
      expect(printed[0]).toContain(SAMPLE_SECTION);
      expect(printed[0]).not.toContain('iCloud');
      expect(record.icloud).toBe('disabled');
      expect(record.errors.some((e) => e.source === 'calendar')).toBe(false);
    },
  );

  it.each([
    ['HTTP 401', async () => new Response('', { status: 401 })],
    [
      'a timeout',
      async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
  ])(
    'v3 criterion 6: "When CalDAV returns 401 or times out, the brief still sends with Google events and the `(iCloud לא היה זמין)` note; the record has a `calendar` error with reason `icloud`." (%s)',
    async (_, fetchFn: typeof fetch) => {
      const { html, record } = await runBrief(
        await deps({ calendar: google(), icloud: icloudVia(fetchFn) }),
        { date: CALENDAR_DATE, dryRun: false },
      );
      expect(sender.sent).toHaveLength(1);
      expect(html).toContain(`${SAMPLE_SECTION}\n(iCloud לא היה זמין)`);
      expect(record.errors).toEqual([
        { stage: 'source', source: 'calendar', reason: 'icloud', message: expect.any(String) },
      ]);
      expect(record).toMatchObject({ icloud: 'failed', missingSections: [] });
    },
  );

  it('v3 criterion 7: "The record never contains the Apple ID, the app password or the raw iCalendar text (redaction test using an error message that embeds the request URL with credentials)."', async () => {
    const ics = await fixture('icloud-report.ics');
    const user = encodeURIComponent(ICLOUD.username);
    const leaky: typeof fetch = async (url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      throw new Error(
        `request to ${String(url).replace('//', `//${user}:${ICLOUD.password}@`)} failed ` +
          `(${auth}) for ${ICLOUD.username}; body ${ics}`,
      );
    };
    const secrets = dryWired({ icloud: ICLOUD }, []).secrets;
    expect(secrets).toEqual(expect.arrayContaining([ICLOUD.username, ICLOUD.password]));
    const { record } = await runBrief(
      await deps({ calendar: google(), icloud: icloudVia(leaky), secrets }),
      { date: CALENDAR_DATE, dryRun: false },
    );
    const json = JSON.stringify(record);

    expect(record.errors).toContainEqual(expect.objectContaining({ reason: 'icloud' }));
    expect(json).toContain('caldav.icloud.com');
    for (const leak of [
      ICLOUD.username,
      user,
      ICLOUD.password,
      'BEGIN:VCALENDAR',
      'DTSTART',
      'Basic Zm',
    ])
      expect(json).not.toContain(leak);
  });

  it('v3 criterion 8: "`--dry-run --icloud test/fixtures/icloud-report.ics` previews the iCloud parsing offline."', async () => {
    const printed: string[] = [];
    const wired = dryWired({ icloudPath: 'test/fixtures/icloud-report.ics' }, printed);
    const { record } = await runBrief(wired, { date: '2026-10-12', dryRun: true });
    expect(printed[0]).toContain(
      [
        '<b>היום ביומן</b>',
        'כל היום: יום הולדת לאמא',
        '08:30–09:15 רופא שיניים (מרפאה, רחוב העצמאות 1)',
        '18:00–19:00 אימון ריצה',
      ].join('\n'),
    );
    expect(record.icloud).toBe('ok');
    expect(record.calendar?.bySource).toEqual({ google: 0, icloud: 3 });
    expect(record.errors).toContainEqual(expect.objectContaining({ reason: 'missing' }));
    expect(record.missingSections).not.toContain('calendar');
  });
});

describe('runBrief record privacy', () => {
  const event = (
    title: string,
    start: string,
    source: CalendarEvent['source'],
    allDay = false,
  ): CalendarEvent => ({ title, start, end: start, allDay, time: null, source });

  it('v11 criterion 1: "A delivered run with two Google events and two iCloud events (one all-day) stores `calendar: { count: 4, allDay: 1, timed: 3, bySource: { google: 2, icloud: 2 } }`."', async () => {
    const google = [
      event('פגישה א', '2026-10-11T06:00:00Z', 'google'),
      event('פגישה ב', '2026-10-11T08:00:00Z', 'google'),
    ];
    const icloud = [
      event('חג', '2026-10-11', 'icloud', true),
      event('אימון', '2026-10-11T15:00:00Z', 'icloud'),
    ];
    const { record } = await runBrief(
      await deps({
        calendar: source('calendar', google),
        icloud: source('icloud', icloud),
      }),
      { date: CALENDAR_DATE, dryRun: false },
    );
    expect(record.delivery.status).toBe('sent');
    expect(record.calendar).toEqual({
      count: 4,
      allDay: 1,
      timed: 3,
      bySource: { google: 2, icloud: 2 },
    });
  });

  it('v11 criterion 2: "No calendar event title, location or time from the fixtures appears anywhere in the record JSON (redaction test over the serialised record)."', async () => {
    const tz = 'Asia/Jerusalem';
    const google = await runBrief(
      await deps({ calendar: new CalendarFileSource(root, tz, CALENDAR_SAMPLE) }),
      { date: CALENDAR_DATE, dryRun: false },
    );
    const icloud = await runBrief(
      await deps({ icloud: new ICloudFileSource('test/fixtures/icloud-report.ics', tz) }),
      { date: '2026-10-12', dryRun: false },
    );
    expect(google.record.calendar?.count).toBe(3);
    expect(icloud.record.calendar?.count).toBe(3);
    const json = JSON.stringify([google.record, icloud.record]);
    for (const leak of [
      'ראיון טכני',
      'יום הולדת לנוי',
      'סנכרון צוות',
      'Zoom',
      'משרד',
      'יום הולדת לאמא',
      'רופא שיניים',
      'מרפאה',
      'העצמאות',
      'אימון ריצה',
      'ישיבה שבוטלה',
      '2026-10-11T14:00',
      '2026-10-11T06:30',
      '2026-10-12T08:30',
      '2026-10-12T15:00',
      '09:30',
      '14:00',
      '08:30',
      '09:15',
      '18:00',
      '"start"',
      '"end"',
    ])
      expect(json).not.toContain(leak);
  });

  it('v11 criterion 3: "When both calendars fail the record stores `calendar: null` and the error entries as before."', async () => {
    const { record } = await runBrief(
      await deps({
        calendar: new CalendarFileSource(root, 'Asia/Jerusalem'),
        icloud: source<CalendarEvent[]>('icloud', new Error('HTTP 401')),
      }),
      { date: CALENDAR_DATE, dryRun: false },
    );
    expect(record).toMatchObject({ calendar: null, icloud: 'failed' });
    expect(record.missingSections).toContain('calendar');
    expect(record.errors).toEqual([
      { stage: 'source', source: 'calendar', reason: 'missing', message: expect.any(String) },
      { stage: 'source', source: 'calendar', reason: 'icloud', message: 'HTTP 401' },
    ]);
  });
});

describe('runBrief reminders', () => {
  const TZ = 'Asia/Jerusalem';
  const REMINDERS_DATE = '2026-10-12';
  const events = new ICloudFileSource('test/fixtures/icloud-report.ics', TZ);
  const remindersOf = (path: string): Source<Reminder[]> => ({
    name: 'icloud-reminders',
    fetch: (ctx) => new ICloudFileSource(path, TZ).reminders(ctx),
  });
  const run = async (over: Partial<RunDeps>) =>
    runBrief(await deps({ icloud: events, ...over }), { date: REMINDERS_DATE, dryRun: false });

  it('v8 criterion 4: "The brief renders `תזכורות:` under the events with all-day first, then by time; with zero reminders the sub-block is absent."', async () => {
    const { html } = await run({ reminders: remindersOf('test/fixtures/icloud-reminders.ics') });
    expect(html).toContain(
      [
        '18:00–19:00 אימון ריצה',
        'תזכורות:',
        'כל היום: לשלם חשבון חשמל',
        '17:30 להתקשר לאינסטלטור',
        '',
      ].join('\n'),
    );
    const none = await run({ reminders: remindersOf('test/fixtures/icloud-report.ics') });
    expect(none.html).toContain('18:00–19:00 אימון ריצה\n\n');
    expect(none.html).not.toContain('תזכורות');
  });

  it('v8 criterion 5: "A VTODO query failure records a `calendar` error with reason `icloud-reminders` while events still render."', async () => {
    const failing = source<Reminder[]>('icloud-reminders', new Error('CalDAV REPORT failed: 500'));
    const { html, record } = await run({ reminders: failing });
    expect(html).toContain('18:00–19:00 אימון ריצה');
    expect(html).not.toContain('iCloud לא היה זמין');
    expect(record.errors).toContainEqual({
      stage: 'source',
      source: 'calendar',
      reason: 'icloud-reminders',
      message: 'CalDAV REPORT failed: 500',
    });
    expect(record).toMatchObject({
      icloud: 'ok',
      reminders: { count: 0, source: 'none' },
      missingSections: [],
    });
  });

  it('records one iCloud error when discovery fails for both events and reminders', async () => {
    const down = new Error('CalDAV PROPFIND failed: HTTP 401');
    const { record } = await run({
      icloud: source<CalendarEvent[]>('icloud', down),
      reminders: source<Reminder[]>('icloud-reminders', down),
    });
    expect(record.errors.filter((e) => e.source === 'calendar')).toEqual([
      { stage: 'source', source: 'calendar', reason: 'icloud', message: down.message },
    ]);
  });

  it('v8 criterion 6: "The record stores reminders as `{ title, due, allDay }` only (redaction test: description/alarms never stored)."', async () => {
    const printed: string[] = [];
    const wired = buildDeps({
      env: { dryRun: true },
      config,
      prices,
      root,
      fetchFn: async () => {
        throw new TypeError('fetch failed: offline');
      },
      icloudPath: 'test/fixtures/icloud-reminders.ics',
      print: (t) => printed.push(t),
    });
    const { record } = await runBrief(wired, { date: REMINDERS_DATE, dryRun: true });
    expect(record.reminders).toEqual({ count: 2, source: 'icloud' });
    const json = JSON.stringify(record);
    for (const leak of [
      'פרטים פרטיים',
      'התראה פנימית',
      'VALARM',
      'NEEDS-ACTION',
      'שהושלמה',
      'לשלם חשבון חשמל',
      'להתקשר לאינסטלטור',
      '2026-10-12T14:30',
    ])
      expect(json).not.toContain(leak);
    expect(printed[0]).toContain('תזכורות:\nכל היום: לשלם חשבון חשמל');
  });
});

describe('runBrief reminders from the Shortcut file', () => {
  const TZ = 'Asia/Jerusalem';
  const REMINDERS_DATE = '2026-10-12';
  const FIXTURE = 'test/fixtures/reminders-file.json';
  const ICLOUD_BLOCK = 'תזכורות:\nכל היום: לשלם חשבון חשמל\n17:30 להתקשר לאינסטלטור\n';
  const FILE_BLOCK = 'תזכורות:\nכל היום: להזמין תור לרופא\n16:45 לאסוף חבילה מהדואר\n';
  const icloudReminders: Source<Reminder[]> = {
    name: 'icloud-reminders',
    fetch: (ctx) => new ICloudFileSource('test/fixtures/icloud-reminders.ics', TZ).reminders(ctx),
  };
  const fileWith = async (content: string) => {
    await mkdir(join(root, 'input'), { recursive: true });
    await writeFile(join(root, 'input', `reminders-${REMINDERS_DATE}.json`), content);
    return new RemindersFileSource(root, TZ);
  };
  const run = async (over: Partial<RunDeps>) =>
    runBrief(await deps(over), { date: REMINDERS_DATE, dryRun: true });

  it('v9 criterion 2: "A missing reminders file falls back to the iCloud reminders source; an invalid file records a `calendar` error with reason `reminders-file` and still renders iCloud reminders."', async () => {
    const missing = await run({
      remindersFile: new RemindersFileSource(root, TZ),
      reminders: icloudReminders,
    });
    expect(missing.html).toContain(ICLOUD_BLOCK);
    expect(missing.record.reminders).toEqual({ count: 2, source: 'icloud' });
    expect(missing.record.errors.filter((e) => e.source === 'calendar')).toEqual([]);

    const invalid = await run({ remindersFile: await fileWith('{'), reminders: icloudReminders });
    expect(invalid.html).toContain(ICLOUD_BLOCK);
    expect(invalid.record.reminders).toEqual({ count: 2, source: 'icloud' });
    expect(invalid.record.errors).toContainEqual({
      stage: 'source',
      source: 'calendar',
      reason: 'reminders-file',
      message: 'reminders hand-off file is not valid JSON',
    });
  });

  it('v9 criterion 3: "When both the file and iCloud fail, exactly one error is recorded."', async () => {
    const { record } = await run({
      remindersFile: await fileWith('{'),
      reminders: source<Reminder[]>('icloud-reminders', new Error('CalDAV REPORT failed: 500')),
    });
    expect(record.errors).toEqual([
      expect.objectContaining({ source: 'calendar', reason: 'reminders-file' }),
    ]);
    expect(record.reminders).toEqual({ count: 0, source: 'none' });
  });

  it('does not ask iCloud for reminders when the file exists', async () => {
    const { html, record } = await run({
      remindersFile: new RemindersFileSource(root, TZ, FIXTURE),
      reminders: source<Reminder[]>('icloud-reminders', new Error('must not be called')),
    });
    expect(html).toContain(FILE_BLOCK);
    expect(record.errors).toEqual([]);
    expect(record.reminders).toEqual({ count: 2, source: 'file' });
  });

  it('v9 criterion 4: "The brief renders `תזכורות:` from the file source exactly as from iCloud (same template, no new rendering)."', async () => {
    const sameAsIcloud = {
      date: REMINDERS_DATE,
      timezone: TZ,
      source: 'shortcut',
      reminders: [
        { title: 'להתקשר לאינסטלטור', due: '2026-10-12T17:30:00+03:00', allDay: false },
        { title: 'לשלם חשבון חשמל', due: REMINDERS_DATE, allDay: true },
      ],
    };
    const fromFile = await run({ remindersFile: await fileWith(JSON.stringify(sameAsIcloud)) });
    const fromIcloud = await run({ reminders: icloudReminders });
    expect(fromFile.html).toContain(ICLOUD_BLOCK);
    expect(fromFile.html).toBe(fromIcloud.html);
  });

  it('v9 criterion 5: "The record stores only `reminders: { count, source }`; no title or due value from the file appears anywhere in the record (redaction test)."', async () => {
    const { record } = await run({ remindersFile: new RemindersFileSource(root, TZ, FIXTURE) });
    expect(record.reminders).toEqual({ count: 2, source: 'file' });
    const json = JSON.stringify(record);
    // The all-day due equals the run date, which the record keeps as `date`.
    for (const leak of [
      'לאסוף חבילה מהדואר',
      'להזמין תור לרופא',
      'לחדש את הביטוח',
      '16:45',
      '2026-10-12T16:45',
      '2026-10-12T13:45',
      '2026-10-13T09:00',
    ])
      expect(json).not.toContain(leak);
  });

  it('v9 criterion 6: "`--reminders <path>` renders the fixture in a dry run and marks nothing."', async () => {
    const queues = ['concepts/queue.md', 'interview/problems.md', 'interview/tips.md'];
    const before = await Promise.all(queues.map((q) => readFile(join(root, q), 'utf8')));
    const printed: string[] = [];
    const wired = buildDeps({
      env: { dryRun: true },
      config,
      prices,
      root,
      fetchFn: async () => {
        throw new TypeError('fetch failed: offline');
      },
      remindersPath: parseCli(['--dry-run', '--reminders', FIXTURE]).reminders,
      print: (t) => printed.push(t),
    });
    const { record } = await runBrief(wired, { date: REMINDERS_DATE, dryRun: true });
    expect(printed[0]).toContain(FILE_BLOCK);
    expect(record).toMatchObject({
      reminders: { count: 2, source: 'file' },
      concept: { marked: false },
      interview: { marked: false },
    });
    const after = await Promise.all(queues.map((q) => readFile(join(root, q), 'utf8')));
    expect(after).toEqual(before);
  });
});

describe('runBrief with Jev decisions', () => {
  const OPENROUTER_KEY = 'sk-or-v1-synthetic-test-key';
  const live = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHAT_ID: CHAT_ID,
    ANTHROPIC_API_KEY: API_KEY,
  };
  const liveWired = (over: Partial<Parameters<typeof buildDeps>[0]>) =>
    buildDeps({ env: live, config, prices, root, fetchFn: fetch, ...over });
  const jevVia = (fetchFn: typeof fetch) =>
    new JevDecisionModel(OPENROUTER_KEY, fetchFn, { retryDelayMs: 0 });

  it('v4 criterion 4: "A 429 or 5xx is retried once; a second failure or a timeout records an error and the item is `skip` (the brief still sends)." (end to end)', async () => {
    const unavailable: typeof fetch = async () => new Response('', { status: 503 });
    const { record } = await runBrief(await deps({ decisionModel: jevVia(unavailable) }), {
      date: DATE,
      dryRun: false,
    });
    expect(sender.sent).toHaveLength(1);
    expect(record.decisions.length).toBeGreaterThan(0);
    for (const d of record.decisions) {
      expect(d).toMatchObject({ decision: 'skip', model: JEV_MODEL, error: expect.any(String) });
    }
    expect(record.errors.filter((e) => e.stage === 'decision')).toHaveLength(
      record.decisions.length,
    );
    expect(record.calls.filter((c) => c.role === 'decision')).toEqual([]);
  });

  it('records Jev confidence, probabilities, provider and reported cost', async () => {
    const reply = await readFile('test/fixtures/openrouter-decision.json', 'utf8');
    const ok: typeof fetch = async () => new Response(reply, { status: 200 });
    const { record } = await runBrief(await deps({ decisionModel: jevVia(ok) }), {
      date: DATE,
      dryRun: false,
    });
    expect(record.decisions[0]).toMatchObject({
      decision: 'mention',
      model: JEV_MODEL,
      confidence: 0.82,
      probabilities: { mention: 0.82 },
    });
    const call = record.calls.find((c) => c.role === 'decision');
    expect(call).toMatchObject({ provider: 'openrouter', costUsd: 0.0000824 });
  });

  it('v4 criterion 5: "Selection: `--decider jev` without `OPENROUTER_API_KEY` falls back to Haiku and records the warning; with the key it uses Jev; `config.decisionModel` is honoured when no flag is given; default is Haiku." (wiring and record)', async () => {
    const noKey = liveWired({ decider: 'jev' });
    expect(noKey.decisionModel).toBeInstanceOf(HaikuDecisionModel);
    const { record } = await runBrief(await deps({ warnings: noKey.warnings }), {
      date: DATE,
      dryRun: false,
    });
    expect(record.warnings).toEqual([JEV_NO_KEY_WARNING, MEMORY_NO_KEY_WARNING]);
    expect(
      liveWired({ decider: 'jev', openRouterKey: OPENROUTER_KEY }).decisionModel,
    ).toBeInstanceOf(JevDecisionModel);
    const configured = { ...config, decisionModel: 'jev' as const };
    expect(
      liveWired({ config: configured, openRouterKey: OPENROUTER_KEY }).decisionModel,
    ).toBeInstanceOf(JevDecisionModel);
    expect(liveWired({ openRouterKey: OPENROUTER_KEY }).decisionModel).toBeInstanceOf(
      HaikuDecisionModel,
    );
    expect(config.decisionModel).toBe('haiku');
  });

  it('v4 criterion 6: "The record never contains the OpenRouter key (redaction test with the key inside an error message)."', async () => {
    const leaky: typeof fetch = async (url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      throw new Error(`request to ${String(url)} with ${auth} failed for key ${OPENROUTER_KEY}`);
    };
    const { secrets } = liveWired({ openRouterKey: OPENROUTER_KEY });
    expect(secrets).toContain(OPENROUTER_KEY);
    const { record } = await runBrief(await deps({ decisionModel: jevVia(leaky), secrets }), {
      date: DATE,
      dryRun: false,
    });
    const json = JSON.stringify(record);
    expect(json).toContain('openrouter.ai');
    expect(json).not.toContain(OPENROUTER_KEY);
    expect(json).not.toContain('sk-or-');
  });
});

describe('runBrief weekly footer', () => {
  const SUNDAY = '2026-10-11';
  const day = (date: string, costUsd: number, items: number, errors: number) => ({
    date,
    dryRun: false,
    items: Array.from({ length: items }, (_, i) => ({ title: `t${i}`, link: `l${i}` })),
    calls: [{ role: 'writer', model: 'claude-sonnet-5-5', costUsd }],
    delivery: { sender: 'telegram', status: 'sent' },
    errors: Array.from({ length: errors }, () => ({ stage: 'source', source: 'weather' })),
  });

  async function wiredRun(date: string) {
    const offline: typeof fetch = async () => {
      throw new TypeError('fetch failed: offline');
    };
    const wired = buildDeps({ env: { dryRun: true }, config, prices, root, fetchFn: offline });
    return runBrief(wired, { date, dryRun: true });
  }

  it('v5 criterion 7: "On a Sunday run, the brief footer contains the weekly line with the counts from the previous 7 days; on other days it does not."', async () => {
    await mkdir(join(root, 'runs'));
    const stored = [
      day('2026-10-03', 5, 9, 9),
      day('2026-10-04', 0.01, 3, 1),
      day('2026-10-07', 0.02, 4, 0),
      day('2026-10-10', 0.004, 2, 2),
      day('2026-10-11', 5, 9, 9),
    ];
    for (const r of stored)
      await writeFile(join(root, 'runs', `${r.date}.json`), JSON.stringify(r));
    await writeFile(
      join(root, 'runs', '2026-10-09.dry-run.json'),
      JSON.stringify({ ...day('2026-10-09', 5, 9, 9), dryRun: true }),
    );

    const sunday = await wiredRun(SUNDAY);
    const lines = sunday.html.split('\n');
    expect(lines.at(-3)).toMatch(/^נוצר ב-/);
    expect(lines.at(-2)).toMatch(/^מקור לא זמין: /);
    expect(lines.at(-1)).toBe('השבוע: 3 ימים, עלות ~$0.034, 9 פריטים נבדקו, 3 שגיאות');

    const saturday = await wiredRun(DATE);
    expect(saturday.html).not.toContain('השבוע:');
    expect(saturday.html.split('\n').at(-2)).toMatch(/^נוצר ב-/);
  });

  it('a Sunday with no history says 0 days, and an unreadable history only drops the line', async () => {
    const empty = await runBrief(await deps({ history: async () => [] }), {
      date: SUNDAY,
      dryRun: false,
    });
    expect(empty.html).toContain('השבוע: 0 ימים, עלות ~$0.000, 0 פריטים נבדקו, 0 שגיאות');

    const broken = await runBrief(
      await deps({
        history: async () => {
          throw new Error('runs/2026-10-08.json: invalid JSON');
        },
      }),
      { date: SUNDAY, dryRun: false },
    );
    expect(broken.html).not.toContain('השבוע:');
    expect(broken.record.errors).toContainEqual(
      expect.objectContaining({ stage: 'source', source: 'weekly' }),
    );
    expect(broken.record.delivery.status).toBe('sent');
  });
});

describe('runBrief writer chain and delivery retry', () => {
  type Outcome = 'valid' | 'invalid' | 'throws' | 'throws-with-usage';
  const rung = (name: 'sonnet' | 'haiku', model: string, outcome: Outcome) => ({
    name,
    model,
    write: vi.fn(async (input: WriterInput) => {
      const call = usage('writer', model, 1);
      if (outcome === 'throws') throw new Error('request timed out');
      if (outcome === 'throws-with-usage')
        throw new WriterError('writer stopped with refusal', call);
      const { concept, ...rest } = templateBrief(input);
      return { brief: outcome === 'valid' ? { ...rest, concept } : rest, call };
    }),
  });
  const chainRun = async (sonnet: Outcome, haiku: Outcome) => {
    const rungs = [rung('sonnet', SONNET_MODEL, sonnet), rung('haiku', HAIKU_MODEL, haiku)];
    const writer = new ChainWriter([...rungs, new TemplateWriter()]);
    const { record } = await runBrief(await deps({ writer }), { date: DATE, dryRun: false });
    const writerErrors = record.errors.filter((e) => e.stage === 'writer');
    return { record, writerErrors, sonnet: rungs[0]?.write, haiku: rungs[1]?.write };
  };

  it('v10 criterion 1: "With a Sonnet writer that throws and a Haiku writer that returns a valid brief, the chain returns the Haiku brief, the record says `writer: \'haiku\'` and `writerAttempts: 2`, and the run has one `writer` error naming Sonnet."', async () => {
    const { record, writerErrors } = await chainRun('throws', 'valid');
    expect(record).toMatchObject({ writer: 'haiku', writerAttempts: 2, missingSections: [] });
    expect(writerErrors).toEqual([
      { stage: 'writer', message: `writer ${SONNET_MODEL} failed: request timed out` },
    ]);
    expect(sender.sent).toHaveLength(1);
  });

  it('v10 criterion 2: "With a Sonnet output that fails validation, the chain moves to the next rung instead of using the template directly; with both model rungs failing, the template renders and `writer: \'template\'`, `writerAttempts: 3`."', async () => {
    const next = await chainRun('invalid', 'valid');
    expect(next.haiku).toHaveBeenCalledOnce();
    expect(next.record).toMatchObject({ writer: 'haiku', writerAttempts: 2, missingSections: [] });
    expect(next.writerErrors[0]?.message).toMatch(
      /claude-sonnet-5-5 failed: .*validation.*concept/,
    );

    sender.sent = [];
    const both = await chainRun('invalid', 'throws');
    expect(both.record).toMatchObject({ writer: 'template', writerAttempts: 3 });
    expect(both.writerErrors.map((e) => e.message.split(':')[0])).toEqual([
      `writer ${SONNET_MODEL} failed`,
      `writer ${HAIKU_MODEL} failed`,
    ]);
    expect(sender.sent[0]).toContain('<b>מזג אוויר במודיעין</b>');
  });

  it('v10 criterion 3: "When Sonnet succeeds, Haiku is never called and `writerAttempts` is 1 (spy assertion)."', async () => {
    const { record, sonnet, haiku, writerErrors } = await chainRun('valid', 'valid');
    expect(sonnet).toHaveBeenCalledOnce();
    expect(haiku).not.toHaveBeenCalled();
    expect(record).toMatchObject({ writer: 'sonnet', writerAttempts: 1 });
    expect(record.calls.filter((c) => c.role === 'writer')).toHaveLength(1);
    expect(writerErrors).toEqual([]);
  });

  it('v10 criterion 4: "Cost usage from a failed rung is still included in the record\'s `calls` and total cost."', async () => {
    const [sonnetPrice, haikuPrice] = [prices.models[SONNET_MODEL], prices.models[HAIKU_MODEL]];
    if (!sonnetPrice || !haikuPrice) throw new Error('prices.json lacks a writer model');
    const cost = (p: typeof sonnetPrice) =>
      (1000 * p.input + 100 * p.output + 500 * p.cacheRead + 10 * p.cacheWrite) / 1e6;
    for (const failure of ['throws-with-usage', 'invalid'] as const) {
      const { record } = await chainRun(failure, 'valid');
      const writerCalls = record.calls.filter((c) => c.role === 'writer');
      expect(writerCalls.map((c) => c.model)).toEqual([SONNET_MODEL, HAIKU_MODEL]);
      expect(writerCalls[0]?.costUsd).toBeCloseTo(cost(sonnetPrice), 12);
      expect(writerCalls[1]?.costUsd).toBeCloseTo(cost(haikuPrice), 12);
      expect(record.totalCostUsd).toBeCloseTo(cost(sonnetPrice) + cost(haikuPrice), 12);
    }
  });

  it('v10 criterion 6: "A second Telegram failure still records `delivery.status: \'failed\'` with `attempts: 2` and the run exits non-zero."', async () => {
    let posts = 0;
    const down: typeof fetch = async () => {
      posts++;
      return new Response('Bad Gateway', { status: 502 });
    };
    const telegram = new TelegramSender(TOKEN, CHAT_ID, down, 15_000, 0);
    const { record } = await runBrief(await deps({ sender: telegram }), {
      date: DATE,
      dryRun: false,
    });
    expect(posts).toBe(2);
    expect(record.delivery).toEqual({ sender: 'telegram', status: 'failed', attempts: 2 });
    expect(record.errors).toContainEqual({
      stage: 'delivery',
      message: expect.stringContaining('HTTP 502'),
    });
    expect(record.concept.marked).toBe(false);
    expect(exitCode(record)).toBe(1);
  });

  it('a retried send that succeeds records two attempts and exits zero', async () => {
    const replies = [500, 200];
    const flaky: typeof fetch = async () => new Response('{}', { status: replies.shift() ?? 200 });
    const telegram = new TelegramSender(TOKEN, CHAT_ID, flaky, 15_000, 0);
    const { record } = await runBrief(await deps({ sender: telegram }), {
      date: DATE,
      dryRun: false,
    });
    expect(record.delivery).toEqual({ sender: 'telegram', status: 'sent', attempts: 2 });
    expect(record.errors.filter((e) => e.stage === 'delivery')).toEqual([]);
    expect(exitCode(record)).toBe(0);
  });

  it('wires Sonnet, Haiku and the template when a client exists, the template alone for a dry run', () => {
    const live = {
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: CHAT_ID,
      ANTHROPIC_API_KEY: API_KEY,
    };
    const wired = buildDeps({ env: live, config, prices, root, fetchFn: fetch });
    expect(wired.writer).toBeInstanceOf(ChainWriter);
    expect(wired.writer.name).toBe('sonnet');
    const dry = buildDeps({ env: { dryRun: true }, config, prices, root, fetchFn: fetch });
    expect(dry.writer).toBeInstanceOf(TemplateWriter);
  });
});

describe('runBrief memory', () => {
  const live = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT_ID, ANTHROPIC_API_KEY: API_KEY };
  const VOYAGE_KEY = 'pa-synthetic-voyage-key';
  const indexPath = () => join(root, 'memory', 'index.json');
  const fake = new FakeEmbedder();
  const vector = async (text: string) => (await fake.embed([text])).vectors[0] ?? [];

  class RecordingModel extends FakeDecisionModel {
    received: (DecisionExample[] | undefined)[] = [];
    override async decide(item: Item, examples?: DecisionExample[]) {
      this.received.push(examples);
      return super.decide(item);
    }
  }

  // A past chunk whose text equals today's newest title scores 1, under a different id and title.
  async function writeIndex(): Promise<string> {
    const { record } = await runBrief(await deps(), { date: DATE, dryRun: true });
    const newest = record.items[0]?.title ?? '';
    const chunks: MemoryChunk[] = [
      {
        id: 'past-news',
        kind: 'news',
        text: newest,
        date: '2026-10-09',
        vector: await vector(newest),
        meta: { title: 'Earlier post', link: 'https://example.com/earlier', label: 'must_read' },
      },
      {
        id: 'concept:tool calling',
        kind: 'concept',
        text: 'tool calling',
        date: '2026-10-08',
        vector: await vector('agent loop'),
        meta: { name: 'tool calling' },
      },
    ];
    await saveIndex(indexPath(), { version: 1, model: 'voyage-3.5-lite', dims: 8, chunks });
    records = [];
    sender.sent = [];
    return newest;
  }

  const voyageFetch: typeof fetch = async (_url, init) => {
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    const { vectors } = await fake.embed(input);
    return Response.json({
      data: vectors.map((embedding, index) => ({ embedding, index })),
      usage: { total_tokens: 1000 },
    });
  };

  const memoryOver = (embedder: Embedder) => new MemorySource(indexPath(), embedder, config.memory);

  it('v13 criterion 6: "The record stores `memory` with counts and chunk ids only, and the embed call with its cost; when the index is missing or the embedder throws, the record has one `memory` error and the brief is still delivered with no `seenBefore` and no examples." (counts and cost)', async () => {
    const newest = await writeIndex();
    const decisionModel = new RecordingModel(() => ({ decision: 'must_read' }));
    const memory = memoryOver(new VoyageEmbedder(VOYAGE_KEY, voyageFetch));
    const { record, html } = await runBrief(await deps({ decisionModel, memory }), {
      date: DATE,
      dryRun: false,
    });

    expect(record.memory).toEqual({
      indexSize: 2,
      seenBefore: 1,
      examples: 1,
      related: 1,
      chunkIds: ['past-news', 'concept:tool calling'],
    });
    expect(record.calls[0]).toMatchObject({
      role: 'embed',
      model: 'voyage-3.5-lite',
      inputTokens: 1000,
      costUsd: 0.00002,
    });
    expect(record.totalCostUsd).toBeCloseTo(0.00002, 10);
    expect(JSON.stringify(record.memory)).not.toContain('Earlier post');
    expect(JSON.stringify(record)).not.toContain(VOYAGE_KEY);
    expect(record.decisions[0]).toMatchObject({ title: newest, examples: 1 });
    expect(decisionModel.received[0]).toEqual([
      { title: 'Earlier post', label: 'must_read', score: expect.closeTo(1, 6) },
    ]);
    expect(html).toContain('המשך ל&quot;Earlier post&quot; מה-9.10:');
    expect(record.errors).toEqual([]);
  });

  const broken: Embedder = { model: 'broken', embed: () => Promise.reject(new Error('down')) };

  it.each([
    ['the index is missing', false, new FakeEmbedder()],
    ['the embedder throws', true, broken],
  ])(
    'v13 criterion 6: "The record stores `memory` with counts and chunk ids only, and the embed call with its cost; when the index is missing or the embedder throws, the record has one `memory` error and the brief is still delivered with no `seenBefore` and no examples." (%s)',
    async (_case, withIndex, embedder) => {
      if (withIndex) await writeIndex();
      const decisionModel = new RecordingModel();
      const { record, html } = await runBrief(
        await deps({ decisionModel, memory: memoryOver(embedder) }),
        { date: DATE, dryRun: false },
      );
      expect(record.errors).toEqual([
        { stage: 'source', source: 'memory', message: expect.any(String) },
      ]);
      expect(sender.sent).toHaveLength(1);
      expect(record.delivery.status).toBe('sent');
      expect(record.memory).toBeNull();
      expect(html).not.toContain('המשך ל');
      expect(decisionModel.received.every((e) => e?.length === 0)).toBe(true);
      expect(record.decisions.every((d) => d.examples === 0)).toBe(true);
    },
  );

  it('v13 criterion 7: "With `memory.enabled: false` or no `VOYAGE_API_KEY`, no embed call is made, no error is recorded, and the output equals a v12 run."', async () => {
    await writeIndex();
    const fetchFn = vi.fn<typeof fetch>();
    const disabled = { ...config, memory: { ...config.memory, enabled: false } };
    const wire = (over: Partial<Parameters<typeof buildDeps>[0]>) =>
      buildDeps({ env: live, config, prices, root, fetchFn, ...over });
    const off = wire({ config: disabled, voyageKey: VOYAGE_KEY });
    const noKey = wire({});
    expect(off).toMatchObject({ memory: null, warnings: [MEMORY_DISABLED_WARNING] });
    expect(noKey).toMatchObject({ memory: null, warnings: [MEMORY_NO_KEY_WARNING] });
    expect(wire({ voyageKey: VOYAGE_KEY }).memory).toBeInstanceOf(MemorySource);
    const dry = buildDeps({ env: { dryRun: true }, config, prices, root, fetchFn });
    expect(dry).toMatchObject({ memory: null, warnings: [] });

    const v12 = await runBrief(await deps(), { date: DATE, dryRun: true });
    for (const { memory } of [off, noKey]) {
      const run = await runBrief(await deps({ memory }), { date: DATE, dryRun: true });
      expect(run.html).toBe(v12.html);
      expect(run.record.errors).toEqual([]);
      expect(run.record.memory).toBeNull();
      expect(run.record.calls.filter((c) => c.role === 'embed')).toEqual([]);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a dry run with --memory reads the fixture index with the fake embedder', async () => {
    const offline: typeof fetch = async () => {
      throw new TypeError('fetch failed: offline');
    };
    const wired = buildDeps({
      env: { dryRun: true },
      config,
      prices,
      root,
      fetchFn: offline,
      memoryPath: 'test/fixtures/memory/index.json',
      print: () => undefined,
    });
    const { record } = await runBrief(wired, { date: DATE, dryRun: true });
    expect(record.memory).toMatchObject({ indexSize: 8 });
    expect(record.errors.filter((e) => e.source === 'memory')).toEqual([]);
    expect(record.calls).toEqual([]);
  });
});

describe('runBrief v14', () => {
  const release: Item = {
    id: 'https://pypi.org/project/jev/0.3.0/',
    title: 'jev 0.3.0',
    link: 'https://pypi.org/project/jev/0.3.0/',
    published: '2026-10-08T12:00:00.000Z',
    summary: '',
    sources: ['jev'],
    kind: 'release',
    windowHours: 72,
  };

  class CountingModel extends FakeDecisionModel {
    seen: string[] = [];
    override async decide(item: Item) {
      this.seen.push(item.title);
      return { ...(await super.decide(item)), call: usage('decision', HAIKU_MODEL, 1) };
    }
  }

  const memoryWith = (seen: string[]) =>
    ({
      recall: async () => ({
        indexSize: 1,
        seenBefore: new Map(
          seen.map((id) => [id, { title: 'jev 0.2.0', link: '', date: '2026-10-09', score: 0.9 }]),
        ),
        examples: new Map(),
        relatedConcepts: [],
        chunkIds: [],
        calls: [],
      }),
    }) as unknown as MemorySource;

  it('v14 criterion 2: "An item from a `release` feed is recorded as `must_read` with `reason: "release"` and without a decision call; a bare version title is prefixed with the feed name." (decision)', async () => {
    const decisionModel = new CountingModel();
    const feeds = [source('Simon Willison', atomItems), source('jev', [release])];
    const { record, html } = await runBrief(await deps({ feeds, decisionModel }), {
      date: DATE,
      dryRun: false,
    });

    expect(record.decisions.find((d) => d.title === 'jev 0.3.0')).toEqual({
      title: 'jev 0.3.0',
      link: release.link,
      decision: 'must_read',
      reason: 'release',
      examples: 0,
    });
    expect(decisionModel.seen).not.toContain('jev 0.3.0');
    expect(record.calls.filter((c) => c.role === 'decision')).toHaveLength(
      decisionModel.seen.length,
    );
    expect(record.decisions.filter((d) => !d.reason).every((d) => d.model === HAIKU_MODEL)).toBe(
      true,
    );
    expect(html).toContain(`<a href="${release.link}">jev 0.3.0</a>`);
  });

  it('a release that memory has already shown is skipped, still without a decision call', async () => {
    const decisionModel = new CountingModel();
    const { record, html } = await runBrief(
      await deps({
        feeds: [source('jev', [release])],
        decisionModel,
        memory: memoryWith([release.id]),
      }),
      { date: DATE, dryRun: false },
    );
    expect(record.decisions).toMatchObject([{ decision: 'skip', reason: 'release' }]);
    expect(decisionModel.seen).toEqual([]);
    expect(html).not.toContain('jev 0.3.0');
  });

  it('v14 criterion 5: "A failed feed appears in the brief as a one-line footer note naming the source."', async () => {
    const feeds = [
      source('Simon Willison', atomItems),
      source<Item[]>('Hacker News AI', new Error('HTTP 502')),
    ];
    const failed = await runBrief(await deps({ feeds }), { date: DATE, dryRun: false });
    const lines = failed.html.split('\n');
    expect(lines.filter((l) => l.startsWith('מקור לא זמין'))).toEqual([
      'מקור לא זמין: Hacker News AI',
    ]);
    expect(lines.at(-2)).toMatch(/^נוצר ב-/);
    expect(failed.record.errors).toContainEqual(
      expect.objectContaining({ stage: 'source', source: 'Hacker News AI' }),
    );

    const healthy = await runBrief(await deps(), { date: DATE, dryRun: false });
    expect(healthy.html).not.toContain('מקור לא זמין');
  });
});
