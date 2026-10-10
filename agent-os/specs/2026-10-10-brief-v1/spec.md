# Spec: Brief v1 — weather + AI news + concept of the day → Telegram

Status: shaped 2026-10-10. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

Every morning at 07:00 Asia/Jerusalem, Yarin receives one Hebrew Telegram message with today's weather in Modi'in, the AI news from the last 24 hours that matter, and one concept explained, and a run record is committed to the repo.

## Scope (v1)

- Sources: Open-Meteo weather for Modi'in (31.89 N, 35.01 E); 3–5 RSS/Atom feeds from `config/brief.json`; concept queue from `concepts/queue.md`.
- Decision step: each news item is classified `must_read | mention | skip` by a `DecisionModel`. v1 implementation: `HaikuDecisionModel` (claude-haiku-4-5-20251001) using a closed-choice tool. A `FakeDecisionModel` exists for tests and for a `--dry-run`.
- Writer: `SonnetWriter` (claude-sonnet-5-5) composes the brief from the weather, the kept items and the concept, with a cached system prompt and a structured output schema.
- Delivery: `TelegramSender` posts the brief with the Bot API (`sendMessage`, HTML parse mode). `ConsoleSender` prints it for `--dry-run`.
- Record: `runs/YYYY-MM-DD.json` with items fetched, decisions, per-call model/tokens/cache/latency/cost, total cost, delivery status, errors. Concept queue advances (`concepts/queue.md` marks the used concept with the date).
- CLI: `npm run brief` (real), `npm run brief -- --dry-run` (fakes, no network to AI/Telegram, weather and feeds still fetched), `npm run brief -- --date 2026-10-11` (override "today" for tests).

## Out of scope (later roadmap items)

Google Calendar, iCloud Calendar, Jev, cost dashboard, second recipient, Telegram commands/replies.

## Brief structure (Hebrew, fixed order)

1. Header: `בוקר טוב, יום <weekday> <D.M>`
2. `מזג אוויר במודיעין`: min/max, rain chance, one-line advice (e.g. take a jacket) — from weather data, written by the writer.
3. `AI היום`: must_read items first (title, one-sentence why it matters, link), then mention items as a short list of titles with links. If none kept: one line saying it was a quiet day.
4. `מושג היום`: the concept name, 3–5 lines explanation, one interview-style question to think about.
5. Footer: `נוצר ב-<HH:MM> · <n> פריטים נבדקו · עלות ~$<x>`

Length target: under 1,200 characters so it fits one phone screen.

## Decision rules given to the decision model

- `must_read`: new model or major feature from Anthropic/OpenAI/Google/Meta/Mistral, agent/coding-tool releases, anything about Claude Code, MCP, Jev/decision models, RAG tooling, or Israeli AI companies.
- `mention`: benchmark posts, funding news, opinion pieces from known engineers.
- `skip`: marketing, duplicates of a must_read, crypto, politics, listicles.
- Dedupe by normalised title before deciding; decide at most 40 items per run (newest first); the rest are skipped unseen and counted.

## Acceptance criteria

1. Running `npm run brief -- --dry-run` offline-safe for AI/Telegram prints a brief with all five sections and writes a run record.
2. Weather mapping: given a captured Open-Meteo response, the mapped day has min, max, precipitation probability and a weather code label in Hebrew.
3. Feed parsing: RSS and Atom fixtures both yield items with title, link, published date; items older than 24 h (relative to `--date`) are dropped; duplicate titles are merged.
4. Decision mapping: the decision model's tool output maps exactly to the enum; an invalid value becomes `skip` with an error noted in the record.
5. Writer output is validated against the schema; a missing section fails validation and the run falls back to a template brief with a `חסר: <section>` line instead of sending nothing.
6. The record never contains the Telegram token, the chat id or the API key, even when an error message includes the request URL (redaction test).
7. A failing source (e.g. one feed 500s) still produces a brief; the record lists the failure.
8. Concept queue: the first unused concept is used and marked with today's date; if all are used, the brief says the queue is empty.
9. Cost: the record total equals the sum of per-call costs computed from the price table in `config/prices.json`.
10. `npm test` passes; every criterion above has a test whose name quotes it.

## Design

```
src/
  config.ts            env (zod) + config/brief.json loader
  types.ts             Item, Decision, WeatherDay, Brief, RunRecord, interfaces
  sources/weather.ts   Open-Meteo client + mapWeather()
  sources/feeds.ts     fetchFeeds() + parseFeed() + dedupe() + withinWindow()
  sources/concepts.ts  readQueue() / markUsed()
  decide/decision-model.ts   DecisionModel interface, decisionSchema
  decide/haiku.ts      HaikuDecisionModel
  decide/fake.ts       FakeDecisionModel
  write/writer.ts      Writer interface, BriefSchema (zod)
  write/sonnet.ts      SonnetWriter (cached system prompt, structured output)
  write/template.ts    fallback brief + formatBrief(brief) -> Telegram HTML
  deliver/telegram.ts  TelegramSender
  deliver/console.ts   ConsoleSender
  run/run-brief.ts     orchestration, timing, cost, record, redaction
  cli.ts               arg parsing (--dry-run, --date)
concepts/queue.md      "- [ ] agent loop" / "- [x] 2026-10-11 RAG"
config/brief.json      location, feeds, recipient, language
config/prices.json     per-model $ per 1M input/output/cache-read tokens
runs/                  committed records
```

Writer schema: `{ greeting, weather: { summary, advice }, news: { mustRead: [{title, why, url}], mention: [{title, url}], quietDay: boolean }, concept: { name, explanation, question }, footer }`.

## Routine (after the code lands)

Cloud routine "Morning brief", cron `0 4 * * *` UTC (07:00 Israel in summer time; change to `0 5` after DST ends on 2026-10-25), repo `ozeriyarin/morning-agent`, model claude-sonnet-5-5, allowed tools Bash/Read/Write/Edit/Glob/Grep. Prompt: install deps, run `npm test`, run `npm run brief`, commit `runs/<date>.json` and `concepts/queue.md` with message `brief: <date>`, push, and report the Telegram delivery status and total cost. Secrets come from the environment's variables.

## Tasks

1. Scaffold: package.json (ESM, scripts), tsconfig, eslint/prettier, vitest, `.gitignore`, `.env.example`, `config/brief.json`, `config/prices.json`, `concepts/queue.md` with 15 interview concepts.
2. `types.ts`, `config.ts` with tests for env validation.
3. Sources: weather, feeds, concepts, with fixture-based tests (criteria 2, 3, 7, 8).
4. Decision layer: interface, fake, Haiku implementation with closed-choice tool (criterion 4).
5. Writer: schema, template fallback, Sonnet implementation with cache + structured output (criterion 5), `formatBrief` to Telegram HTML.
6. Delivery: Telegram + console senders.
7. Run orchestration, record with redaction and cost (criteria 1, 6, 9), CLI.
8. README: what it is, how it runs, how to add a feed or a concept, the routine prompt.
