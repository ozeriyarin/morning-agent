import { describe, expect, it } from 'vitest';
import { clockTime, dayMonth, hebrewWeekday, isIsoDate, todayIn, zonedTime } from './dates.js';

const tz = 'Asia/Jerusalem';

describe('dates', () => {
  it.each([
    ['2026-10-10', '07:00', '2026-10-10T04:00:00.000Z'],
    ['2026-12-01', '07:00', '2026-12-01T05:00:00.000Z'],
  ])('zonedTime(%s %s) is %s in UTC across DST', (date, time, iso) => {
    expect(zonedTime(date, time, tz).toISOString()).toBe(iso);
  });

  it('formats the header parts and the footer clock in Israel time', () => {
    expect(hebrewWeekday('2026-10-10')).toBe('שבת');
    expect(dayMonth('2026-10-09')).toBe('9.10');
    expect(clockTime(new Date('2026-10-10T04:05:00Z'), tz)).toBe('07:05');
    expect(todayIn(tz, new Date('2026-10-09T22:30:00Z'))).toBe('2026-10-10');
  });

  it.each([
    ['2026-10-10', true],
    ['2026-13-40', false],
    ['10.10.2026', false],
  ])('isIsoDate(%s) is %s', (value, ok) => {
    expect(isIsoDate(value)).toBe(ok);
  });
});
