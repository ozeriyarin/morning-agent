# Roadmap

Each item is one spec in `agent-os/specs/`. Ship in order; each step is usable on its own.

## Shipped

1. **Brief v1: weather + AI news + concept of the day → Telegram** (`2026-10-10-brief-v1`). Collector CLI, decision step (Haiku 4.5 behind `DecisionModel`), writer, Telegram sender, run record. Cloud routine at 07:00 Asia/Jerusalem.
2. **Google Calendar** (`2026-10-10-brief-v2-calendar`). Today's events through the claude.ai Google Calendar connector attached to the routine, handed over as `input/calendar-<date>.json`. Concept section gains `תשובה`.
3. **Apple / iCloud Calendar** (`2026-10-10-brief-v3-icloud`). Today's events via iCloud CalDAV with an app-specific password, merged with Google.
4. **Decision model swap** (`2026-10-10-brief-v4-jev`). `JevDecisionModel` via the OpenRouter decisions API; `npm run replay` A/Bs decisions on recorded runs. First replay: Jev 38× cheaper, 1/6 agreement → Haiku stays default.
5. **Cost and quality view** (`2026-10-10-brief-v5-cost-view`). `npm run report` over the run records; weekly line in the Sunday brief; Sunday replay routine.
6. **Telegram inbox** (`2026-10-10-brief-v6-inbox`). Hourly routine answers `/weather <place>`, `/cost`, `/concept`, `/help` and stores feedback for the replay.
7. **Interview question of the day** (`2026-10-10-brief-v7-interview`). LeetCode-style problem with a Hebrew approach, complexity and trap, plus a tip, from committed queues.
8. **Apple Reminders over CalDAV** (`2026-10-11-brief-v8-reminders`). VTODO lists in the calendar section. Verified in production as empty: upgraded Reminders are not served over CalDAV. Kept as the fallback path.
9. **Apple Reminders via a mailed hand-off file** (`2026-10-11-brief-v9-reminders-mail`). An iPhone Shortcut mails today's reminders to Gmail at 06:45; the routine copies the body into `input/reminders-<date>.json`. Record keeps only a count and source.
10. **Record privacy** (`2026-10-11-brief-v11-record-privacy`). The committed run record stores calendar events as counts only (total, all-day, timed, per source), never titles or times.
11. **Resilience: writer chain and Telegram retry** (`2026-10-11-brief-v10-resilience`). Sonnet → Haiku → template writer chain and one Telegram retry on network errors, 429 and 5xx. The record says which rung wrote the brief and how many send attempts it took.
12. **Frozen eval set for the decision step** (`2026-10-11-brief-v12-eval-set`). `eval/decisions.json` holds items labelled by Yarin (Telegram feedback or `npm run eval -- label`); `npm run eval -- score` reports accuracy, per-label precision/recall, a confusion matrix, cost and latency per model.
13. **Memory: retrieval over past runs** (`2026-10-13-brief-v13-memory`). Voyage embeddings in a committed `memory/index.json`; must-reads that follow up a past item say so, decisions get up to 3 labelled similar items as examples, and the concept links to a related past one.

## Next

14. **Jev criteria tuning.** After a week of replay data with feedback labels, rewrite the Jev criteria text and re-run the A/B; switch the default only if agreement with feedback beats Haiku.
15. **Decision batching.** One Haiku call for all items instead of one per item, if quality holds on replay; cuts the decision cost and latency.
16. **Second-vendor writer rung.** The writer chain is Sonnet → Haiku → template, all Anthropic, so an Anthropic outage falls straight to the template. Add a rung from a different vendor (an open model through OpenRouter, behind the same `Writer` interface and schema) between Haiku and the template; the record already says which rung wrote, and the weekly report counts briefs by writer, so the fallback rate is visible.
17. **Second recipient.** Per-person config (calendar sources, feeds, language) so a family member can get their own brief.

## Operations

- DST ends 2026-10-25: move all three routines one hour later in UTC (brief 04→05, replay 05→06, inbox 4–20→5–21).
