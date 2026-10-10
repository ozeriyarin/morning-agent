import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  briefConfigSchema,
  loadICloudCredentials,
  loadJson,
  pricesSchema,
  type Prices,
} from '../config.js';
import { FakeDecisionModel } from '../decide/fake.js';
import { HaikuDecisionModel } from '../decide/haiku.js';
import { JEV_MODEL, JevDecisionModel } from '../decide/jev.js';
import { JEV_NO_KEY_WARNING } from '../decide/select.js';
import { TelegramSender } from '../deliver/telegram.js';
import { CalendarFileSource } from '../sources/calendar-file.js';
import { ICloudCalendarSource } from '../sources/icloud-calendar.js';
import { FileConceptStore } from '../sources/concepts.js';
import { FileInterviewStore } from '../sources/interview.js';
import { parseFeed } from '../sources/feeds.js';
import type {
  CalendarEvent,
  CallUsage,
  Item,
  RunRecord,
  Sender,
  Source,
  WeatherDay,
  Writer,
} from '../types.js';
import { MAX_BRIEF_CHARS, templateBrief, TemplateWriter } from '../write/template.js';
import { MAX_DECISIONS, RECORD_SUMMARY_CHARS, runBrief, type RunDeps } from './run-brief.js';
import { buildDeps } from './wiring.js';

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
    return { status: 'sent' as const };
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
  const queue = await readFile('concepts/queue.md', 'utf8');
  await writeFile(join(root, 'concepts', 'queue.md'), queue.replace(/- \[x\] \S+ /g, '- [ ] '));
  await mkdir(join(root, 'interview'));
  await writeFile(PROBLEMS(), await readFile('interview/problems.md', 'utf8'));
  await writeFile(TIPS(), await readFile('interview/tips.md', 'utf8'));
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
      mode: 'ai',
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
    expect(record.calendar).toEqual([
      {
        title: 'יום הולדת לנוי',
        start: '2026-10-11',
        end: '2026-10-12',
        allDay: true,
        source: 'google',
      },
      {
        title: 'סנכרון צוות',
        start: '2026-10-11T06:30:00Z',
        end: '2026-10-11T07:00:00Z',
        allDay: false,
        source: 'google',
      },
      {
        title: 'ראיון טכני',
        start: '2026-10-11T14:00:00+03:00',
        end: '2026-10-11T15:00:00+03:00',
        allDay: false,
        source: 'google',
      },
    ]);
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
    expect(record.calendar?.map((e) => e.source)).toEqual(['icloud', 'icloud', 'icloud']);
    expect(record.errors).toContainEqual(expect.objectContaining({ reason: 'missing' }));
    expect(record.missingSections).not.toContain('calendar');
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
    expect(record.warnings).toEqual([JEV_NO_KEY_WARNING]);
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
    expect(lines.at(-2)).toMatch(/^נוצר ב-/);
    expect(lines.at(-1)).toBe('השבוע: 3 ימים, עלות ~$0.034, 9 פריטים נבדקו, 3 שגיאות');

    const saturday = await wiredRun(DATE);
    expect(saturday.html).not.toContain('השבוע:');
    expect(saturday.html.split('\n').at(-1)).toMatch(/^נוצר ב-/);
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
