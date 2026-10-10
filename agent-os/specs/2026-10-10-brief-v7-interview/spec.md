# Spec: Brief v7 — interview question of the day

Status: shaped 2026-10-10. Builds on v5/v6. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

Every brief ends with an `שאלת ראיון` section: one LeetCode-style problem with a Hebrew explanation of how to approach it (pattern, key idea, complexity, the trap), plus one short interview tip aimed at the roles Yarin is applying for (full-stack / AI engineer / backend). Problems come from a committed queue so difficulty and topics are controlled, not random.

## Design

- Queue `interview/problems.md`, one per line, same mechanics as the concept queue: `- [ ] <slug> | <title> | <difficulty> | <pattern> | https://leetcode.com/problems/<slug>/` → used lines become `- [x] YYYY-MM-DD …`. Seed with 30 problems across the classic patterns (two pointers, sliding window, hash map, stack, binary search, BFS/DFS, trees, dynamic programming, intervals, heaps, graphs, tries), easy to medium, ordered so each week covers mixed patterns.
- Tips queue `interview/tips.md`, 30 one-line tips in Hebrew (behavioural, system design, AI-role specifics such as "explain an agent loop in one sentence", CV talking points such as "lead with the production assistant"); same `[ ]`/`[x]` mechanics; cycles back to the start when exhausted.
- Program picks the next unused problem and tip; the writer gets `{ problem: { title, difficulty, pattern, url }, tip }` and must return `interview: { approach, complexity, trap }` (3–6 lines total) in Hebrew without giving full code; the tip is passed through verbatim by the program (no rewriting). Template fallback: the problem title, link and pattern, `הסבר: ראו את הקישור` and the tip.
- Rendering: `<b>שאלת ראיון</b>` → `<a href=url>title</a> · difficulty · pattern`, then approach / complexity / trap lines, then `טיפ: <tip>`. Placed after the concept section, before the footer. Length target rises to 1,800 characters; trimming order unchanged (never trim calendar, concept or interview).
- Queues advance only on a real delivered run; `/concept`-style command `/problem <slug>` is out of scope (later).
- Record: `interview: { slug, tipIndex, marked }`.

## Acceptance criteria

1. The first unused problem and tip are selected; on a delivered run both are marked with the date; a dry run marks nothing.
2. When the problem queue is empty the section says `תור השאלות ריק` and the tip still renders; when the tip queue is exhausted it restarts from the first tip.
3. The writer schema requires `interview.approach`, `complexity` and `trap`; a writer output without them fails validation and the template fallback renders title, link, pattern and tip.
4. `formatBrief` renders the section after the concept with the link, difficulty, pattern, three explanation lines and `טיפ:`; HTML-escaped.
5. The brief length target is 1,800 and trimming never removes the interview section.
6. The record stores `interview.slug` and `tipIndex`; no problem text beyond title/slug is stored.
7. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `interview/problems.md` (30 seeded) and `interview/tips.md` (30 seeded, Hebrew), `src/sources/interview.ts` (queues, mark, cycle).
2. Writer schema and Sonnet prompt extension; template fallback; `formatBrief`.
3. Record field, tests, README section "Interview question of the day".
