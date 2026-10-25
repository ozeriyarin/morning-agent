# Spec: brief v17 — authenticated GitHub release feeds

Status: shaped 2026-10-25 from the run records of 2026-10-21..25: all four `github-releases` feeds (Agent OS, spec-kit, BMAD, Claude Code) failed with `HTTP 403` every day, 6 times each in the weekly report, although `api.github.com` is on the sandbox allow list and the same requests succeed from a laptop. Builds on v15. Standards applied: typescript-style, testing.

## Goal

The release feeds reach the brief from the cloud sandbox again, and when a feed fails the run record says why, not only that.

## Design

- **Cause**: v15 relied on GitHub's unauthenticated limit of 60 calls an hour *per IP*. The sandbox egress is shared, so the limit is exhausted by other tenants before the brief's four calls; GitHub answers 403 with a JSON body `{"message": "API rate limit exceeded for <ip>. ..."}`. The v15 error message dropped the body, so the record only said `HTTP 403`.
- **Token** (`src/config.ts`, `loadGithubToken`): `MORNING_GITHUB_TOKEN` or `GITHUB_TOKEN`, trimmed, else `null`; optional like the OpenRouter and Voyage keys. A fine-grained token with no permissions is enough (public data; 5,000 calls an hour per token). Cloud sessions may withhold `GITHUB_TOKEN` from the shell, hence the project-specific name first, as for the Anthropic key.
- **Source** (`src/sources/json-sources.ts`): `GithubReleasesSource` takes an optional third constructor argument `token` and sends `Authorization: Bearer <token>` when set; `Accept` and `User-Agent` are unchanged. A 401 or 403 *without* a token appends `(set GITHUB_TOKEN: unauthenticated api.github.com calls share one 60/hour limit per IP)` so the footer's `מקור לא זמין` has an actionable record entry behind it.
- **Error bodies** (`fetchJson`, both JSON sources): a non-2xx reply whose JSON body has a string `message` reports `HTTP <status>: <message>` on one line, cut to 120 characters; a body without one keeps the bare `HTTP <status>`. Never includes request headers, so the token cannot leak into the committed record.
- **Wiring** (`src/run/wiring.ts`, `src/cli.ts`): `WiringOptions.githubToken`, passed only to `github-releases` sources; the CLI reads it with `loadGithubToken(process.env)` in live and dry runs alike (dry runs fetch feeds too).
- **Operations**: `GITHUB_TOKEN` is added to the routine's cloud environment variables (owner action; the repo never holds it). `.env.example` documents it.

## Acceptance criteria

1. `GithubReleasesSource` sends `Authorization: Bearer <token>` when given a token and no Authorization header otherwise; the other headers are unchanged.
2. A non-2xx JSON reply with a `message` reports it after the status, on one line and cut to 120 characters; a body without one keeps the bare `HTTP <status>`.
3. A 401 or 403 from GitHub without a token appends the GITHUB_TOKEN hint to the error; with a token, or on other statuses, the message is left alone.
4. `loadGithubToken` prefers `MORNING_GITHUB_TOKEN` over `GITHUB_TOKEN`, trims, and returns null when neither is set; the wiring hands the token to `github-releases` sources only.
5. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `config.ts` loader, `json-sources.ts` header + error body + hint, wiring and CLI, `.env.example`.
2. Tests in `src/sources/json-sources.test.ts` (v15 criterion 3 now expects the quoted body after the status).
3. README (feeds paragraph, routine env vars, cron lines after the DST change of 2026-10-25), roadmap item 17.
4. Owner: add `GITHUB_TOKEN` to the cloud environment; confirm on the next run record that the four feeds have no `errors` entry.
