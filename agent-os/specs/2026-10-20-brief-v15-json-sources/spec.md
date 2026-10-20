# Spec: brief v15 — JSON sources for Hacker News and GitHub releases

Status: shaped 2026-10-20 from the 2026-10-20 run record: `hnrss.org` HTTP 502 (fourth day), all four GitHub `releases.atom` feeds HTTP 403 from the cloud sandbox although they fetch fine from a laptop. Builds on v14. Standards applied: typescript-style, testing.

## Goal

Hacker News and GitHub releases reach the brief from the cloud sandbox. Both get a JSON source that talks to the official API instead of an RSS mirror, behind the same `Source<Item[]>` interface, so the rest of the pipeline (window, dedupe, release pass-through, memory, decider, writer) does not change.

## Design

- **Source formats** (`config/brief.json`): feed entries gain `format: "rss" | "hn-algolia" | "github-releases"` (default `rss`). `src/sources/feeds.ts` keeps `FeedSource` for rss; two new classes in `src/sources/json-sources.ts`:
  - `HnAlgoliaSource`: GET `https://hn.algolia.com/api/v1/search_by_date` with `query` (from the config `url` query string or a `query` field), `optionalWords` equal to the query, `tags=story`, `numericFilters=points>50,created_at_i><now-windowHours>`, `hitsPerPage=50`. Item: title, link = `url` or the HN item page, published = `created_at`, summary = `<points> points on Hacker News`, source name from the config.
  - `GithubReleasesSource`: GET `https://api.github.com/repos/<owner>/<repo>/releases?per_page=10` with `Accept: application/vnd.github+json` and the agent User-Agent; `owner/repo` taken from the config `url`. Item: title = `<feed name> <tag_name>` (reuse the v14 bare-version rule), link = `html_url`, published = `published_at`, summary = release body stripped to 600 chars; drafts and prereleases skipped; `kind: release`.
- **Config**: HN entry becomes `{ "name": "Hacker News AI", "format": "hn-algolia", "url": "https://hn.algolia.com/api/v1/search_by_date", "query": "AI LLM Claude agent model" }`; the four GitHub entries become `format: "github-releases"` with `url: https://github.com/<owner>/<repo>` (the api host is derived). The jev PyPI feed stays rss.
- **Errors**: non-2xx and non-JSON bodies throw `SourceError` with the HTTP status like rss does, so the footer note keeps working. GitHub's unauthenticated limit is 60/h per IP; four calls a day is fine.
- **README**: feed table updated; allow-list hosts now `hn.algolia.com` and `api.github.com` (`hnrss.org` and `github.com` no longer needed by the brief).
- **Wiring**: `src/run/wiring.ts` builds the source by `format`.

## Acceptance criteria

1. `HnAlgoliaSource` builds the documented request URL (query, optionalWords, tags, points and created_at filters, hitsPerPage) and maps a fixture response to Items with the HN item page as fallback link.
2. `GithubReleasesSource` derives `owner/repo` from a github.com URL, sends the JSON Accept header, skips drafts and prereleases, and maps a fixture response to release Items titled `<name> <tag>` with the body stripped to 600 chars.
3. A non-2xx or non-JSON response from either source throws `SourceError` carrying the source name and HTTP status.
4. Config validation accepts the three formats, defaults to rss, requires `query` for hn-algolia, and the wiring builds the matching class.
5. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `json-sources.ts`, config schema, wiring.
2. `config/brief.json`, README feeds + allow list, roadmap item 15.
3. Tests with fixtures under `src/testing/fixtures/`.
