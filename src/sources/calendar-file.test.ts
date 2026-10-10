import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SourceError } from '../types.js';
import { CalendarFileSource, parseCalendarFile } from './calendar-file.js';

const DATE = '2026-10-11';
const TZ = 'Asia/Jerusalem';
const ctx = { date: DATE, reference: new Date('2026-10-11T04:00:00Z') };
const sample: unknown = JSON.parse(await readFile('test/fixtures/calendar-sample.json', 'utf8'));

async function sourceWith(content?: string): Promise<CalendarFileSource> {
  const root = await mkdtemp(join(tmpdir(), 'calendar-'));
  await mkdir(join(root, 'input'));
  if (content !== undefined) await writeFile(join(root, 'input', `calendar-${DATE}.json`), content);
  return new CalendarFileSource(root, TZ);
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

describe('CalendarFileSource', () => {
  it('sorts all-day events first, then timed ones by start, with Asia/Jerusalem times', () => {
    expect(parseCalendarFile(sample, DATE, TZ)).toEqual([
      expect.objectContaining({ title: 'יום הולדת לנוי', allDay: true, time: null }),
      expect.objectContaining({ title: 'סנכרון צוות', time: '09:30–10:00', location: 'משרד' }),
      expect.objectContaining({ title: 'ראיון טכני', time: '14:00–15:00', location: 'Zoom' }),
    ]);
  });

  it('reads input/calendar-<date>.json under the root by default', async () => {
    const source = await sourceWith(JSON.stringify(sample));
    expect((await source.fetch(ctx)).map((e) => e.title)).toEqual([
      'יום הולדת לנוי',
      'סנכרון צוות',
      'ראיון טכני',
    ]);
  });

  it('accepts an empty events list', () => {
    expect(
      parseCalendarFile({ date: DATE, timezone: TZ, source: 'google', events: [] }, DATE, TZ),
    ).toEqual([]);
  });

  it('fails with reason missing when there is no hand-off file', async () => {
    expect(await failure((await sourceWith()).fetch(ctx))).toMatchObject({
      source: 'calendar',
      reason: 'missing',
    });
  });

  it.each([
    ['bad JSON', '{"date": "2026-10-11", "events": ['],
    ['wrong shape', JSON.stringify({ date: DATE, events: [{ title: 'x', start: 5 }] })],
    ['another day', JSON.stringify({ ...(sample as object), date: '2026-10-10' })],
  ])('fails with reason invalid on %s, without echoing the file', async (_, content) => {
    const error = await failure((await sourceWith(content)).fetch(ctx));
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ source: 'calendar', reason: 'invalid' });
    expect((error as Error).message).not.toContain('"date"');
  });
});
