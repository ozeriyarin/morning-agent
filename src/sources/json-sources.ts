import { z } from 'zod';
import { SourceError, type FetchContext, type Item, type Source } from '../types.js';
import { NEWS_WINDOW_HOURS, stampItems, toItem, type FeedOptions } from './feeds.js';

export const USER_AGENT = 'morning-agent (+https://github.com/ozeriyarin/morning-agent)';
const HN_ITEM_URL = 'https://news.ycombinator.com/item?id=';

const hnSchema = z.object({
  hits: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string().nullish(),
      objectID: z.string(),
      created_at: z.string(),
      points: z.number().nullish(),
    }),
  ),
});

const githubSchema = z.array(
  z.object({
    tag_name: z.string(),
    html_url: z.string(),
    published_at: z.string().nullish(),
    body: z.string().nullish(),
    draft: z.boolean(),
    prerelease: z.boolean(),
  }),
);

// Non-2xx, a non-JSON body and an unexpected shape all throw with the HTTP status.
async function fetchJson<T>(
  name: string,
  url: string,
  schema: z.ZodType<T>,
  fetchFn: typeof fetch,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new SourceError(name, `HTTP ${res.status}`);
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new SourceError(name, `HTTP ${res.status}: body is not JSON`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SourceError(name, `HTTP ${res.status}: unexpected JSON shape`);
  return parsed.data;
}

export class HnAlgoliaSource implements Source<Item[]> {
  readonly name: string;

  constructor(
    private readonly feed: FeedOptions & { query?: string },
    private readonly fetchFn: typeof fetch,
  ) {
    this.name = feed.name;
  }

  private requestUrl(reference: Date): string {
    const url = new URL(this.feed.url);
    const query = this.feed.query ?? url.searchParams.get('query') ?? '';
    const hours = this.feed.windowHours ?? NEWS_WINDOW_HOURS;
    const since = Math.floor((reference.getTime() - hours * 3_600_000) / 1000);
    url.search = new URLSearchParams({
      query,
      optionalWords: query,
      tags: 'story',
      numericFilters: `points>50,created_at_i>${since}`,
      hitsPerPage: '50',
    }).toString();
    return url.toString();
  }

  async fetch(ctx: FetchContext): Promise<Item[]> {
    const { hits } = await fetchJson(
      this.name,
      this.requestUrl(ctx.reference),
      hnSchema,
      this.fetchFn,
    );
    const items = hits.map((hit) =>
      toItem(
        this.name,
        hit.title ?? '',
        hit.url || `${HN_ITEM_URL}${hit.objectID}`,
        hit.created_at,
        `${hit.points ?? 0} points on Hacker News`,
      ),
    );
    return stampItems(
      items.filter((item): item is Item => item !== null),
      this.feed,
    );
  }
}

export class GithubReleasesSource implements Source<Item[]> {
  readonly name: string;

  constructor(
    private readonly feed: FeedOptions,
    private readonly fetchFn: typeof fetch,
  ) {
    this.name = feed.name;
  }

  private requestUrl(): string {
    const [owner, repo] = new URL(this.feed.url).pathname.split('/').filter(Boolean);
    if (!owner || !repo) throw new SourceError(this.name, 'url is not github.com/<owner>/<repo>');
    return `https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`;
  }

  async fetch(): Promise<Item[]> {
    const releases = await fetchJson(this.name, this.requestUrl(), githubSchema, this.fetchFn, {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    });
    const items = releases
      .filter((r) => !r.draft && !r.prerelease)
      .map((r) => toItem(this.name, r.tag_name, r.html_url, r.published_at ?? '', r.body ?? ''));
    return stampItems(
      items.filter((item): item is Item => item !== null),
      { ...this.feed, kind: 'release' },
    );
  }
}
