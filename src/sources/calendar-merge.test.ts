import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../types.js';
import { mergeCalendars } from './calendar-merge.js';

const event = (
  source: CalendarEvent['source'],
  title: string,
  start: string,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent => ({
  title,
  start,
  end: start,
  allDay: start.length === 10,
  time: null,
  source,
  ...extra,
});

describe('mergeCalendars', () => {
  it('v3 criterion 4: "`mergeCalendars` shows an event present in both Google and iCloud once, keeps the Google copy, and sorts all-day first then by start."', () => {
    const google = [
      event('google', 'Team Sync', '2026-10-11T14:00:00+03:00', { location: 'Zoom' }),
      event('google', 'יום הולדת לנוי', '2026-10-11'),
    ];
    const icloud = [
      event('icloud', '  team   sync ', '2026-10-11T11:00:30.000Z', { location: 'Office' }),
      event('icloud', 'אימון ריצה', '2026-10-11T07:00:00.000Z'),
      event('icloud', 'Team Sync', '2026-10-11T12:00:00.000Z'),
      event('icloud', 'חג', '2026-10-11'),
    ];
    expect(mergeCalendars(google, icloud).map((e) => [e.title, e.source, e.location])).toEqual([
      ['יום הולדת לנוי', 'google', undefined],
      ['חג', 'icloud', undefined],
      ['אימון ריצה', 'icloud', undefined],
      ['Team Sync', 'google', 'Zoom'],
      ['Team Sync', 'icloud', undefined],
    ]);
  });
});
