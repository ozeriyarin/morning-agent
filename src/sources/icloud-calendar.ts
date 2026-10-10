import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { zonedTime } from '../dates.js';
import { SourceError, type CalendarEvent, type FetchContext, type Source } from '../types.js';
import { eventTime } from './calendar-file.js';

export interface ICloudCredentials {
  username: string;
  password: string;
}

export interface ICloudDiscovery {
  home: string;
  calendars: { url: string; name: string }[];
}

const CALDAV_ROOT = 'https://caldav.icloud.com/';
const TIMEOUT_MS = 25_000;
const MAX_BYTES = 1_000_000;
const PARALLEL_CALENDARS = 3;
const MAX_REDIRECTS = 3;

const failure = (message: string) => new SourceError('calendar', message, 'icloud');

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// Matches DATE (all-day) and DATE-TIME values: UTC with Z, wall clock in TZID, or floating.
function icalTime(value: string, tzid: string | undefined, timeZone: string) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value.trim());
  if (!m) throw failure('iCalendar has an unreadable date-time');
  const [, y, mo, d, h, mi, s, z] = m;
  const date = `${y}-${mo}-${d}`;
  if (h === undefined) return { iso: date, allDay: true };
  const instant = z
    ? new Date(`${date}T${h}:${mi}:${s}Z`)
    : new Date(zonedTime(date, `${h}:${mi}`, tzid ?? timeZone).getTime() + Number(s) * 1000);
  return { iso: instant.toISOString(), allDay: false };
}

interface Property {
  name: string;
  tzid?: string;
  value: string;
}

function property(line: string): Property | null {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) {
      const [name = '', ...params] = line.slice(0, i).split(';');
      const tzid = params
        .find((p) => /^TZID=/i.test(p))
        ?.slice(5)
        .replace(/^"|"$/g, '');
      return { name: name.toUpperCase(), tzid, value: line.slice(i + 1) };
    }
  }
  return null;
}

const unescapeText = (value: string) =>
  value.replace(/\\([\\;,nN])/g, (_, c: string) => (c.toLowerCase() === 'n' ? ' ' : c)).trim();

function toEvent(props: Map<string, Property>, timeZone: string): CalendarEvent | null {
  if (props.get('STATUS')?.value.trim().toUpperCase() === 'CANCELLED') return null;
  const dtstart = props.get('DTSTART');
  if (!dtstart) throw failure('iCalendar VEVENT has no DTSTART');
  const start = icalTime(dtstart.value, dtstart.tzid, timeZone);
  const dtend = props.get('DTEND');
  const end = dtend
    ? icalTime(dtend.value, dtend.tzid, timeZone).iso
    : start.allDay
      ? nextDay(start.iso)
      : start.iso;
  const location = unescapeText(props.get('LOCATION')?.value ?? '');
  return {
    title: unescapeText(props.get('SUMMARY')?.value ?? '') || 'ללא כותרת',
    start: start.iso,
    end,
    allDay: start.allDay,
    ...(location && { location }),
    time: eventTime(start.iso, end, start.allDay, timeZone),
    source: 'icloud',
  };
}

// Unfolds lines and reads each VEVENT, ignoring nested components such as VALARM.
export function parseICalendar(text: string, timeZone: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const stack: string[] = [];
  let props = new Map<string, Property>();
  for (const line of text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    const p = property(line);
    if (!p) continue;
    const component = p.value.trim().toUpperCase();
    if (p.name === 'BEGIN') {
      stack.push(component);
      if (component === 'VEVENT') props = new Map();
    } else if (p.name === 'END') {
      const event = stack.pop() === 'VEVENT' ? toEvent(props, timeZone) : null;
      if (event) events.push(event);
    } else if (stack.at(-1) === 'VEVENT' && !props.has(p.name)) props.set(p.name, p);
  }
  return events;
}

// Keeps events that overlap the local day; servers may include the neighbouring all-day events.
export function onDay(events: CalendarEvent[], date: string, timeZone: string): CalendarEvent[] {
  const dayStart = zonedTime(date, '00:00', timeZone).getTime();
  const dayEnd = zonedTime(nextDay(date), '00:00', timeZone).getTime();
  return events.filter((e) => {
    if (e.allDay) return e.start <= date && date < e.end;
    const start = Date.parse(e.start);
    return start < dayEnd && (Date.parse(e.end) > dayStart || start >= dayStart);
  });
}

const xml = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  parseTagValue: false,
  isArray: (name) => ['response', 'propstat', 'comp'].includes(name),
});

type Node = Record<string, unknown>;
const asNode = (value: unknown): Node =>
  value && typeof value === 'object' ? (value as Node) : {};
const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : (asNode(value)['#text'] as string | undefined);

// Each multistatus response with the merged props of its 200 propstats.
export function davResponses(text: string): { href: string; prop: Node }[] {
  const responses = asNode(asNode(xml.parse(text)).multistatus).response;
  return (Array.isArray(responses) ? responses : []).map((r: unknown) => {
    const propstats = asNode(r).propstat;
    const ok = (Array.isArray(propstats) ? propstats : [])
      .map(asNode)
      .filter((ps) => / 200 /.test(textOf(ps.status) ?? ''));
    return {
      href: textOf(asNode(r).href) ?? '',
      prop: Object.assign({}, ...ok.map((ps) => asNode(ps.prop))) as Node,
    };
  });
}

// Credentials only ever go to https://*.icloud.com, whatever the server's hrefs say.
function icloudUrl(href: string, base: string): string {
  const url = new URL(href, base);
  const host = url.hostname;
  if (url.protocol !== 'https:' || !(host === 'icloud.com' || host.endsWith('.icloud.com')))
    throw failure(`CalDAV pointed outside icloud.com (${host})`);
  return url.href;
}

const davTime = (instant: Date) =>
  instant
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

const DAV = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';
const propfindBody = (props: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind ${DAV}><d:prop>${props}</d:prop></d:propfind>`;
const reportBody = (start: string, end: string) =>
  `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${DAV}><d:prop><c:calendar-data>` +
  `<c:expand start="${start}" end="${end}"/></c:calendar-data></d:prop><c:filter>` +
  `<c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
  `<c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter>` +
  `</c:calendar-query>`;

// Reads today's VEVENTs from iCloud over CalDAV (Basic auth, app-specific password).
export class ICloudCalendarSource implements Source<CalendarEvent[]> {
  readonly name = 'icloud';
  private readonly auth: string;
  private discovery?: Promise<ICloudDiscovery>;

  constructor(
    credentials: ICloudCredentials,
    private readonly timeZone: string,
    private readonly fetchFn: typeof fetch,
  ) {
    const pair = `${credentials.username}:${credentials.password}`;
    this.auth = `Basic ${Buffer.from(pair).toString('base64')}`;
  }

  private async dav(method: 'PROPFIND' | 'REPORT', url: string, depth: '0' | '1', body: string) {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await this.fetchFn(target, {
        method,
        redirect: 'manual',
        headers: { Authorization: this.auth, Depth: depth, 'Content-Type': 'application/xml' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        target = icloudUrl(location, target);
        continue;
      }
      if (response.status !== 207 && !response.ok)
        throw failure(`CalDAV ${method} failed: HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_BYTES)
        throw failure(`CalDAV ${method} response is over 1 MB`);
      return { text, url: target };
    }
    throw failure('CalDAV redirected too many times');
  }

  private async findHref(url: string, prop: string, body: string): Promise<string> {
    const { text, url: base } = await this.dav('PROPFIND', url, '0', propfindBody(body));
    const href = textOf(asNode(davResponses(text)[0]?.prop[prop]).href);
    if (!href) throw failure(`CalDAV discovery found no ${prop}`);
    return icloudUrl(href, base);
  }

  // Principal, then calendar home, then the calendars in it that accept VEVENTs.
  async discover(): Promise<ICloudDiscovery> {
    const principal = await this.findHref(
      CALDAV_ROOT,
      'current-user-principal',
      '<d:current-user-principal/>',
    );
    const home = await this.findHref(principal, 'calendar-home-set', '<c:calendar-home-set/>');
    const listing = await this.dav(
      'PROPFIND',
      home,
      '1',
      propfindBody('<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>'),
    );
    const calendars = davResponses(listing.text)
      .filter(({ prop }) => 'calendar' in asNode(prop.resourcetype))
      .filter(({ prop }) => {
        const set = prop['supported-calendar-component-set'];
        if (set === undefined) return true;
        const comps = asNode(set).comp;
        return Array.isArray(comps) && comps.some((c) => asNode(c)['@_name'] === 'VEVENT');
      })
      .map(({ href, prop }) => ({
        url: icloudUrl(href, listing.url),
        name: textOf(prop.displayname)?.trim() ?? '',
      }));
    return { home, calendars };
  }

  async fetch(ctx: FetchContext): Promise<CalendarEvent[]> {
    const { calendars } = await (this.discovery ??= this.discover());
    const start = davTime(zonedTime(ctx.date, '00:00', this.timeZone));
    const end = davTime(zonedTime(nextDay(ctx.date), '00:00', this.timeZone));
    const events: CalendarEvent[] = [];
    for (let i = 0; i < calendars.length; i += PARALLEL_CALENDARS) {
      const reports = await Promise.all(
        calendars
          .slice(i, i + PARALLEL_CALENDARS)
          .map((c) => this.dav('REPORT', c.url, '1', reportBody(start, end))),
      );
      for (const { text } of reports)
        for (const { prop } of davResponses(text)) {
          const data = textOf(prop['calendar-data']);
          if (data) events.push(...parseICalendar(data, this.timeZone));
        }
    }
    return onDay(events, ctx.date, this.timeZone);
  }
}

// Offline preview: parses a saved iCalendar file as if it were today's REPORT.
export class ICloudFileSource implements Source<CalendarEvent[]> {
  readonly name = 'icloud';

  constructor(
    private readonly path: string,
    private readonly timeZone: string,
  ) {}

  async fetch(ctx: FetchContext): Promise<CalendarEvent[]> {
    const text = await readFile(this.path, 'utf8');
    return onDay(parseICalendar(text, this.timeZone), ctx.date, this.timeZone);
  }
}
