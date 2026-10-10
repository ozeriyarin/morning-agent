# Spec: Brief v5 — cost and quality view

Status: shaped 2026-10-10. Builds on v4. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

The run records become a readable history: a report command summarises any date range (items, decisions, cost by role and model, latency, delivery, errors, calendar coverage), the Sunday brief carries a one-line weekly summary, and the README shows a live table from the committed records.

## Design

- `src/report/report.ts`: `loadRecords(root, from, to)` (reuse the record schema from replay; dry-run files excluded), `summarise(records)` → `ReportSummary`:
  - per day: date, delivery status, items fetched / in window / decided, decisions by label, calls by role (decision, writer) with tokens, cache-read tokens, cost, mean latency; errors (source + reason); calendar events count and iCloud status; concept used.
  - totals: days run, days delivered, total cost, cost by role and by model, mean cost per day, mean latency per role, error counts by source, cache hit ratio for the writer (cache-read / input).
  - `toMarkdown(summary)` renders a per-day table and a totals block; `toJson` writes `reports/report-<from>-<to>.json`.
- CLI `npm run report -- --from YYYY-MM-DD --to YYYY-MM-DD [--format md|json]` (`src/report-cli.ts`); default range is the last 7 days ending today in Asia/Jerusalem.
- Weekly line in the brief: when the run date is a Sunday, the footer gains a second line `השבוע: N ימים, עלות ~$X, M פריטים נבדקו, K שגיאות` computed from the previous 7 days' records (missing days count as not run). No AI involved; pure code in `write/template.ts` + a `weekly` field on `Brief`.
- README "History" section: a short note on how to regenerate the table, plus the latest table pasted by the routine (see below). The routine prompt gains a step: on Sundays, run `npm run report` for the last 7 days and commit `reports/report-<from>-<to>.json` with the run record.
- Redaction: reports go through the same `redact()`; no item titles are needed in the report except in the error list (source names only).

## Acceptance criteria

1. Given three fixture records (one delivered, one with a failed delivery, one dry-run file that must be ignored), `summarise` reports 2 days run, 1 delivered, correct totals of cost and items, and ignores the dry-run file.
2. Cost by role splits decision and writer costs exactly as the per-call `costUsd` values sum; cost by model groups Haiku, Sonnet and Jev separately.
3. Writer cache hit ratio is `cacheReadTokens / inputTokens` over writer calls, 0 when there are no writer calls.
4. Errors are counted by source name across days (`weather: 1, Hacker News AI: 2`).
5. `toMarkdown` renders one row per day in date order and a totals block; the numbers match `summarise`.
6. The CLI with no flags uses the last 7 days ending today (Asia/Jerusalem) and writes `reports/report-<from>-<to>.json`; `--format md` prints only Markdown.
7. On a Sunday run, the brief footer contains the weekly line with the counts from the previous 7 days; on other days it does not.
8. A record missing optional fields (older schema: no `summary`, no `icloud`, no `decisions[].model`) still summarises without throwing.
9. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `src/report/report.ts` (+ shared record schema moved to `src/records.ts` and reused by replay), tests (criteria 1–5, 8).
2. `src/report-cli.ts`, `npm run report` (criterion 6).
3. Weekly footer line (criterion 7): `Brief.weekly`, computed in `run/run-brief.ts` from `loadRecords` for the previous 7 days, rendered in `write/template.ts`.
4. README "History" section; routine prompt text for the Sunday report step documented in the README.
