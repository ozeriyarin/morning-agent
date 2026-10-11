import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SourceError } from '../types.js';
import { parseRemindersFile, RemindersFileSource } from './reminders-file.js';

const DATE = '2026-10-12';
const TZ = 'Asia/Jerusalem';
const ctx = { date: DATE, reference: new Date('2026-10-12T04:00:00Z') };
const sample = JSON.parse(await readFile('test/fixtures/reminders-file.json', 'utf8')) as {
  reminders: unknown[];
};

async function sourceWith(content?: string): Promise<RemindersFileSource> {
  const root = await mkdtemp(join(tmpdir(), 'reminders-'));
  await mkdir(join(root, 'input'));
  if (content !== undefined)
    await writeFile(join(root, 'input', `reminders-${DATE}.json`), content);
  return new RemindersFileSource(root, TZ);
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

describe('RemindersFileSource', () => {
  it('v9 criterion 1: "The reminders file for today yields its reminders sorted all-day first then by time, with `HH:MM` times in the configured zone; a reminder dated another day is dropped."', () => {
    expect(parseRemindersFile(sample, DATE, TZ)).toEqual([
      { title: 'להזמין תור לרופא', due: DATE, allDay: true, time: null },
      {
        title: 'לאסוף חבילה מהדואר',
        due: '2026-10-12T13:45:00.000Z',
        allDay: false,
        time: '16:45',
      },
    ]);
  });

  it('takes the local date of an all-day reminder sent as a full datetime', () => {
    const raw = {
      ...sample,
      reminders: [{ title: 'יום הולדת', due: '2026-10-12T00:00:00+03:00', allDay: true }],
    };
    expect(parseRemindersFile(raw, DATE, TZ)).toEqual([
      { title: 'יום הולדת', due: DATE, allDay: true, time: null },
    ]);
  });

  it.each([
    ['absent at local 00:00', '2026-10-12T00:00:00+03:00', undefined, null],
    ['absent at 16:45', '2026-10-12T16:45:00+03:00', undefined, '16:45'],
    ['explicitly false at local 00:00', '2026-10-12T00:00:00+03:00', false, '00:00'],
  ])('resolves allDay when %s', (_, due, allDay, time) => {
    const raw = { ...sample, reminders: [{ title: 'תזכורת', due, allDay }] };
    expect(parseRemindersFile(raw, DATE, TZ)).toMatchObject([{ allDay: time === null, time }]);
  });

  it('reads input/reminders-<date>.json under the root by default', async () => {
    const source = await sourceWith(JSON.stringify(sample));
    expect((await source.fetch(ctx)).map((r) => r.title)).toEqual([
      'להזמין תור לרופא',
      'לאסוף חבילה מהדואר',
    ]);
  });

  it('fails with reason missing when there is no hand-off file', async () => {
    expect(await failure((await sourceWith()).fetch(ctx))).toMatchObject({
      source: 'calendar',
      reason: 'missing',
    });
  });

  it.each([
    ['bad JSON', '{"date": "2026-10-12", "reminders": ['],
    ['a bare array', JSON.stringify(sample.reminders)],
    ['wrong shape', JSON.stringify({ ...sample, reminders: [{ title: 'x', due: 'soon' }] })],
    ['another day', JSON.stringify({ ...sample, date: '2026-10-11' })],
  ])('fails with reason invalid on %s, without echoing the file', async (_, content) => {
    const error = await failure((await sourceWith(content)).fetch(ctx));
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ source: 'calendar', reason: 'invalid' });
    expect((error as Error).message).not.toContain('לאסוף');
  });
});
