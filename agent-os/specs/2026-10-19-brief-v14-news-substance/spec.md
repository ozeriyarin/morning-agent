# Spec: brief v14 — news with substance

Status: shaped 2026-10-19 from the run records of 2026-10-16..19 (2 items/day after the 24 h window, 0 must_read, Hacker News feed HTTP 502 for three days, no source for SDD frameworks or Jev releases). Builds on v1/v10/v12/v13. Standards applied: typescript-style, ai-calls, testing.

## Goal

The "AI היום" section carries information, not bare links: each must-read gets a short paragraph, new releases of the tools the owner cares about (Jev, Agent OS, spec-kit, BMAD, Claude Code) always appear, and a quiet day is caused by the news, not by a dead feed.

## Design

- **Feeds** (`config/brief.json`): fix Hacker News to `https://hnrss.org/newest?q=AI+OR+LLM+OR+Claude` (the `points=` variant returns 502); add Hugging Face blog (`https://huggingface.co/blog/feed.xml`), Google AI blog (`https://blog.google/technology/ai/rss/`; LangChain was planned but its blog serves no feed); add release feeds with `kind: "release"`: Jev on PyPI (`https://pypi.org/rss/project/jev/releases.xml`), Agent OS (`https://github.com/buildermethods/agent-os/releases.atom`), spec-kit (`https://github.com/github/spec-kit/releases.atom`), BMAD (`https://github.com/bmad-code-org/BMAD-METHOD/releases.atom`), Claude Code (`https://github.com/anthropics/claude-code/releases.atom`). Feed entries gain optional `kind: "news" | "release"` (default news) and optional `windowHours` (default 24; release feeds default 72). The README lists the new allow-list hosts: `github.com`, `pypi.org`, `huggingface.co`, `blog.google`.
- **Release items skip the decider**: an item from a release feed is labelled `must_read` without a model call; the record's decision entry carries `reason: "release"` and no call. The item title is prefixed with the feed name when the feed title is a bare version (`0.3.0` → `jev 0.3.0`). Memory seen-before still applies (a release shown yesterday is not repeated).
- **Richer input for the decider and writer**: `stripHtml` keeps 600 characters instead of 300; `RECORD_SUMMARY_CHARS` stays 400.
- **Writer**: `news.mustRead[].why` becomes 2–3 Hebrew sentences (what it is, why it matters to the owner, what to try), max 280 characters, in the writer prompt and schema; the brief budget rises from 1,800 to 3,200 characters (`template.ts` trim limit and the prompt line agree; Telegram's limit is 4,096). The decider prompt adds: SDD / spec-driven frameworks (Agent OS, spec-kit, BMAD), Claude Code and Jev releases are must_read; on a thin day pick the two or three strongest items as must_read rather than labelling everything skip.
- **Fewer dead-feed quiet days**: a source error in the record already exists; the brief footer line "מקור לא זמין: <name>" is shown when a feed failed, so the owner sees the cause.
- **Eval**: `npm run eval -- score` before and after on `eval/decisions.json`; the README records both numbers and the new feed list.

## Acceptance criteria

1. Feed config accepts `kind` and `windowHours`; `withinWindow` honours a per-item window so a release published 60 hours ago from a 72 h feed is kept while a 30-hour-old news item is dropped.
2. An item from a `release` feed is recorded as `must_read` with `reason: "release"` and without a decision call; a bare version title is prefixed with the feed name.
3. The writer prompt asks for 2–3 sentences in `why` and the brief limit is 3,200; the template trims mentions first and never calendar/concept/interview, and a brief of 3,000 characters is sent untrimmed.
4. The decision rules name SDD frameworks and Jev/Claude Code releases as must_read and include the thin-day instruction; the eval score on `eval/decisions.json` does not drop.
5. A failed feed appears in the brief as a one-line footer note naming the source.
6. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. Config schema + feeds, `withinWindow` per-item window, release pass-through in `run-brief.ts`.
2. Prompt and schema changes (decider, writer, template limit, footer note).
3. Tests, eval before/after, README feeds + allow list, roadmap closeout.
