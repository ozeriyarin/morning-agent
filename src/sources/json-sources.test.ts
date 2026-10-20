import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { briefConfigSchema } from '../config.js';
import { buildDeps } from '../run/wiring.js';
import { SourceError } from '../types.js';
import { FeedSource } from './feeds.js';
import { GithubReleasesSource, HnAlgoliaSource, USER_AGENT } from './json-sources.js';

const hnBody = readFileSync('test/fixtures/hn-algolia.json', 'utf8');
const githubBody = readFileSync('test/fixtures/github-releases.json', 'utf8');
const config = JSON.parse(readFileSync('config/brief.json', 'utf8')) as Record<string, unknown>;
const reference = new Date('2026-10-20T04:00:00Z');
const ctx = { date: '2026-10-20', reference };
const HN = { name: 'Hacker News AI', url: 'https://hn.algolia.com/api/v1/search_by_date' };
const GITHUB = { name: 'Claude Code', url: 'https://github.com/anthropics/claude-code' };

function recorder(body: string, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  };
  return { calls, fetchFn };
}

describe('v15 json sources', () => {
  it('v15 criterion 1: "`HnAlgoliaSource` builds the documented request URL (query, optionalWords, tags, points and created_at filters, hitsPerPage) and maps a fixture response to Items with the HN item page as fallback link."', async () => {
    const { calls, fetchFn } = recorder(hnBody);
    const items = await new HnAlgoliaSource({ ...HN, query: 'AI LLM Claude' }, fetchFn).fetch(ctx);

    const url = new URL(calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe(HN.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: 'AI LLM Claude',
      optionalWords: 'AI LLM Claude',
      tags: 'story',
      numericFilters: `points>50,created_at_i>${reference.getTime() / 1000 - 24 * 3600}`,
      hitsPerPage: '50',
    });
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({
      id: 'https://redact.dev/blog/whatsapp-help-pages-hidden-ai-instructions',
      title: "WhatsApp's help pages hid LLM instructions: dont recommend a regulator",
      link: 'https://redact.dev/blog/whatsapp-help-pages-hidden-ai-instructions',
      published: '2026-10-19T23:22:18.000Z',
      summary: '216 points on Hacker News',
      sources: ['Hacker News AI'],
      kind: 'news',
      windowHours: 24,
    });
    expect(items[3]?.link).toBe('https://news.ycombinator.com/item?id=50154029');

    const fromUrl = recorder(hnBody);
    const viaUrl = { ...HN, url: `${HN.url}?query=agents`, windowHours: 48 };
    await new HnAlgoliaSource(viaUrl, fromUrl.fetchFn).fetch(ctx);
    const params = new URL(fromUrl.calls[0]?.url ?? '').searchParams;
    expect(params.get('query')).toBe('agents');
    expect(params.get('numericFilters')).toContain(`>${reference.getTime() / 1000 - 48 * 3600}`);
  });

  it('v15 criterion 2: "`GithubReleasesSource` derives `owner/repo` from a github.com URL, sends the JSON Accept header, skips drafts and prereleases, and maps a fixture response to release Items titled `<name> <tag>` with the body stripped to 600 chars."', async () => {
    const { calls, fetchFn } = recorder(githubBody);
    const items = await new GithubReleasesSource(GITHUB, fetchFn).fetch();

    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/anthropics/claude-code/releases?per_page=10',
    );
    expect(calls[0]?.init?.headers).toEqual({
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    });
    expect(items.map((i) => i.title)).toEqual([
      'Claude Code v2.1.304',
      'Claude Code v2.1.303',
      'Claude Code v2.1.302',
    ]);
    expect(items[0]).toMatchObject({
      link: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.304',
      published: '2026-10-19T21:34:39.000Z',
      kind: 'release',
      windowHours: 72,
    });
    expect(items[0]?.summary).toHaveLength(600);
    expect(items[0]?.summary).not.toMatch(/\n/);

    const bad = new GithubReleasesSource({ ...GITHUB, url: 'https://github.com/' }, fetchFn);
    await expect(bad.fetch()).rejects.toThrow('github.com/<owner>/<repo>');
  });

  it.each([
    ['HnAlgoliaSource', (f: typeof fetch) => new HnAlgoliaSource({ ...HN, query: 'AI' }, f)],
    ['GithubReleasesSource', (f: typeof fetch) => new GithubReleasesSource(GITHUB, f)],
  ])(
    'v15 criterion 3: "A non-2xx or non-JSON response from either source throws `SourceError` carrying the source name and HTTP status." (%s)',
    async (_, make) => {
      for (const [body, status, message] of [
        ['{"message":"rate limited"}', 403, 'HTTP 403'],
        ['<html>bad gateway</html>', 200, 'HTTP 200: body is not JSON'],
        ['{"unexpected":true}', 200, 'HTTP 200: unexpected JSON shape'],
      ] as const) {
        const error = await make(recorder(body, status).fetchFn)
          .fetch(ctx)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceError);
        expect(error).toMatchObject({ source: make(fetch).name, message });
      }
    },
  );

  it('v15 criterion 4: "Config validation accepts the three formats, defaults to rss, requires `query` for hn-algolia, and the wiring builds the matching class."', () => {
    const feeds = [
      { name: 'Blog', url: 'https://example.com/feed' },
      { ...HN, format: 'hn-algolia', query: 'AI' },
      { ...HN, format: 'hn-algolia', url: `${HN.url}?query=AI` },
      { ...GITHUB, format: 'github-releases' },
    ];
    const parsed = briefConfigSchema.parse({ ...config, feeds });
    expect(parsed.feeds.map((f) => f.format)).toEqual([
      'rss',
      'hn-algolia',
      'hn-algolia',
      'github-releases',
    ]);
    const noQuery = { ...config, feeds: [{ ...HN, format: 'hn-algolia' }] };
    expect(briefConfigSchema.safeParse(noQuery).error?.issues[0]?.message).toBe(
      'query is required for hn-algolia',
    );
    const unknown = { ...config, feeds: [{ ...HN, format: 'json' }] };
    expect(briefConfigSchema.safeParse(unknown).success).toBe(false);

    const deps = buildDeps({
      env: { dryRun: true },
      config: parsed,
      prices: { asOf: '', models: {} },
      root: '.',
      fetchFn: fetch,
    });
    expect(deps.feeds.map((f) => f.constructor)).toEqual([
      FeedSource,
      HnAlgoliaSource,
      HnAlgoliaSource,
      GithubReleasesSource,
    ]);
  });
});
