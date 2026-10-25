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
14. **News with substance** (`2026-10-19-brief-v14-news-substance`, commit adc559f). Hacker News feed fixed, Hugging Face and Google AI added; release feeds (jev, Agent OS, spec-kit, BMAD, Claude Code) are `must_read` without a decision call; must-reads get 2-3 Hebrew sentences in a 3,200-character brief; a failed feed shows `מקור לא זמין: <name>` in the footer.
15. **JSON sources for Hacker News and GitHub releases** (`2026-10-20-brief-v15-json-sources`, commit 5de76d4). `hnrss.org` (HTTP 502) and GitHub `releases.atom` (HTTP 403 from the cloud sandbox) replaced by the Algolia HN API and the GitHub releases API behind the same `Source<Item[]>`; feed entries gain `format`.
16. **Readable news layout** (`2026-10-22-brief-v16-news-readability`, commit 0fd7a88). Each must-read is a Hebrew paragraph with its link on the next line, mentions one per line, and a right-to-left mark on every line that starts with Latin text so Telegram keeps the section RTL.
17. **Authenticated GitHub release feeds** (`2026-10-25-brief-v17-github-token`). The four release feeds had failed with HTTP 403 daily since 2026-10-21: the sandbox shares its egress IP, so GitHub's 60-calls-an-hour unauthenticated limit was already spent. An optional `GITHUB_TOKEN` is sent as a Bearer header; JSON error bodies are quoted in the record (`HTTP 403: API rate limit exceeded ...`), and a 401/403 without a token names the variable.

## Next

16. **Jev criteria tuning.** After a week of replay data with feedback labels, rewrite the Jev criteria text and re-run the A/B; switch the default only if agreement with feedback beats Haiku.
17. **Decision batching.** One Haiku call for all items instead of one per item, if quality holds on replay; cuts the decision cost and latency.
18. **Second-vendor writer rung.** The writer chain is Sonnet → Haiku → template, all Anthropic, so an Anthropic outage falls straight to the template. Add a rung from a different vendor (an open model through OpenRouter, behind the same `Writer` interface and schema) between Haiku and the template; the record already says which rung wrote, and the weekly report counts briefs by writer, so the fallback rate is visible.
19. **Second recipient.** Per-person config (calendar sources, feeds, language) so a family member can get their own brief.

## Operations

- DST ended 2026-10-25: all three routines moved one hour later in UTC that day (brief 04→05, replay 05→06, inbox 4–20→5–21). Reverse when DST starts again (2027-03-26).
- v17 needs `GITHUB_TOKEN` in the routine's cloud environment; check the next run record for the four release feeds.
