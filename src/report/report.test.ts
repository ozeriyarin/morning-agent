import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HAIKU_MODEL } from '../decide/haiku.js';
import { JEV_MODEL } from '../decide/jev.js';
import { loadRecords, recordSchema, type StoredRecord } from '../records.js';
import { summarise, toJson, toMarkdown } from './report.js';

const SONNET = 'claude-sonnet-5-5';

const call = (role: 'decision' | 'writer', model: string, costUsd: number, over = {}) => ({
  role,
  model,
  inputTokens: 900,
  outputTokens: 33,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  latencyMs: 800,
  costUsd,
  ...over,
});

const item = (title: string) => ({
  title,
  link: `https://example.com/${title.length}`,
  published: '2026-10-04T02:00:00.000Z',
  summary: 'What the model saw.',
  sources: ['Simon Willison'],
});

// Shaped like runs/2026-10-10.json.
const raw = (date: string, over: Record<string, unknown> = {}) => ({
  date,
  generatedAt: `${date}T04:00:05.000Z`,
  dryRun: false,
  fetchedCount: 40,
  items: [item('Claude ships hooks'), item('Desk tips')],
  calendar: [
    {
      title: 'x',
      start: `${date}T06:00:00Z`,
      end: `${date}T07:00:00Z`,
      allDay: false,
      source: 'icloud',
    },
  ],
  icloud: 'ok',
  skippedUnseen: 0,
  decisions: [
    { title: 'Claude ships hooks', link: 'l1', decision: 'must_read', model: HAIKU_MODEL },
    { title: 'Desk tips', link: 'l2', decision: 'skip', model: HAIKU_MODEL },
  ],
  calls: [
    call('decision', HAIKU_MODEL, 0.001),
    call('decision', HAIKU_MODEL, 0.002, { latencyMs: 600 }),
    call('writer', SONNET, 0.01, { inputTokens: 400, cacheReadTokens: 1600, latencyMs: 7000 }),
  ],
  totalCostUsd: 0.013,
  writer: 'ai',
  missingSections: [],
  concept: { name: 'agent loop', queueEmpty: false, marked: true },
  delivery: { sender: 'telegram', status: 'sent' },
  briefChars: 1000,
  errors: [],
  ...over,
});

const parsed = (date: string, over: Record<string, unknown> = {}): StoredRecord =>
  recordSchema.parse(raw(date, over));

async function runsDir(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'report-'));
  for (const [name, body] of Object.entries(files))
    await writeFile(join(dir, name), JSON.stringify(body));
  return dir;
}

describe('report', () => {
  it('v5 criterion 1: "Given three fixture records (one delivered, one with a failed delivery, one dry-run file that must be ignored), `summarise` reports 2 days run, 1 delivered, correct totals of cost and items, and ignores the dry-run file."', async () => {
    const dir = await runsDir({
      '2026-10-04.json': raw('2026-10-04'),
      '2026-10-05.json': raw('2026-10-05', {
        delivery: { sender: 'telegram', status: 'failed' },
        fetchedCount: 10,
        items: [item('Only one')],
        decisions: [{ title: 'Only one', link: 'l', decision: 'mention' }],
        calls: [call('decision', HAIKU_MODEL, 0.004)],
      }),
      '2026-10-06.dry-run.json': raw('2026-10-06', {
        dryRun: true,
        calls: [call('writer', SONNET, 9)],
      }),
    });
    const records = await loadRecords(dir, '2026-10-04', '2026-10-06');
    expect(records.map((r) => r.date)).toEqual(['2026-10-04', '2026-10-05']);

    const { totals, days } = summarise(records);
    expect(totals).toMatchObject({
      daysRun: 2,
      daysDelivered: 1,
      items: { fetched: 50, inWindow: 3, decided: 3 },
    });
    expect(totals.costUsd).toBeCloseTo(0.017, 10);
    expect(totals.meanCostPerDay).toBeCloseTo(0.0085, 10);
    expect(days.map((d) => d.delivery)).toEqual(['sent', 'failed']);
    expect(days[1]?.decisions).toEqual({ must_read: 0, mention: 1, skip: 0 });
    expect(days[0]).toMatchObject({ calendarEvents: 1, icloud: 'ok', concept: 'agent loop' });
    expect(days[0]?.calls.decision).toMatchObject({
      calls: 2,
      inputTokens: 1800,
      meanLatencyMs: 700,
    });
  });

  it('a dry-run record stored under the live name is ignored as well', async () => {
    const dir = await runsDir({ '2026-10-04.json': raw('2026-10-04', { dryRun: true }) });
    expect(await loadRecords(dir, '2026-10-04', '2026-10-04')).toEqual([]);
  });

  it('v5 criterion 2: "Cost by role splits decision and writer costs exactly as the per-call `costUsd` values sum; cost by model groups Haiku, Sonnet and Jev separately."', () => {
    const jevDay = parsed('2026-10-05', {
      calls: [
        call('decision', JEV_MODEL, 0.0002, { provider: 'openrouter' }),
        call('decision', JEV_MODEL, 0.0003, { provider: 'openrouter' }),
        call('writer', SONNET, 0.02),
      ],
    });
    const { totals } = summarise([parsed('2026-10-04'), jevDay]);
    expect(totals.costByRole.decision).toBe(0.001 + 0.002 + 0.0002 + 0.0003);
    expect(totals.costByRole.writer).toBe(0.01 + 0.02);
    expect(totals.costByModel).toEqual({
      [HAIKU_MODEL]: 0.001 + 0.002,
      [SONNET]: 0.01 + 0.02,
      [JEV_MODEL]: 0.0002 + 0.0003,
    });
    expect(totals.meanLatencyMs).toEqual({ decision: 750, writer: 3900 });
  });

  it('v5 criterion 3: "Writer cache hit ratio is `cacheReadTokens / inputTokens` over writer calls, 0 when there are no writer calls."', () => {
    const second = parsed('2026-10-05', {
      calls: [call('writer', SONNET, 0.01, { inputTokens: 600, cacheReadTokens: 400 })],
    });
    expect(summarise([parsed('2026-10-04'), second]).totals.writerCacheHitRatio).toBe(2000 / 1000);
    const noWriter = parsed('2026-10-04', { calls: [call('decision', HAIKU_MODEL, 0.001)] });
    expect(summarise([noWriter]).totals.writerCacheHitRatio).toBe(0);
    expect(summarise([]).totals.writerCacheHitRatio).toBe(0);
  });

  it('v5 criterion 4: "Errors are counted by source name across days (`weather: 1, Hacker News AI: 2`)."', () => {
    const hn = { stage: 'source', source: 'Hacker News AI', message: 'HTTP 502' };
    const records = [
      parsed('2026-10-04', { errors: [hn, { stage: 'source', source: 'weather', message: 'x' }] }),
      parsed('2026-10-05', { errors: [hn] }),
    ];
    const summary = summarise(records);
    expect(summary.totals.errorsBySource).toEqual({ 'Hacker News AI': 2, weather: 1 });
    expect(summary.totals.errors).toBe(3);
    expect(toMarkdown(summary)).toContain('- Errors: 3 (Hacker News AI: 2, weather: 1)');
  });

  it('keeps item titles out of the error tally and keeps the iCloud reason', () => {
    const errors = [
      { stage: 'decision', source: 'Some private title', message: 'bad choice' },
      { stage: 'source', source: 'calendar', reason: 'icloud', message: 'HTTP 401' },
    ];
    const { days, totals } = summarise([parsed('2026-10-04', { errors })]);
    expect(totals.errorsBySource).toEqual({ decision: 1, calendar: 1 });
    expect(days[0]?.errors).toEqual([
      { source: 'decision' },
      { source: 'calendar', reason: 'icloud' },
    ]);
    expect(toJson(summarise([parsed('2026-10-04', { errors })]))).not.toContain('private title');
  });

  it('v5 criterion 5: "`toMarkdown` renders one row per day in date order and a totals block; the numbers match `summarise`."', () => {
    const summary = summarise([
      parsed('2026-10-06', { delivery: { sender: 'telegram', status: 'failed' } }),
      parsed('2026-10-04'),
      parsed('2026-10-05'),
    ]);
    const md = toMarkdown(summary);
    const rows = md.split('\n').filter((line) => /^\| 2026-/.test(line));
    expect(rows.map((r) => r.slice(2, 12))).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
    expect(rows[0]).toContain('| sent | 40 | 2 | 2 | 1 | 0 | 1 |');
    expect(rows[0]).toContain('2 × 1800/66 tok, cache 0, $0.0030, 700 ms');
    expect(rows[0]).toContain('| $0.0130 |');
    expect(rows[2]).toContain('| failed |');
    const t = summary.totals;
    expect(md).toContain('### Totals');
    expect(md).toContain(`- Days run: ${t.daysRun}, delivered: ${t.daysDelivered}`);
    expect(md).toContain('- Days run: 3, delivered: 2');
    expect(md).toContain('- Items: 120 fetched, 6 in window, 6 decided');
    expect(md).toContain(`- Cost: $${t.costUsd.toFixed(4)} (mean $0.0130 per day)`);
    expect(md).toContain('- Cost by role: decision $0.0090, writer $0.0300');
    expect(md).toContain(`- Cost by model: ${HAIKU_MODEL}: $0.0090, ${SONNET}: $0.0300`);
    expect(md).toContain('- Mean latency: decision 700 ms, writer 7000 ms');
    expect(md).toContain(`- Writer cache hit ratio: ${t.writerCacheHitRatio.toFixed(2)}`);
  });

  it('v5 criterion 8: "A record missing optional fields (older schema: no `summary`, no `icloud`, no `decisions[].model`) still summarises without throwing."', async () => {
    const old = raw('2026-10-03', {
      items: [{ title: 'A', link: 'https://x/a', published: '', sources: ['OpenAI News'] }],
      decisions: [{ title: 'A', link: 'https://x/a', decision: 'skip' }],
    });
    delete (old as Partial<typeof old>).icloud;
    const dir = await runsDir({ '2026-10-03.json': old });
    const { days, totals } = summarise(await loadRecords(dir, '2026-10-03', '2026-10-03'));
    expect(days[0]).toMatchObject({ icloud: null, decisions: { skip: 1 } });
    expect(totals.daysRun).toBe(1);
    expect(() =>
      toMarkdown(summarise([recordSchema.parse({ date: '2026-10-01', items: [] })])),
    ).not.toThrow();
  });

  it('v11 criterion 4: "Older records with the array shape still load, and the report\'s per-day event count is the array length for them and `count` for new ones."', async () => {
    const v11 = { calendar: { count: 4, allDay: 1, timed: 3, bySource: { google: 2, icloud: 2 } } };
    const dir = await runsDir({
      '2026-10-10.json': raw('2026-10-10'),
      '2026-10-11.json': raw('2026-10-11', v11),
      '2026-10-12.json': raw('2026-10-12', { calendar: null }),
    });
    const { days } = summarise(await loadRecords(dir, '2026-10-10', '2026-10-12'));
    expect(days.map((d) => d.calendarEvents)).toEqual([1, 4, null]);
  });

  it('reads records with the v8 reminders array, the v9 reminders object, or none', () => {
    const v8 = { reminders: [{ title: 'x', due: '2026-10-11', allDay: true }] };
    const v9 = { reminders: { count: 1, source: 'file' } };
    const days = [raw('2026-10-11', v8), raw('2026-10-12', v9), raw('2026-10-13')];
    expect(summarise(days.map((d) => recordSchema.parse(d))).totals.daysRun).toBe(3);
  });
});
