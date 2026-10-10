import { XMLParser } from 'fast-xml-parser';
import { SourceError, type Item, type Source } from '../types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  htmlEntities: true,
  parseTagValue: false,
  isArray: (name) => ['item', 'entry', 'link'].includes(name),
});

function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (node && typeof node === 'object' && '#text' in node) return text(node['#text']);
  return '';
}

function atomLink(links: unknown): string {
  if (!Array.isArray(links)) return '';
  const rec = links.filter((l): l is Record<string, unknown> => !!l && typeof l === 'object');
  const alt = rec.find((l) => l['@_rel'] === undefined || l['@_rel'] === 'alternate');
  return typeof alt?.['@_href'] === 'string' ? alt['@_href'] : '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function toItem(source: string, title: string, link: string, date: string, summary: string) {
  const time = Date.parse(date);
  if (!title || !link || Number.isNaN(time)) return null;
  const published = new Date(time).toISOString();
  return { id: link, title, link, published, summary: stripHtml(summary), sources: [source] };
}

// RSS 2.0 and Atom share this one path so both yield the same Item shape.
export function parseFeed(xml: string, source: string): Item[] {
  const doc: unknown = parser.parse(xml);
  if (!doc || typeof doc !== 'object') throw new SourceError(source, 'feed is not XML');
  const root = doc as { rss?: { channel?: { item?: unknown[] } }; feed?: { entry?: unknown[] } };
  if (!root.rss && !root.feed) throw new SourceError(source, 'neither RSS nor Atom');
  const rows: (Item | null)[] = [];
  for (const raw of root.rss?.channel?.item ?? []) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const link = Array.isArray(it.link) ? text(it.link[0]) : '';
    rows.push(toItem(source, text(it.title), link, text(it.pubDate), text(it.description)));
  }
  for (const raw of root.feed?.entry ?? []) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const date = text(e.published) || text(e.updated);
    rows.push(toItem(source, text(e.title), atomLink(e.link), date, text(e.summary)));
  }
  return rows.filter((row): row is Item => row !== null);
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sortNewestFirst(items: Item[]): Item[] {
  return [...items].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
}

// Keeps the newest copy of each title and merges the other copies' source names into it.
export function dedupe(items: Item[]): Item[] {
  const byTitle = new Map<string, Item>();
  for (const item of sortNewestFirst(items)) {
    const key = normalizeTitle(item.title);
    const kept = byTitle.get(key);
    if (!kept) byTitle.set(key, { ...item, sources: [...item.sources] });
    else for (const s of item.sources) if (!kept.sources.includes(s)) kept.sources.push(s);
  }
  return [...byTitle.values()];
}

export function withinWindow(items: Item[], reference: Date, hours = 24): Item[] {
  const from = reference.getTime() - hours * 3_600_000;
  return items.filter((item) => Date.parse(item.published) > from);
}

export class FeedSource implements Source<Item[]> {
  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly fetchFn: typeof fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async fetch(): Promise<Item[]> {
    const res = await this.fetchFn(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new SourceError(this.name, `HTTP ${res.status}`);
    return parseFeed(await res.text(), this.name);
  }
}
