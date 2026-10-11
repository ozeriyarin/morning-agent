# Spec: Brief v12 — frozen eval set for the decision step

Status: shaped 2026-10-11. Builds on v4/v6. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

The decision step gets a real eval: a committed, frozen set of labelled news items and one command that scores any decider against it. Labels come from Yarin (Telegram feedback or a label command), never from a model. A prompt or criteria change is judged by the score, not by feel.

## Design

- Eval file `eval/decisions.json`: `{ "version": 1, "items": [{ "id": string, "title", "link", "summary", "published", "label": "must_read" | "mention" | "skip", "labeledAt": ISO, "source": "feedback" | "manual" }] }`. `id` is the normalised title hash so the same item is never added twice. Committed; the file only grows, and an existing item's label changes only through `--relabel`.
- `npm run eval -- build [--from --to]`: collects items from the run records in the range (reuse `collectItems`), joins them with feedback labels (`loadFeedbackLabels`, `keep → must_read|mention` is ambiguous, so `keep` items are added with the **stored** decision when it was `must_read` or `mention`, else `mention`; `drop → skip`), and appends new ones to the eval file. Prints how many were added and the set size. Nothing is decided by a model here.
- `npm run eval -- label <title fragment> <must_read|mention|skip>`: labels one item from the latest record manually (match with `matchTitle`), appends it. This is how the set grows on days without Telegram feedback.
- `npm run eval -- score [--models haiku,jev] [--dry-run]`: runs `decideAll` for each model over the eval items and reports, per model: accuracy (exact match), per-label precision/recall, a 3×3 confusion matrix, cost and mean latency; writes `reports/eval-<date>-<model>.json` and prints Markdown. `--dry-run` uses the fake deciders as the replay does. The replay tool stays for day-range A/B; `score` is the frozen-set check.
- Minimum size guard: `score` prints a warning when the set has fewer than 30 items, so early numbers are not over-read.
- README section "Evaluating decisions": what the set is, how it grows, how to score, and the rule "run `eval score` before changing a decider's prompt or criteria and paste the before/after in the commit message".

## Acceptance criteria

1. `eval build` over fixture records and feedback adds each labelled item once (a second build adds nothing), maps `drop → skip` and `keep → stored decision`, and leaves unlabelled items out.
2. `eval label` appends one item from the latest record with `source: 'manual'` and refuses an unknown fragment with a clear message; `--relabel` changes an existing label and nothing else.
3. `eval score --dry-run` over a fixture eval set reports accuracy, per-label precision/recall and a 3×3 confusion matrix whose cells sum to the set size, plus cost and latency per model.
4. With fewer than 30 items the score output carries the small-set warning; with 30 or more it does not.
5. The eval file never stores feedback text, chat ids or anything beyond the item fields and the label (redaction test).
6. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `src/eval/eval-set.ts` (schema, load/save, id, build, label), `src/eval/score.ts` (metrics), `src/eval-cli.ts`, `npm run eval`.
2. Fixtures: two records + a feedback file + a small eval set; tests for criteria 1–5.
3. README section; roadmap closeout (v12 to Shipped).
