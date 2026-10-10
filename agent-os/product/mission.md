# Mission

Morning Agent sends Yarin one short Hebrew briefing on Telegram every morning at 07:00 Israel time, so the day starts with everything that matters already read, filtered and explained.

## Users

- Yarin (owner): a full-stack / AI developer in Modi'in who wants one message instead of five apps.
- Later: family members who want the same brief with their own calendars.

## Problems it solves

- Weather, two calendars, AI news and interview prep live in different places and take 15 minutes to check.
- Most items are noise; nobody filters them.
- Learning for interviews happens only when there is spare time, so it does not happen.

## What it does

1. Collects: today's weather for Modi'in, today's events (Google Calendar, Apple/iCloud Calendar), the last 24 hours of AI news from a few trusted feeds, and the next concept from a learning queue.
2. Decides: a cheap decision model (Haiku 4.5 today, Jev when access arrives) classifies each item as must-read, mention or skip.
3. Writes: Claude composes one Hebrew brief with a fixed structure, including one concept explained in a few lines.
4. Delivers: Telegram message to Yarin, and a run record (items, decisions, tokens, cost, latency) committed to the repo.

## Principles

- Spec first: every feature starts as a spec in `agent-os/specs/` written against the standards in `agent-os/standards/`.
- Decisions are cheap, generation is rare: classification runs on the cheapest model that is good enough; the writer runs once per day.
- Every run is auditable: what was fetched, what was decided, what it cost.
- Secrets never live in the repo.
