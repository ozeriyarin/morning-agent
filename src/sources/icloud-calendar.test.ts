import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { SourceError, type CalendarEvent } from '../types.js';
import { ICloudCalendarSource, onDay, parseICalendar } from './icloud-calendar.js';

const TZ = 'Asia/Jerusalem';
const DATE = '2026-10-12';
const ctx = { date: DATE, reference: new Date('2026-10-12T04:00:00Z') };
const CREDENTIALS = { username: 'fixture.user@example.invalid', password: 'abcd-efgh-ijkl-mnop' };
const HOME = 'https://p01-caldav.icloud.com/10000000001/calendars/';

const fixture = (name: string) => readFile(`test/fixtures/${name}`, 'utf8');
const ics = await fixture('icloud-report.ics');
const propfind: Record<string, string> = {
  'https://caldav.icloud.com/': await fixture('icloud-propfind-principal.xml'),
  'https://caldav.icloud.com/10000000001/principal/': await fixture('icloud-propfind-home.xml'),
  [HOME]: await fixture('icloud-propfind-calendars.xml'),
};

const multistatus = (responses: string) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`;
const reportXml = (data: string) =>
  multistatus(
    `<d:response><d:href>/10000000001/calendars/home/e1.ics</d:href><d:propstat><d:prop>` +
      `<c:calendar-data>${data}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status>` +
      `</d:propstat></d:response>`,
  );

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: unknown;
}

function caldav(
  reports: Record<string, string>,
  over: Record<string, Response> = {},
  duringReport = async () => {},
) {
  const sent: Sent[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    sent.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
      signal: init?.signal,
    });
    if (init?.method === 'REPORT') await duringReport();
    const override = over[url];
    if (override) return override;
    const body = init?.method === 'REPORT' ? (reports[url] ?? multistatus('')) : propfind[url];
    return body === undefined
      ? new Response('', { status: 404 })
      : new Response(body, { status: 207 });
  };
  return { sent, source: new ICloudCalendarSource(CREDENTIALS, TZ, fetchFn) };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

describe('ICloudCalendarSource', () => {
  it('v3 criterion 1: "Given captured PROPFIND fixtures, discovery yields the calendar home and the list of VEVENT calendars with display names."', async () => {
    const { source, sent } = caldav({});
    expect(await source.discover()).toEqual({
      home: HOME,
      calendars: [
        { url: `${HOME}home/`, name: 'בית' },
        { url: `${HOME}work/`, name: 'Work' },
      ],
    });
    expect(sent.map((r) => [r.method, r.headers.Depth])).toEqual([
      ['PROPFIND', '0'],
      ['PROPFIND', '0'],
      ['PROPFIND', '1'],
    ]);
    const basic = Buffer.from(`${CREDENTIALS.username}:${CREDENTIALS.password}`).toString('base64');
    expect(sent.every((r) => r.headers.Authorization === `Basic ${basic}`)).toBe(true);
    expect(sent[0]?.body).toContain('current-user-principal');
    expect(sent[1]?.body).toContain('calendar-home-set');
  });

  it('v3 criterion 2: "Given a captured REPORT response with three events (one all-day DATE, one DATE-TIME with TZID Asia/Jerusalem, one UTC `Z`), parsing yields three `CalendarEvent`s with correct local times and `allDay` flags."', async () => {
    const { source, sent } = caldav({ [`${HOME}home/`]: reportXml(ics) });
    expect(await source.fetch(ctx)).toEqual([
      {
        title: 'יום הולדת לאמא',
        start: '2026-10-12',
        end: '2026-10-13',
        allDay: true,
        time: null,
        source: 'icloud',
      },
      {
        title: 'רופא שיניים',
        start: '2026-10-12T05:30:00.000Z',
        end: '2026-10-12T06:15:00.000Z',
        allDay: false,
        location: 'מרפאה, רחוב העצמאות 1',
        time: '08:30–09:15',
        source: 'icloud',
      },
      {
        title: 'אימון ריצה',
        start: '2026-10-12T15:00:00.000Z',
        end: '2026-10-12T16:00:00.000Z',
        allDay: false,
        time: '18:00–19:00',
        source: 'icloud',
      },
    ]);
    const reports = sent.filter((r) => r.method === 'REPORT');
    expect(reports.map((r) => r.url)).toEqual([`${HOME}home/`, `${HOME}work/`]);
    expect(reports[0]?.headers.Depth).toBe('1');
    expect(reports[0]?.body).toContain(
      '<c:expand start="20261011T210000Z" end="20261012T210000Z"/>',
    );
    expect(reports[0]?.body).toContain('<c:comp-filter name="VEVENT"><c:time-range');
    expect(sent.every((r) => r.signal instanceof AbortSignal)).toBe(true);
  });

  it('v3 criterion 3: "A `STATUS:CANCELLED` VEVENT is dropped."', () => {
    expect(ics).toContain('STATUS:CANCELLED');
    const titles = parseICalendar(ics, TZ).map((e) => e.title);
    expect(titles).toHaveLength(3);
    expect(titles).not.toContain('ישיבה שבוטלה');
  });

  it('queries at most 3 calendars in parallel', async () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const listing = multistatus(
      names
        .map(
          (n) =>
            `<d:response><d:href>/10000000001/calendars/${n}/</d:href><d:propstat><d:prop>` +
            `<d:displayname>${n}</d:displayname><d:resourcetype><c:calendar/></d:resourcetype>` +
            `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
        )
        .join(''),
    );
    let inFlight = 0;
    let peak = 0;
    const { source } = caldav({}, { [HOME]: new Response(listing, { status: 207 }) }, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(await source.fetch(ctx)).toEqual([]);
    expect(peak).toBe(3);
  });

  it('fails with reason icloud on HTTP 401, without echoing the credentials', async () => {
    const { source } = caldav(
      {},
      { 'https://caldav.icloud.com/': new Response('', { status: 401 }) },
    );
    const error = await failure(source.fetch(ctx));
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ source: 'calendar', reason: 'icloud' });
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain(CREDENTIALS.password);
  });

  it('never sends the credentials outside icloud.com', async () => {
    const home = propfind['https://caldav.icloud.com/10000000001/principal/'] ?? '';
    const evil = home.replace('p01-caldav.icloud.com:443', 'icloud.com.evil.example');
    const { source, sent } = caldav(
      {},
      { 'https://caldav.icloud.com/10000000001/principal/': new Response(evil, { status: 207 }) },
    );
    expect(await failure(source.discover())).toMatchObject({ reason: 'icloud' });
    expect(sent.some((r) => r.url.includes('evil'))).toBe(false);
  });

  it('rejects a response over 1 MB', async () => {
    const big = new Response('x'.repeat(1_000_001), { status: 207 });
    const { source } = caldav({}, { 'https://caldav.icloud.com/': big });
    expect(await failure(source.discover())).toMatchObject({
      message: expect.stringContaining('1 MB'),
    });
  });
});

describe('parseICalendar', () => {
  const vevent = (...lines: string[]) =>
    ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\n');

  it.each([
    [
      'floating time in the default zone, no DTEND',
      ['DTSTART:20261012T070000', 'SUMMARY:x'],
      '07:00–07:00',
    ],
    ['DATE without DTEND lasts one day', ['DTSTART;VALUE=DATE:20261012', 'SUMMARY:x'], null],
    [
      'quoted TZID',
      [
        'DTSTART;TZID="Asia/Jerusalem":20261012T100000',
        'DTEND;TZID="Asia/Jerusalem":20261012T110000',
        'SUMMARY:x',
      ],
      '10:00–11:00',
    ],
  ])('reads %s', (_, lines, time) => {
    expect(parseICalendar(vevent(...lines), TZ)).toEqual([expect.objectContaining({ time })]);
  });

  it('throws reason icloud on a VEVENT without DTSTART, without echoing the text', () => {
    expect(() => parseICalendar(vevent('SUMMARY:סוד'), TZ)).toThrow(
      expect.objectContaining({ reason: 'icloud', message: expect.not.stringContaining('סוד') }),
    );
  });
});

describe('onDay', () => {
  const event = (start: string, end: string, allDay: boolean): CalendarEvent => ({
    title: 't',
    start,
    end,
    allDay,
    time: null,
    source: 'icloud',
  });

  it.each([
    [event('2026-10-11', '2026-10-12', true), false],
    [event('2026-10-12', '2026-10-13', true), true],
    [event('2026-10-10', '2026-10-15', true), true],
    [event('2026-10-11T20:00:00Z', '2026-10-11T21:00:00Z', false), false],
    [event('2026-10-11T20:30:00Z', '2026-10-11T21:30:00Z', false), true],
    [event('2026-10-12T21:00:00Z', '2026-10-12T22:00:00Z', false), false],
  ])('keeps %j: %s', (e, kept) => {
    expect(onDay([e], DATE, TZ)).toHaveLength(kept ? 1 : 0);
  });
});
