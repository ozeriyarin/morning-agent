# Roadmap

Each item is one spec in `agent-os/specs/`. Ship in order; each step is usable on its own.

1. **Brief v1: weather + AI news + concept of the day → Telegram.** Collector CLI, decision step (Haiku 4.5 behind a `DecisionModel` interface), writer, Telegram sender, run record. Runs as a Claude Code cloud routine at 07:00 Asia/Jerusalem.
2. **Google Calendar.** Today's events through the claude.ai Google Calendar connector attached to the routine (no OAuth code in the repo).
3. **Apple / iCloud Calendar.** Today's events via iCloud CalDAV with an app-specific password stored as an environment secret.
4. **Decision model swap.** `JevDecisionModel` implementing the same interface; A/B the decisions against Haiku on the recorded runs before switching.
5. **Cost and quality view.** A small report over the committed run records: items per day, decisions, tokens, cost, latency; weekly summary in the Sunday brief.
6. **Second recipient.** Per-person config (calendar sources, feeds, language) so a family member can get their own brief.
