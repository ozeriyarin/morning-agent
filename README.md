# Morning Agent

Morning Agent sends one short Hebrew briefing to Telegram every morning at 07:00 Israel time:
today's weather in Modi'in, today's Google and iCloud Calendar events, the AI news from the last 24 hours
that matter, one interview concept explained with an answer to think about, and one LeetCode
problem with the approach to it plus an interview tip. Every run also writes an auditable record (items, decisions, tokens, cost,
latency, errors) to `runs/YYYY-MM-DD.json`.

The project is spec-driven: product docs live in `agent-os/product/`, coding standards in
`agent-os/standards/`, and each feature starts as a spec in `agent-os/specs/` (v1:
`agent-os/specs/2026-10-10-brief-v1/spec.md`, v2 calendar:
`agent-os/specs/2026-10-10-brief-v2-calendar/spec.md`, v3 iCloud:
`agent-os/specs/2026-10-10-brief-v3-icloud/spec.md`, v4 Jev:
`agent-os/specs/2026-10-10-brief-v4-jev/spec.md`, v5 cost view:
`agent-os/specs/2026-10-10-brief-v5-cost-view/spec.md`, v6 inbox:
`agent-os/specs/2026-10-10-brief-v6-inbox/spec.md`, v7 interview:
`agent-os/specs/2026-10-10-brief-v7-interview/spec.md`).

## Architecture

```
npm run brief [--dry-run] [--date YYYY-MM-DD] [--calendar <path>] [--icloud <path.ics>]
              [--reminders <path.json>] [--decider fake|haiku|jev] [--memory <index.json>]
└── src/cli.ts                    args, config + env loading, exit code
    └── src/run/wiring.ts         real clients, or fakes for --dry-run
        └── src/run/run-brief.ts  orchestration, cost, redaction, record
            ├── collect (in parallel, each failure degrades one section)
            │   ├── sources/weather.ts   Open-Meteo -> mapWeather() -> WeatherDay (Hebrew WMO label)
            │   ├── sources/calendar-file.ts  input/calendar-<date>.json -> CalendarEvent[] (sorted)
            │   ├── sources/icloud-calendar.ts  CalDAV PROPFIND + REPORT (expand) -> parseICalendar()
            │   ├── sources/calendar-merge.ts   mergeCalendars(google, icloud): dedupe, all-day first
            │   ├── sources/reminders-file.ts  input/reminders-<date>.json -> Reminder[] (else iCloud)
            │   ├── sources/feeds.ts     RSS + Atom -> parseFeed() -> withinWindow(24h, releases 72h) -> dedupe()
            │   ├── sources/concepts.ts  concepts/queue.md -> next unused concept
            │   └── sources/interview.ts interview/problems.md + tips.md -> next problem and tip
            ├── recall (one Voyage call for the day's titles + the concept; failure = no memory)
            │   └── retrieve/memory.ts   memory/index.json -> seen-before, few-shot examples, related concepts
            ├── decide (<= 40 newest items, one cheap call each, with up to 3 labelled examples)
            │   ├── decide/select.ts     --decider, else config decisionModel, else haiku
            │   ├── decide/haiku.ts      claude-haiku-4-5, closed-choice tool: must_read | mention | skip
            │   ├── decide/jev.ts        typesafe/jev-1.13 via OpenRouter decisions, same rule text
            │   └── decide/fake.ts       keyword rules for --dry-run and tests
            ├── write (one call per run; a second only when Sonnet fails)
            │   ├── write/chain.ts       Sonnet -> Haiku -> template, first valid output wins
            │   ├── write/sonnet.ts      claude-sonnet-5-5 (or Haiku 4.5), cached prompt, JSON-schema output
            │   ├── write/writer.ts      BriefSchema (zod) + validateBrief()
            │   └── write/template.ts    template brief (dry run + fallback), formatBrief() -> Telegram HTML
            ├── deliver
            │   ├── deliver/telegram.ts  Bot API sendMessage, parse_mode HTML, one retry
            │   └── deliver/console.ts   prints the brief for --dry-run
            └── record -> runs/<date>.json (redacted; dry runs write runs/<date>.dry-run.json)
npm run replay -- --from <date> --to <date> [--models haiku,jev] [--dry-run]
└── src/replay-cli.ts             re-decides stored items -> reports/replay-<from>-<to>.json
    └── src/replay/replay.ts      load runs, dedupe by title, agreement, cost, latency, Markdown
npm run eval -- build [--from <date> --to <date>] | label <fragment> <label> [--relabel] | score
└── src/eval-cli.ts               frozen labelled set eval/decisions.json -> reports/eval-<date>-<model>.json
    ├── src/eval/eval-set.ts      schema, title-hash ids, build from feedback, manual labels
    └── src/eval/score.ts         accuracy, per-label precision/recall, confusion matrix, Markdown
npm run memory -- build [--from <date> --to <date>] [--dry-run]
└── src/memory-cli.ts             run records + eval labels + used concepts -> memory/index.json
    ├── src/retrieve/embed.ts     Voyage embeddings (voyage-3.5-lite) and the offline fake
    ├── src/retrieve/memory-index.ts  index schema, load/save, embed-only-new-ids build
    └── src/retrieve/search.ts    cosine top-k with kind / date / label filters, pure
npm run report -- [--from <date>] [--to <date>] [--format md|json]
└── src/report-cli.ts             default: the 7 days ending today -> reports/report-<from>-<to>.json
    └── src/report/report.ts      summarise(): per-day and total items, decisions, cost, latency, errors
npm run inbox
└── src/inbox-cli.ts              Telegram env only, offset in state/telegram-offset.json
    └── src/inbox/inbox.ts        getUpdates -> commands or feedback -> replies -> new offset
        ├── inbox/telegram-updates.ts  Bot API getUpdates with offset, text messages only
        ├── inbox/commands.ts     /weather, /cost, /concept, /help (anything else: help)
        └── inbox/feedback.ts     feedback/<date>.json, keep/drop labels matched to item titles
src/records.ts       run-record schema + loadRecords() + latestRecord(), shared by replay, report,
                     the weekly line and the inbox
config/brief.json    location, feeds, recipient, language, local send time, decisionModel
config/prices.json   $ per 1M input / output / cache-read / cache-write tokens, per model
memory/index.json    the committed vector index over past news items and concepts
concepts/queue.md    the learning queue
interview/           the interview problem and tip queues
```

## Running it

Requires Node 20+.

```bash
npm install
npm test                                      # Vitest, no network
npm run brief -- --dry-run                    # fake decisions, template writer, prints to the console
npm run brief -- --dry-run --date 2026-10-11  # pretend "today" is another day
npm run brief -- --dry-run --date 2026-10-11 --calendar test/fixtures/calendar-sample.json
npm run brief -- --dry-run --date 2026-10-12 --icloud test/fixtures/icloud-report.ics
npm run brief -- --dry-run --date 2026-10-12 --reminders test/fixtures/reminders-file.json
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
| `ICLOUD_USERNAME`           | optional: Apple ID email for the iCloud calendar (see "iCloud Calendar")                         |
| `ICLOUD_APP_PASSWORD`       | optional: iCloud app-specific password; iCloud is skipped unless both iCloud variables are set   |
| `OPENROUTER_API_KEY`        | optional: OpenRouter key for the Jev decision model (see "Jev decision model")                   |
| `VOYAGE_API_KEY`            | optional: Voyage AI key for memory embeddings (see "Memory (retrieval)")                         |

Other checks: `npm run typecheck`, `npm run lint`, `npm run format`.

## Resilience

The writer is a chain: Sonnet, then Haiku 4.5 with the same prompt and schema, then the template.
A rung is skipped when it throws or its output fails validation, and each skipped rung adds a
`writer <model> failed: <reason>` error. A normal morning makes one writer call; a Sonnet failure
costs one extra Haiku call (both priced in the record), and if Haiku fails too the template brief
is sent at no model cost, without the interview explanation. The record says which rung wrote the
brief (`writer: sonnet | haiku | template`) and `writerAttempts`; records from before v10 say `ai`
or `fallback`, which the report counts as `sonnet` and `template`. Telegram delivery retries once
after 2 seconds on a network error, a timeout, a 429 or a 5xx; a 400 or 401 (bad token or chat id)
fails at once. `delivery.attempts` records the count, and a second failure still exits non-zero.

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
source error with reason `missing` or `invalid`. The record keeps only event counts (see "Records
for every run" below): never titles, times, attendees, descriptions, locations or links.

## iCloud Calendar

iCloud events are fetched by the script itself over CalDAV (`src/sources/icloud-calendar.ts`,
plain `fetch` + `fast-xml-parser`, no extra dependency) and merged with the Google hand-off file.
It is optional: when `ICLOUD_USERNAME` or `ICLOUD_APP_PASSWORD` is missing, iCloud is skipped and
the record says `"icloud": "disabled"`.

Create an app-specific password (never use the Apple ID password itself):

1. Sign in at https://account.apple.com with the Apple ID (two-factor authentication must be on).
2. Open **Sign-In and Security** -> **App-Specific Passwords** -> **Generate an app-specific
   password** (the **+** button).
3. Name it `morning-agent` and copy the `xxxx-xxxx-xxxx-xxxx` value; Apple shows it only once.
4. Set `ICLOUD_USERNAME` (the Apple ID email) and `ICLOUD_APP_PASSWORD` as secrets of the
   routine's cloud environment (or in a local `.env`). Revoke it on the same page at any time.

The routine's network allow list must include `caldav.icloud.com` and `*.icloud.com` (Apple
serves each account from a `pNN-caldav.icloud.com` host). The script sends the credentials only
to `https://*.icloud.com`.

How it works: `PROPFIND` for the principal, then the calendar home, then the calendars in it
(only those that accept `VEVENT`); then one `REPORT` `calendar-query` per calendar (at most 3 in
parallel) with `expand` for the local day, so recurring events arrive as instances. Cancelled
events are dropped. Requests time out after 25 s and responses over 1 MB are rejected. Events in
both calendars (same title, ignoring case and spacing, and same start minute) appear once, as the
Google copy; the record counts the merged events per source (`bySource`). If iCloud fails, the
brief still sends with the Google events and the note `(iCloud לא היה זמין)`, and the record lists
a `calendar` error with reason `icloud`. The Apple ID, the password and raw iCalendar text are
redacted from the record.

Apple Reminders come over the same account, no extra credentials: reminder lists are the
collections whose component set includes `VTODO`, queried with a `VTODO` `calendar-query` for the
local day. Reminders due today (by `DUE`; ones without `DUE` and completed ones are skipped) are
listed under the events as `תזכורות:`, all-day first, then by time; the sub-block is omitted when
there are none and is never trimmed. The record keeps only `reminders: { count, source }`.
If the reminders query fails, the events still render and the record lists a `calendar` error with
reason `icloud-reminders`.

`--icloud <path.ics>` parses a saved iCalendar file instead of calling iCloud, for an offline
preview of events and reminders (`test/fixtures/icloud-report.ics` and
`test/fixtures/icloud-reminders.ics` are synthetic).

## Apple Reminders via Shortcut

iCloud does not serve the upgraded Apple Reminders over CalDAV, so an iPhone Shortcut mails the
day's reminders at 06:45 to the owner's Gmail with the subject `reminders <date>` (date as
YYYY-MM-DD) and a body that is a JSON array (`due` is an ISO-8601 datetime, or `YYYY-MM-DD` for
an all-day reminder). `allDay` is optional: when absent, a reminder is all-day if `due` is a bare
date or falls at exactly 00:00:00 local time in the configured zone; an explicit value wins:

```json
[
  { "title": "לאסוף חבילה", "due": "2026-10-12T16:45:00+03:00" },
  { "title": "להזמין תור", "due": "2026-10-12", "allDay": true }
]
```

The routine wraps the array as
`{ "date": "<date>", "timezone": "Asia/Jerusalem", "source": "shortcut", "reminders": [...] }`
in `input/reminders-<date>.json` (gitignored), and `src/sources/reminders-file.ts` reads it. When
the file exists it replaces the iCloud reminders; when it is missing, iCloud is asked as before;
when it is invalid, the record lists a `calendar` error with reason `reminders-file` and iCloud is
asked (if that fails too, only the file error is recorded). Reminders for another day are dropped
and the rest render under `תזכורות:` exactly like iCloud ones. The record keeps only
`reminders: { count, source }` with `source` one of `file`, `icloud`, `none`; never titles or due
times. `--reminders <path>` reads another file instead (`test/fixtures/reminders-file.json` is
synthetic). The routine fetches the mail with the Gmail connector in step 4 of its prompt (see
"The routine").

## Jev decision model

The news decisions can run on Jev (TypeSafe's decision model, `typesafe/jev-1.13`) instead of
Haiku. Jev is reached through OpenRouter's decisions API
(`POST https://openrouter.ai/api/alpha/decisions`) with plain `fetch`, one call per item,
carrying the item (title, summary, source, published time) and the same `DECISION_RULES` text
Haiku gets; the `must_read | mention | skip` criteria are cut from that text, so both models judge
by identical rules. Jev answers with a choice plus its confidence and per-option probabilities,
which the record keeps next to each decision; the call record has `provider: "openrouter"` and
the cost OpenRouter reports (`usage.cost`, USD; Jev bills input tokens only). Calls time out after
15 s and a 429 or 5xx is retried once; any other failure makes that item `skip` with an error in
the record, and the brief still sends.

Create an OpenRouter key:

1. Sign in at https://openrouter.ai and add a little credit under **Settings** -> **Credits**.
2. Open **Settings** -> **API Keys** -> **Create Key**, name it `morning-agent` and optionally set
   a credit limit.
3. Copy the `sk-or-v1-...` value (shown once) and set it as `OPENROUTER_API_KEY` in the routine's
   cloud environment (or a local `.env`). Delete it on the same page at any time.

The routine's network allow list must include `openrouter.ai`.

Switching: set `"decisionModel": "jev"` in `config/brief.json` (default `"haiku"`), or pass
`--decider jev` for one run (`--decider` beats the config; `fake` is the offline keyword model).
When Jev is chosen but `OPENROUTER_API_KEY` is missing, the run uses Haiku and the record gets the
warning `jev: no key, using haiku`. Dry runs always use the fake. The key is redacted from the
record like every other secret.

### Replay: A/B before switching

```bash
npm run replay -- --from 2026-10-01 --to 2026-10-31                # haiku and jev, live calls
npm run replay -- --from 2026-10-01 --to 2026-10-31 --models jev   # one model vs the stored decisions
npm run replay -- --from 2026-10-10 --to 2026-10-10 --dry-run      # fakes, no network, no keys
```

The replay reads `runs/<date>.json` for each day in the range (days without a record are
skipped), dedupes items across days by normalised title (the first day wins, with the decision
made that day as `original`), decides every item once per model and writes
`reports/replay-<from>-<to>.json` (dry runs write `.dry-run.json`, gitignored). A live replay
needs `MORNING_ANTHROPIC_API_KEY` for Haiku and `OPENROUTER_API_KEY` for Jev. Run records keep no
item summaries, so replayed items carry the title and source only. It prints a Markdown summary:
per-model decision counts, cost and mean latency, the agreement matrix (including the stored
decision) and every item the models disagree on. Example (the synthetic fixtures in
`test/fixtures/runs/`, decided by scripted models in `src/replay/replay.test.ts`):

```markdown
## Replay 2026-10-01 to 2026-10-02

Runs: 2026-10-01, 2026-10-02 · 5 unique items of 6 stored

| Model                             | Decisions | must_read | mention | skip | Errors | Cost (USD) | Mean latency (ms) |
| --------------------------------- | --------- | --------- | ------- | ---- | ------ | ---------- | ----------------- |
| haiku (claude-haiku-4-5-20251001) | 5         | 1         | 2       | 2    | 0      | 0.005000   | 100               |
| jev (typesafe/jev-1.13)           | 5         | 2         | 0       | 3    | 0      | 0.000500   | 40                |

### Agreement

|          | original   | haiku      | jev        |
| -------- | ---------- | ---------- | ---------- |
| original | 5/5 (100%) | 3/5 (60%)  | 3/5 (60%)  |
| haiku    | 3/5 (60%)  | 5/5 (100%) | 3/5 (60%)  |
| jev      | 3/5 (60%)  | 3/5 (60%)  | 5/5 (100%) |

### Disagreements

| Title                             | original | haiku   | jev       |
| --------------------------------- | -------- | ------- | --------- |
| Startup raises $20M for LLM evals | skip     | mention | skip      |
| A benchmark of local models       | mention  | mention | must_read |
```

## Evaluating decisions

`eval/decisions.json` is a committed, frozen set of news items labelled `must_read`, `mention` or
`skip` by Yarin, never by a model. Each item keeps only `id` (12-char sha1 of the normalised
title, so an item is never added twice), `title`, `link`, `summary`, `published`, `label`,
`labeledAt` and `source` (`feedback` or `manual`); no feedback text or chat id reaches the file.
The set only grows, and an existing label changes only through `--relabel`.

```bash
npm run eval -- build --from 2026-10-10 --to 2026-10-11   # default: the 7 days ending today
npm run eval -- label "tidy desk" skip                     # one item from the latest run record
npm run eval -- label "tidy desk" mention --relabel        # change an existing label
npm run eval -- score                                      # haiku and jev, live calls
npm run eval -- score --models jev --dry-run               # fakes, no network, no keys
```

`build` joins the run records in the range with the Telegram feedback labels (plus the next day's
file): `drop` becomes `skip`, and `keep` becomes the decision stored that day when it was
`must_read` or `mention`, otherwise `mention`. Unlabelled items stay out. It prints
`added <n>, set size <m>`. `label` is how the set grows on days without feedback: the fragment is
matched against the latest record's titles the same way Telegram feedback is, and an unknown or
ambiguous fragment is refused.

Since 2026-10-19 the Sunday replay routine runs `build` over its week and, when the set is not
empty, `score --models haiku,jev`, committing `eval/decisions.json` and the `reports/eval-*.json`
files with the replay report. Reply `keep` or `drop` to news lines in the brief to grow the set.

`score` runs each model over the whole set and prints accuracy, per-label precision/recall, a 3×3
confusion matrix (rows are the label, columns the prediction), cost and mean latency, and writes
`reports/eval-<date>-<model>.json` (date in Asia/Jerusalem; dry runs write `.dry-run.json`,
gitignored). Under 30 items it prints a warning that the numbers are too early to read much into.
The replay stays the tool for a day-range A/B; `score` is the frozen-set check.

Rule: run `npm run eval -- score` before changing a decider's prompt or criteria, run it again
after, and paste the before/after tables in the commit message.

## Memory (retrieval)

The agent remembers past mornings through one committed file, `memory/index.json`: one embedding
per past news item (its title, from the run records) and per used concept (its name, from the
`[x]` lines of `concepts/queue.md`), with `meta` holding only the title, link, stored decision and
eval label of an item, or the concept's name. Summaries, sources and feedback text never reach
the file. Ids are the eval id (12-char title hash) for news and `concept:<normalised name>` for
concepts. There is no vector database: the index is pretty JSON and search is cosine similarity
in TypeScript (`src/retrieve/search.ts`).

```bash
npm run memory -- build                                    # default: the 7 days ending today
npm run memory -- build --from 2026-10-01 --to 2026-10-13  # backfill a range
npm run memory -- build --dry-run                          # fake embedder, writes nothing, no key
```

`build` embeds only ids not yet in the index (a second build adds nothing), refreshes the eval
label on chunks already indexed, and prints `added <n>, index size <m>`. Embeddings come from
Voyage AI (`POST https://api.voyageai.com/v1/embeddings`, model `voyage-3.5-lite`, batches of
128, 30 s timeout, one retry on 429/5xx), priced from `config/prices.json` at $0.02 per 1M tokens.

Every morning the brief embeds the day's titles and the concept name in one call and uses the
index three ways (thresholds in the `memory` block of `config/brief.json`):

- **Seen before**: a must-read whose closest past news item (dated before today and within
  `seenDays`, default 30) scores at least `seenThreshold` (0.80) gets a why line that starts
  with `המשך ל"<title>" מה-<D.M>:`.
- **Few-shot decisions**: each decision gets up to `examples` (3) past items that carry an eval
  label and score at least `exampleThreshold` (0.60), as `"<title>" → <label>` lines in the
  prompt; with none, the prompt is exactly the one without memory.
- **Related concepts**: up to two past concepts scoring at least 0.60; the writer connects the
  explanation to one of them in one clause.

The run record gets `memory: { indexSize, seenBefore, examples, related, chunkIds }` (counts and
ids only), `examples` per decision, and the embed call under role `embed` (the report counts it
in "cost by role"). A missing index or a Voyage failure records one `memory` error and the brief
goes out without memory. With `"memory": { "enabled": false }` or no `VOYAGE_API_KEY`, a real run
skips memory with one warning and makes no embed call. A dry run uses memory only with
`--memory <path>` (fake embedder; `test/fixtures/memory/index.json` is a small synthetic index):

```bash
npm run brief -- --dry-run --date 2026-10-14 --memory test/fixtures/memory/index.json
```

Routine step (the owner adds it to the routine prompt): after `npm run brief`, run
`npm run memory -- build` and commit `memory/index.json` together with the run record. The
routine's allow list must include `api.voyageai.com`, and `VOYAGE_API_KEY` goes in its cloud
environment.

## History

`npm run report` summarises the committed run records (`runs/<date>.json`; dry-run records are
ignored) over a date range: per day the delivery status, items fetched / in window / decided,
decisions by label, decision and writer calls with tokens, cache reads, cost and mean latency,
errors by source, calendar events, iCloud status and the concept; then totals (cost by role and
by model, mean cost per day, mean latency per role, errors by source, writer cache hit ratio).

```bash
npm run report                                                # the 7 days ending today (Asia/Jerusalem)
npm run report -- --from 2026-10-04 --to 2026-10-10           # any range, Markdown on stdout
npm run report -- --from 2026-10-04 --to 2026-10-10 --format json
```

Every run writes `reports/report-<from>-<to>.json`; stdout gets only the Markdown (or the JSON
with `--format json`). To refresh the table below, run the first command and paste its output
here. On Sundays the brief footer gains a second line computed in code (no AI) from the previous
7 days' records, where a day without a record counts as not run:
`השבוע: N ימים, עלות ~$X, M פריטים נבדקו, K שגיאות`.

Latest table (`npm run report -- --from 2026-10-04 --to 2026-10-10`; refreshed by hand, the
routine only commits the Sunday report file):

```markdown
## Run report

Days with a record: 2026-10-10

| Date       | Delivery | Fetched | In window | Decided | must_read | mention | skip | Decision calls                             | Writer calls                               | Cost    | Errors         | Calendar | iCloud | Concept             |
| ---------- | -------- | ------- | --------- | ------- | --------- | ------- | ---- | ------------------------------------------ | ------------------------------------------ | ------- | -------------- | -------- | ------ | ------------------- |
| 2026-10-10 | sent     | 1317    | 6         | 6       | 1         | 1       | 4    | 6 × 5370/200 tok, cache 0, $0.0064, 841 ms | 1 × 449/770 tok, cache 0, $0.0126, 7663 ms | $0.0189 | Hacker News AI | 1        | ok     | typed tool registry |

### Totals

- Days run: 1, delivered: 1
- Items: 1317 fetched, 6 in window, 6 decided
- Cost: $0.0189 (mean $0.0189 per day)
- Cost by role: decision $0.0064, writer $0.0126
- Cost by model: claude-haiku-4-5-20251001: $0.0064, claude-sonnet-5-5: $0.0126
- Mean latency: decision 841 ms, writer 7663 ms
- Writer cache hit ratio: 0.00
- Errors: 1 (Hacker News AI: 1)
```

## Adding a feed

Append an entry to `feeds` in `config/brief.json`:

```json
{ "name": "Some Blog", "url": "https://example.com/feed.xml" }
```

RSS 2.0 and Atom both work; they go through the same parser. Items older than 24 hours before
the 07:00 send time are dropped, and titles that repeat across feeds are merged into one item.
An entry may also set `"kind": "release"` (default `"news"`) and `"windowHours"` (default 24, or
72 for a release feed). Release items skip the decision model: they are `must_read` with
`reason: "release"` in the record and cost nothing, unless memory has already shown them, in
which case they are `skip`. A bare version title (`0.3.0`, `v1.2.0`) is prefixed with the feed
name (`jev 0.3.0`). A feed that fails adds a footer line `מקור לא זמין: <name>` to the brief, so a
quiet news day caused by a dead feed is visible.

Feeds since v14 (2026-10-19): news from Simon Willison, Hacker News AI
(`https://hnrss.org/newest?q=AI+OR+LLM+OR+Claude`; the `&points=50` variant returned HTTP 502),
OpenAI News, Hugging Face (`https://huggingface.co/blog/feed.xml`) and Google AI
(`https://blog.google/technology/ai/rss/`; the LangChain blog has no feed since it moved to Webflow); releases from jev on PyPI, Agent OS, spec-kit, BMAD and
Claude Code (GitHub `releases.atom`). Feed summaries keep 600 characters for the decider and the
writer (the record still keeps 400), each must-read gets 2-3 Hebrew sentences (at most 280
characters), and the brief targets 3,200 visible characters (Telegram allows 4,096). The decision
rules add SDD frameworks and Jev / Claude Code releases to `must_read`, plus a thin-day line.
Eval (`npm run eval -- score`) before and after the prompt change: not run, both times. The live
score needs `MORNING_ANTHROPIC_API_KEY` (and `OPENROUTER_API_KEY` for Jev), which the build
machine did not have, and `eval/decisions.json` holds 0 labelled items, so there is no number
to compare yet; `score --dry-run` uses keyword fakes that ignore the prompt.
Anthropic has no public RSS feed yet (`https://www.anthropic.com/rss.xml` returned 404 on
2026-10-10); add it here when one appears.

## Adding a concept

Add a line to `concepts/queue.md`:

```markdown
- [ ] vector databases
```

The run takes the first `- [ ]` line and, after the brief is delivered, rewrites it as
`- [x] 2026-10-11 vector databases`. When every line is used, the brief says the queue is empty.

## Interview question of the day

Every brief ends with `שאלת ראיון`, after the concept and before the footer: one LeetCode problem
from `interview/problems.md` and one tip from `interview/tips.md`.

```markdown
- [ ] two-sum | Two Sum | easy | hash map | https://leetcode.com/problems/two-sum/
- [ ] בראיון התנהגותי ענו במבנה STAR: מצב, משימה, פעולה, תוצאה, ותנו לתוצאה מספר.
```

The run takes the first `- [ ]` line of each file and, only after a real run delivered the brief,
marks both as `- [x] YYYY-MM-DD …`; a dry run marks nothing. The 30 seeded problems (easy and
medium) cycle through twelve patterns (hash map, two pointers, stack, binary search, sliding
window, trees, BFS/DFS, dynamic programming, intervals, heaps, graphs, tries), so any 7 days in a
row mix 7 patterns. The writer gets the problem's title, difficulty, pattern and link plus the tip
and returns `interview: { approach, complexity, trap }` in Hebrew, without code; the tip itself is
printed as is. The section renders as:

```text
שאלת ראיון
Two Sum · easy · hash map        (the title links to the problem)
גישה: …
סיבוכיות: …
מלכודת: …
טיפ: …
```

With the template writer (dry run) or when the writer output fails validation, the three lines
become `הסבר: ראו את הקישור`. When every problem is used the section says `תור השאלות ריק` and the
tip still shows; when every tip is used the tips start again from the first one. If a queue file
cannot be read the section says `חסר: שאלת ראיון`. The brief targets 3,200 visible characters and
trimming only drops news, never the calendar, the concept or this section. The record keeps
`interview: { slug, tipIndex, marked }` (`tipIndex` counts from 0), never the problem text, the
tip or the explanation. Add a problem or a tip by appending a `- [ ]` line in the same format.

## The routine

The brief runs as a Claude Code cloud routine named "Morning brief v2": cron `0 4 * * *` UTC
(07:00 Israel summer time; change to `0 5 * * *` after DST ends on 2026-10-25), repo
`ozeriyarin/morning-agent`, model `claude-sonnet-5-5`, allowed tools Bash, Read, Write, Edit,
Glob, Grep, `mcp__Google_Calendar__*` and `mcp__Gmail__*`. The secrets are environment variables
of the routine's cloud environment, whose allow list includes `registry.npmjs.org`, `github.com`,
`api.telegram.org`, `api.open-meteo.com`, `geocoding-api.open-meteo.com`, the feed hosts
(`simonwillison.net`, `hnrss.org`, `openai.com`, `huggingface.co`, `blog.google`,
`pypi.org` and `github.com` for the release feeds),
`caldav.icloud.com`, `*.icloud.com` and `openrouter.ai`. On Sundays the routine commits the
`reports/report-<from>-<to>.json` file; it does not edit `README.md`.

Routine prompt:

```text
You are the scheduled runner for the morning-agent repo (already checked out in the working directory, branch main). Do exactly this, in order, and stop if a step fails:

1. Run `npm ci` (fall back to `npm install` if there is no lockfile).
2. Run `npm test`. If tests fail, do not send anything: report the failing test names and stop.
3. Compute today's date in Asia/Jerusalem as YYYY-MM-DD (`TZ=Asia/Jerusalem date +%F`). Using the Google Calendar connector tools, list the events of the primary calendar for that day (00:00 to 23:59 Asia/Jerusalem). Create the folder `input/` if needed and write `input/calendar-<date>.json` with exactly this shape and nothing else: {"date": "<date>", "timezone": "Asia/Jerusalem", "source": "google", "events": [{"title": string, "start": ISO-8601 datetime, "end": ISO-8601 datetime, "allDay": boolean, "location": string or omitted}]}. For all-day events use the day's 00:00 and 23:59 in +03:00 (or +02:00 after DST ends) as start/end. Do not include attendees, descriptions or links. If the connector is unavailable or fails, do not create the file and continue.
4. Using the Gmail connector, search `subject:reminders newer_than:1d` and keep only messages whose subject starts with `reminders <date>` (the subject may have extra text after the date). Take the newest one, read its plain-text body, and write it to `input/reminders-<date>.json`; if the body is a bare JSON array, wrap it as {"date": "<date>", "timezone": "Asia/Jerusalem", "source": "shortcut", "reminders": <array>}. Do not read any other mail. If there is none, or the connector fails, do not create the file and continue.
5. Run the real brief: if the file /root/.ccr/ca-bundle.crt exists run `NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt npm run brief`, otherwise `npm run brief`. It reads TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, MORNING_ANTHROPIC_API_KEY (and OPENROUTER_API_KEY, ICLOUD_USERNAME, ICLOUD_APP_PASSWORD when set) from the environment, honours HTTPS_PROXY and reads the hand-off files from steps 3 and 4. Capture its output.
6. If today is a Sunday in Asia/Jerusalem, also run `npm run report` (default range: last 7 days) so `reports/report-<from>-<to>.json` is written.
7. If the run wrote a file under runs/ (not a *.dry-run.json), commit `runs/`, `concepts/queue.md`, `interview/problems.md`, `interview/tips.md` and any new `reports/report-*.json` with the message `brief: <date>`, then `git pull --rebase origin main` if needed and push to origin main. Never commit `input/` or anything else. Never print or commit secret values.
8. Report: delivery status (sent or not, Telegram error text if any), whether the calendar file was written and how many events it had, whether the reminders file was written and how many reminders it had (no titles), the total cost from the record, the number of items checked, and any errors listed in the record (quote exact messages). Do not paste the Telegram token, chat id, API keys or reminder titles anywhere.
```

## Talking to the bot

Write to the bot in the same Telegram chat that gets the brief. An hourly "Inbox" routine reads
new messages with `getUpdates` (07:00–23:00 Israel time), so answers arrive within the hour.
Messages from any other chat are ignored and only counted. Commands are case-insensitive and take
Hebrew or English arguments:

| Command           | Reply                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `/weather <מקום>` | today's forecast there, in the brief's weather line, e.g. `תל אביב-יפו: מעונן, 21°-29°, ...` |
| `/cost [days]`    | the `npm run report` totals for the last N days (default 7, at most 90)                      |
| `/concept <name>` | adds `- [ ] <name>` to `concepts/queue.md` unless it is there, and replies with its place    |
| `/help`           | the commands, plus how feedback and 👍 / 👎 labels work (also the reply to unknown commands) |

`/weather` resolves the place with Open-Meteo geocoding (Hebrew names, first match) and answers
`לא מצאתי מקום בשם "<place>"` when nothing matches. Any other text, or a reply to the brief, is
feedback and gets `תודה, נרשם.`; it is appended to `feedback/<date>.json` as
`{ at, text, replyToBriefDate? }`. When the text has 👍 / 👎, `כן`, `לא`, `מעניין` or
`לא מעניין` (any negation means drop) plus words from exactly one news title of the latest run
record, the entry also gets `{ title, label: "keep" | "drop" }`, e.g. `👎 tidy desk`. The replay
(`npm run replay`) reads those labels for its range (plus the next day) and adds a `feedback` row
to the agreement table: `keep` agrees with `must_read` or `mention`, `drop` with `skip`. The same
labels also feed the frozen eval set through `npm run eval -- build`.

Safety: at most 20 messages per run; on the very first run (no `state/telegram-offset.json`)
messages older than 24 hours are skipped; nothing in a message runs except the four commands;
replies are Telegram HTML with every value escaped; the bot token and chat id are scrubbed from
incoming text before it reaches a reply, the queue or a feedback file. The run prints one line,
e.g. `inbox: 3 updates, 1 commands, 1 feedback, 1 ignored from other chats, 0 stale, 0 errors`.
With nothing new it calls only `getUpdates` and changes no file.

```bash
npm run inbox      # needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID only
```

The "Inbox" routine: cron `0 4-20 * * *` UTC (07:00–23:00 Israel summer time; `0 5-21 * * *`
after DST ends), same repo, model and environment as the brief, with `api.telegram.org`,
`api.open-meteo.com` and `geocoding-api.open-meteo.com` on the allow list. Routine prompt:

```text
Install dependencies with `npm ci` (the sandbox starts without node_modules). Run
`npm run inbox`. Then, only if `git status --porcelain` shows changes under `state/`,
`feedback/` or `concepts/queue.md`, commit exactly those paths with the message
`inbox: <date> <HH:MM>` (Asia/Jerusalem) and push; never commit anything else. Finally report the
summary line the command printed.
```

## Why these design choices

- **Cheap decisions, one writer call.** Classifying news is a closed-choice task, so each item
  goes to the cheapest adequate model (Haiku 4.5, or Jev via OpenRouter) as a closed choice: a
  tool whose only argument is an enum, or a Jev choice question with the same three options. Anything outside `must_read | mention | skip` becomes `skip` and the reason is
  recorded, so nothing free-text is ever parsed. Generation is the expensive part and runs once
  per day on Sonnet, with a cached system prompt and a JSON schema; its output is validated and
  the run falls back to Haiku, then to a deterministic template, rather than sending nothing. Both roles sit
  behind interfaces (`DecisionModel`, `Writer`), so a model swap is a new class, not a rewrite.
- **Records for every run.** Each run commits a JSON record with the items fetched, every
  decision, per-call model, tokens (including cache reads and writes), latency and cost priced
  from `config/prices.json`, the delivery status and all errors. That makes cost and quality
  reviewable over time and lets a new decision model be A/B-tested against recorded runs.
  Records are public, so the calendar is stored only as
  `calendar: { count, allDay, timed, bySource: { google, icloud } }` (`null` when both calendars
  failed) and reminders only as `{ count, source }`: event and reminder titles, times and
  locations are never committed. Records committed on 2026-10-10 and 2026-10-11 still hold event
  titles in git history; purging them is left to the owner.
- **Secrets stay out of the repo.** Secrets are read only from `process.env`, validated once at
  startup in `src/config.ts`, and redacted from every string in the record (including error
  messages that embed the Telegram request URL) before it is written. Non-secret settings are
  committed in `config/`.
- **Degrade, don't abort.** Each source, decision, the writer and the sender fail independently;
  a failure removes or replaces one section and is listed in the record.
