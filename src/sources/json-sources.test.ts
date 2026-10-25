import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { briefConfigSchema, loadGithubToken } from '../config.js';
import { buildDeps } from '../run/wiring.js';
import { SourceError } from '../types.js';
import { FeedSource } from './feeds.js';
import {
  GITHUB_TOKEN_HINT,
  GithubReleasesSource,
  HnAlgoliaSource,
  USER_AGENT,
} from './json-sources.js';

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
        ['{"message":"rate limited"}', 403, 'HTTP 403: rate limited'],
        ['<html>bad gateway</html>', 200, 'HTTP 200: body is not JSON'],
        ['{"unexpected":true}', 200, 'HTTP 200: unexpected JSON shape'],
      ] as const) {
        const error = await make(recorder(body, status).fetchFn)
          .fetch(ctx)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceError);
        expect(error).toMatchObject({ source: make(fetch).name });
        expect((error as Error).message.startsWith(message)).toBe(true); // v17 may append a hint
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

describe('v17 github token', () => {
  const token = 'github_pat_test_only';

  it('v17 criterion 1: "`GithubReleasesSource` sends `Authorization: Bearer <token>` when given a token and no Authorization header otherwise; the other headers are unchanged."', async () => {
    const withToken = recorder(githubBody);
    await new GithubReleasesSource(GITHUB, withToken.fetchFn, token).fetch();
    expect(withToken.calls[0]?.init?.headers).toEqual({
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      Authorization: `Bearer ${token}`,
    });

    const without = recorder(githubBody);
    await new GithubReleasesSource(GITHUB, without.fetchFn).fetch();
    expect(without.calls[0]?.init?.headers).toEqual({
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    });
  });

  it('v17 criterion 2: "A non-2xx JSON reply with a `message` reports it after the status, on one line and cut to 120 characters; a body without one keeps the bare `HTTP <status>`."', async () => {
    const long = 'API rate limit exceeded for 1.2.3.4. ' + 'x'.repeat(200);
    const cases: [string, string][] = [
      [
        JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4.\n (But here)' }),
        'HTTP 403: API rate limit exceeded for 1.2.3.4. (But here)',
      ],
      [JSON.stringify({ message: long }), `HTTP 403: ${long.slice(0, 119)}…`],
      ['{"error":"nope"}', 'HTTP 403'],
      ['', 'HTTP 403'],
    ];
    for (const [body, message] of cases) {
      const error = await new GithubReleasesSource(GITHUB, recorder(body, 403).fetchFn, token)
        .fetch()
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ source: GITHUB.name, message });
    }
  });

  it('v17 criterion 3: "A 401 or 403 from GitHub without a token appends the GITHUB_TOKEN hint to the error; with a token, or on other statuses, the message is left alone."', async () => {
    const fail = (status: number, t: string | null) =>
      new GithubReleasesSource(GITHUB, recorder('{"message":"blocked"}', status).fetchFn, t)
        .fetch()
        .catch((e: unknown) => (e as Error).message);
    expect(await fail(403, null)).toBe(`HTTP 403: blocked (${GITHUB_TOKEN_HINT})`);
    expect(await fail(401, null)).toBe(`HTTP 401: blocked (${GITHUB_TOKEN_HINT})`);
    expect(await fail(403, token)).toBe('HTTP 403: blocked');
    expect(await fail(500, null)).toBe('HTTP 500: blocked');
  });

  it('v17 criterion 4: "`loadGithubToken` prefers `MORNING_GITHUB_TOKEN` over `GITHUB_TOKEN`, trims, and returns null when neither is set; the wiring hands the token to `github-releases` sources only."', async () => {
    expect(loadGithubToken({ MORNING_GITHUB_TOKEN: ' a ', GITHUB_TOKEN: 'b' })).toBe('a');
    expect(loadGithubToken({ GITHUB_TOKEN: 'b' })).toBe('b');
    expect(loadGithubToken({ GITHUB_TOKEN: '  ' })).toBeNull();
    expect(loadGithubToken({})).toBeNull();

    const { calls, fetchFn } = recorder(githubBody);
    const parsed = briefConfigSchema.parse({
      ...config,
      feeds: [
        { ...GITHUB, format: 'github-releases' },
        { name: 'Blog', url: 'https://example.com/feed' },
      ],
    });
    const deps = buildDeps({
      env: { dryRun: true },
      config: parsed,
      prices: { asOf: '', models: {} },
      root: '.',
      fetchFn,
      githubToken: token,
    });
    await deps.feeds[0]?.fetch(ctx);
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    expect(deps.feeds[1]).toBeInstanceOf(FeedSource);
  });
});
