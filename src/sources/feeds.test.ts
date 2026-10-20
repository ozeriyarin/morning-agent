import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { briefConfigSchema } from '../config.js';
import { SourceError, type Item } from '../types.js';
import { dedupe, FeedSource, normalizeTitle, parseFeed, withinWindow } from './feeds.js';

const atom = readFileSync('test/fixtures/simonwillison-atom.xml', 'utf8');
const rss = readFileSync('test/fixtures/openai-rss.xml', 'utf8');
const hn = readFileSync('test/fixtures/hnrss-rss.xml', 'utf8');
const reference = new Date('2026-10-10T04:00:00Z');

describe('feeds', () => {
  it('criterion 3: "Feed parsing: RSS and Atom fixtures both yield items with title, link, published date; items older than 24 h (relative to `--date`) are dropped; duplicate titles are merged."', () => {
    const fromAtom = parseFeed(atom, 'Simon Willison');
    const fromRss = parseFeed(rss, 'OpenAI News');
    for (const item of [...fromAtom, ...fromRss]) {
      expect(item.title).not.toBe('');
      expect(item.link).toMatch(/^https:\/\//);
      expect(Number.isNaN(Date.parse(item.published))).toBe(false);
    }
    expect(fromAtom[0]).toMatchObject({
      title: 'Quoting The New York Times',
      link: 'https://simonwillison.net/2026/Oct/10/the-new-york-times/',
      published: '2026-10-10T02:04:12.000Z',
    });
    expect(fromRss[0]?.title).toBe(
      'Sophos cuts threat investigation time by 96% with OpenAI Daybreak',
    );

    const recent = withinWindow([...fromAtom, ...fromRss], reference);
    const titles = recent.map((i) => i.title);
    expect(titles).not.toContain('ttok 1.0');
    expect(titles).not.toContain(
      'How Oracle turns days of work into minutes with ChatGPT and Codex',
    );
    expect(recent).toHaveLength(6);

    const reposted = parseFeed(atom, 'Mirror').map((i) => ({ ...i, title: i.title.toUpperCase() }));
    const merged = dedupe([...recent, ...withinWindow(reposted, reference)]);
    expect(merged).toHaveLength(6);
    expect(merged.find((i) => i.title === 'Quoting The New York Times')?.sources).toEqual([
      'Simon Willison',
      'Mirror',
    ]);
  });

  it('decodes CDATA titles from hnrss', () => {
    const items = parseFeed(hn, 'Hacker News AI');
    expect(items[0]?.title).toBe(
      'Anthropic AI model submits false tip on unsolved Philly murder, police say',
    );
    expect(items[0]?.summary).toContain('Article URL');
  });

  it.each([
    ['Claude Code 3.0 is out!', 'claude code 3 0 is out'],
    ['  CLAUDE   code 3.0 - is out ', 'claude code 3 0 is out'],
    ['"מודל חדש"', 'מודל חדש'],
  ])('normalizeTitle(%j) is %j', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it('keeps the newest copy when titles collide', () => {
    const base: Item = {
      id: 'a',
      title: 'X',
      link: 'a',
      published: '',
      summary: '',
      sources: ['A'],
    };
    const older = { ...base, published: '2026-10-09T10:00:00.000Z' };
    const newer = { ...base, id: 'b', published: '2026-10-09T11:00:00.000Z', sources: ['B'] };
    expect(dedupe([older, newer])).toEqual([{ ...newer, sources: ['B', 'A'] }]);
  });

  it('rejects documents that are neither RSS nor Atom', () => {
    expect(() => parseFeed('<html><body/></html>', 'x')).toThrow(SourceError);
  });

  it('a FeedSource throws a SourceError on HTTP 500 and parses a good body', async () => {
    const failing: typeof fetch = async () => new Response('', { status: 500 });
    await expect(
      new FeedSource({ name: 'OpenAI News', url: 'https://x' }, failing).fetch(),
    ).rejects.toThrow('HTTP 500');
    const ok: typeof fetch = async () => new Response(rss);
    expect(
      await new FeedSource({ name: 'OpenAI News', url: 'https://x' }, ok).fetch(),
    ).toHaveLength(4);
  });
});

describe('v14 feeds', () => {
  const hoursAgo = (h: number) => new Date(reference.getTime() - h * 3_600_000).toISOString();
  const atomOf = (...entries: [string, number][]) =>
    `<feed>${entries
      .map(
        ([title, h], i) =>
          `<entry><title>${title}</title><link href="https://x/${i}"/><updated>${hoursAgo(h)}</updated></entry>`,
      )
      .join('')}</feed>`;
  const serve =
    (xml: string): typeof fetch =>
    async () =>
      new Response(xml);

  it('v14 criterion 1: "Feed config accepts `kind` and `windowHours`; `withinWindow` honours a per-item window so a release published 60 hours ago from a 72 h feed is kept while a 30-hour-old news item is dropped."', async () => {
    const config = JSON.parse(readFileSync('config/brief.json', 'utf8')) as Record<string, unknown>;
    const feeds = [
      { name: 'jev', url: 'https://pypi.org/rss/project/jev/releases.xml', kind: 'release' },
      { name: 'Blog', url: 'https://example.com/feed', windowHours: 48 },
    ];
    expect(briefConfigSchema.parse({ ...config, feeds }).feeds).toEqual([
      { ...feeds[0], format: 'rss' },
      { ...feeds[1], format: 'rss', kind: 'news' },
    ]);
    const bad = { ...config, feeds: [{ ...feeds[0], kind: 'tweet' }] };
    expect(briefConfigSchema.safeParse(bad).success).toBe(false);

    const release = new FeedSource(
      { name: 'jev', url: 'https://x', kind: 'release' },
      serve(atomOf(['jev ships', 60])),
    );
    const news = new FeedSource(
      { name: 'Blog', url: 'https://x' },
      serve(atomOf(['old news', 30])),
    );
    const items = [...(await release.fetch()), ...(await news.fetch())];
    expect(items.map((i) => [i.kind, i.windowHours])).toEqual([
      ['release', 72],
      ['news', 24],
    ]);
    expect(withinWindow(items, reference).map((i) => i.title)).toEqual(['jev ships']);
  });

  it('v14 criterion 2: "An item from a `release` feed is recorded as `must_read` with `reason: "release"` and without a decision call; a bare version title is prefixed with the feed name." (title prefix)', async () => {
    const xml = atomOf(['0.3.0', 1], ['v1.2.0-beta.1', 1], ['Spec Kit 2.0 is out', 1]);
    const release = new FeedSource({ name: 'jev', url: 'https://x', kind: 'release' }, serve(xml));
    expect((await release.fetch()).map((i) => i.title)).toEqual([
      'jev 0.3.0',
      'jev v1.2.0-beta.1',
      'Spec Kit 2.0 is out',
    ]);
    const news = new FeedSource({ name: 'Blog', url: 'https://x' }, serve(xml));
    expect((await news.fetch())[0]?.title).toBe('0.3.0');
  });
});
