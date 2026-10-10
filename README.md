# Morning Agent

Morning Agent sends one short Hebrew briefing to Telegram every morning at 07:00 Israel time:
today's weather in Modi'in, today's Google Calendar events, the AI news from the last 24 hours
that matter, and one interview concept explained with an answer to think about. Every run also writes an auditable record (items, decisions, tokens, cost,
latency, errors) to `runs/YYYY-MM-DD.json`.

The project is spec-driven: product docs live in `agent-os/product/`, coding standards in
`agent-os/standards/`, and each feature starts as a spec in `agent-os/specs/` (v1:
`agent-os/specs/2026-10-10-brief-v1/spec.md`, v2 calendar:
`agent-os/specs/2026-10-10-brief-v2-calendar/spec.md`).

## Architecture

```
npm run brief [--dry-run] [--date YYYY-MM-DD] [--calendar <path>]
└── src/cli.ts                    args, config + env loading, exit code
    └── src/run/wiring.ts         real clients, or fakes for --dry-run
        └── src/run/run-brief.ts  orchestration, cost, redaction, record
            ├── collect (in parallel, each failure degrades one section)
            │   ├── sources/weather.ts   Open-Meteo -> mapWeather() -> WeatherDay (Hebrew WMO label)
            │   ├── sources/calendar-file.ts  input/calendar-<date>.json -> CalendarEvent[] (sorted)
            │   ├── sources/feeds.ts     RSS + Atom -> parseFeed() -> withinWindow(24h) -> dedupe()
            │   └── sources/concepts.ts  concepts/queue.md -> next unused concept
            ├── decide (<= 40 newest items, one cheap call each)
            │   ├── decide/haiku.ts      claude-haiku-4-5, closed-choice tool: must_read | mention | skip
            │   └── decide/fake.ts       keyword rules for --dry-run and tests
            ├── write (one call per run)
            │   ├── write/sonnet.ts      claude-sonnet-5-5, cached system prompt, JSON-schema output
            │   ├── write/writer.ts      BriefSchema (zod) + validateBrief()
            │   └── write/template.ts    template brief (dry run + fallback), formatBrief() -> Telegram HTML
            ├── deliver
            │   ├── deliver/telegram.ts  Bot API sendMessage, parse_mode HTML
            │   └── deliver/console.ts   prints the brief for --dry-run
            └── record -> runs/<date>.json (redacted; dry runs write runs/<date>.dry-run.json)
config/brief.json    location, feeds, recipient, language, local send time
config/prices.json   $ per 1M input / output / cache-read / cache-write tokens, per model
concepts/queue.md    the learning queue
```

## Running it

Requires Node 20+.

```bash
npm install
npm test                                      # Vitest, no network
npm run brief -- --dry-run                    # fake decisions, template writer, prints to the console
npm run brief -- --dry-run --date 2026-10-11  # pretend "today" is another day
npm run brief -- --dry-run --date 2026-10-11 --calendar test/fixtures/calendar-sample.json
npm run brief                                 # real run: Haiku + Sonnet + Telegram
```

`--dry-run` still fetches the weather and the feeds, but never calls Anthropic or Telegram and
needs no secrets. If the network is down it still prints a brief, with `חסר: <section>` lines for
the sections whose sources failed, and the record lists every failure. A dry run does not advance
the concept queue.

A real run needs these environment variables (see `.env.example`; never commit a `.env`):

| Variable                    | Purpose                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`        | bot token from @BotFather                                                                        |
| `TELEGRAM_CHAT_ID`          | the recipient's chat id                                                                          |
| `MORNING_ANTHROPIC_API_KEY` | decision model and writer (`ANTHROPIC_API_KEY` also accepted; cloud sessions withhold that name) |
| `ICLOUD_APP_PASSWORD`       | reserved for the iCloud calendar (roadmap 3)                                                     |

Other checks: `npm run typecheck`, `npm run lint`, `npm run format`.

## Calendar hand-off

Google Calendar is read by the cloud routine, not by this code: the routine is a Claude Code
session with the claude.ai Google Calendar connector attached, and before `npm run brief` it
writes today's events to `input/calendar-YYYY-MM-DD.json` (gitignored). The script only reads
that file (`src/sources/calendar-file.ts`), so there is no OAuth code and no Google secret.
`--calendar <path>` reads another file instead, e.g. the fixture for an offline preview.

```json
{
  "date": "2026-10-11",
  "timezone": "Asia/Jerusalem",
  "source": "google",
  "events": [
    {
      "title": "פגישה עם נוי",
      "start": "2026-10-11T10:00:00+03:00",
      "end": "2026-10-11T10:30:00+03:00",
      "allDay": false,
      "location": "Zoom"
    }
  ]
}
```

`events` may be empty and unknown fields are ignored. The `date` must match the run date. The
`היום ביומן` section lists all-day events first (`כל היום: כותרת`), then timed events by start as
`HH:MM–HH:MM כותרת (מיקום)` in Asia/Jerusalem; no events gives `אין אירועים היום`. A missing or
invalid file still sends the brief with `היומן לא היה זמין`, and the record lists a `calendar`
source error with reason `missing` or `invalid`. The record keeps only `title`, `start`, `end`
and `allDay` per event: never attendees, descriptions, locations or links.

## Adding a feed

Append an entry to `feeds` in `config/brief.json`:

```json
{ "name": "Some Blog", "url": "https://example.com/feed.xml" }
```

RSS 2.0 and Atom both work; they go through the same parser. Items older than 24 hours before
the 07:00 send time are dropped, and titles that repeat across feeds are merged into one item.
Anthropic has no public RSS feed yet (`https://www.anthropic.com/rss.xml` returned 404 on
2026-10-10); add it here when one appears.

## Adding a concept

Add a line to `concepts/queue.md`:

```markdown
- [ ] vector databases
```

The run takes the first `- [ ]` line and, after the brief is delivered, rewrites it as
`- [x] 2026-10-11 vector databases`. When every line is used, the brief says the queue is empty.

## The routine

The brief runs as a Claude Code cloud routine named "Morning brief": cron `0 4 * * *` UTC (07:00
Israel summer time; change to `0 5 * * *` after DST ends on 2026-10-25), repo
`ozeriyarin/morning-agent`, model `claude-sonnet-5-5`, allowed tools Bash, Read, Write, Edit,
Glob, Grep, plus the Google Calendar connector. The secrets are environment variables of the
routine's cloud environment.

Routine prompt:

```text
Install dependencies with `npm ci`. Run `npm test`; if it fails, stop and report the failing
tests without sending a brief. Using the Google Calendar connector, list the events for today
(Asia/Jerusalem) on the primary calendar; write them to `input/calendar-<today>.json` exactly in
the hand-off schema (title, start, end, allDay, location; nothing else). If the connector fails,
do not create the file and continue. Run `npm run brief`. Then commit `runs/<date>.json` and
`concepts/queue.md` with the message `brief: <date>` (date as YYYY-MM-DD, Asia/Jerusalem) and
push. Finally report the Telegram delivery status and the total cost from the run record.
```

## Why these design choices

- **Cheap decisions, one writer call.** Classifying news is a closed-choice task, so each item
  goes to the cheapest adequate model (Haiku 4.5, later Jev) through a tool whose only argument
  is an enum. Anything outside `must_read | mention | skip` becomes `skip` and the reason is
  recorded, so nothing free-text is ever parsed. Generation is the expensive part and runs once
  per day on Sonnet, with a cached system prompt and a JSON schema; its output is validated and
  the run falls back to a deterministic template rather than sending nothing. Both roles sit
  behind interfaces (`DecisionModel`, `Writer`), so a model swap is a new class, not a rewrite.
- **Records for every run.** Each run commits a JSON record with the items fetched, every
  decision, per-call model, tokens (including cache reads and writes), latency and cost priced
  from `config/prices.json`, the delivery status and all errors. That makes cost and quality
  reviewable over time and lets a new decision model be A/B-tested against recorded runs.
- **Secrets stay out of the repo.** Secrets are read only from `process.env`, validated once at
  startup in `src/config.ts`, and redacted from every string in the record (including error
  messages that embed the Telegram request URL) before it is written. Non-secret settings are
  committed in `config/`.
- **Degrade, don't abort.** Each source, decision, the writer and the sender fail independently;
  a failure removes or replaces one section and is listed in the record.
