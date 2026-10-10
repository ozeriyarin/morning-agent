# Spec: Brief v4 — Jev decision model with Haiku A/B replay

Status: shaped 2026-10-10. Builds on v3. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

The news decision step (must_read / mention / skip per item) can run on Jev, TypeSafe's decision model, instead of Haiku, with a replay tool that compares both models on items already stored in `runs/*.json` so the switch is backed by data.

## Jev access (via OpenRouter, no waitlist)

- Endpoint `POST https://openrouter.ai/api/alpha/decisions`, header `Authorization: Bearer <OPENROUTER_API_KEY>`, JSON body `{ model, state, questions }`.
- `model`: `typesafe/jev-1.13` (configurable; alias `~typesafe/jev-latest`).
- `state`: arbitrary object describing the situation. We send `{ item: { title, summary, source, publishedAt }, rules: <the decision rules from v1> }`.
- `questions`: an object keyed by question name. A choice question is `{ type: "choice", instructions: "<question text>", criteria: { must_read: "<description>", mention: "<description>", skip: "<description>" } }`.
- Response: `{ id, model, provider, answers: { <name>: { type: "choice", choice, confidence, probabilities: { option: p } } }, usage: { input_tokens, output_tokens, cost } }`.
- Context window 32k tokens (state + questions). Pricing: input tokens only, `usage.cost` is USD.
- Config: `OPENROUTER_API_KEY` env (optional). When present and `config/brief.json` has `"decisionModel": "jev"`, Jev runs; otherwise Haiku. Allow-list host: `openrouter.ai`.

## Design

- `src/decide/jev.ts`: `JevDecisionModel implements DecisionModel`. One decisions call per item (same granularity as Haiku) with the single choice question `decision`. Maps `answers.decision.choice` through the existing enum validation (invalid → `skip` + record error). Records `confidence` and `probabilities` on the decision, model = response `model`, cost from `usage.cost` (no price table needed), latency measured locally. Timeout 15 s, no retries beyond one on 429/5xx.
- `src/decide/select.ts`: picks `fake | haiku | jev` from CLI flag `--decider`, else `config.decisionModel`, else `haiku`; Jev requires the key, otherwise falls back to Haiku with a recorded warning `jev: no key, using haiku`.
- Record: `decisions[].model` already exists; add optional `confidence` and `probabilities`; `calls[]` entries for Jev carry `provider: 'openrouter'` and `costUsd` from the response.
- **Replay tool** `npm run replay -- --from 2026-10-01 --to 2026-10-31 [--models haiku,jev]`: loads the items stored in `runs/<date>.json` (title, summary, source, decision made then), re-decides each item with the requested models (fakes allowed with `--dry-run`), and writes `reports/replay-<from>-<to>.json` plus a Markdown table to stdout: per model, decisions count, cost, mean latency; agreement matrix between models (and against the original decision); the list of disagreements with titles and both choices. Items are deduped across days by normalised title. `reports/` is committed.
- Prompt parity: the Jev `instructions` and `criteria` texts are generated from the same `DECISION_RULES` constant Haiku uses, so both models see identical rule text.

## Acceptance criteria

1. Given a captured-shape OpenRouter decisions response with `choice: "mention"`, `JevDecisionModel` returns `mention` with the confidence and probabilities attached, and the call record has `provider: 'openrouter'` and `costUsd` equal to `usage.cost`.
2. The request body sent to OpenRouter has `model`, `state.item` with only title/summary/source/publishedAt, and a `questions.decision` choice question whose `criteria` keys are exactly `must_read`, `mention`, `skip`; the Authorization header is `Bearer <key>`.
3. An answer outside the three options maps to `skip` with an error in the record (same rule as Haiku).
4. A 429 or 5xx is retried once; a second failure or a timeout records an error and the item is `skip` (the brief still sends).
5. Selection: `--decider jev` without `OPENROUTER_API_KEY` falls back to Haiku and records the warning; with the key it uses Jev; `config.decisionModel` is honoured when no flag is given; default is Haiku.
6. The record never contains the OpenRouter key (redaction test with the key inside an error message).
7. Replay over two fixture run records with overlapping items dedupes by title, decides each item once per model, and produces the agreement matrix, per-model cost and latency, and the disagreement list; the Markdown table renders the same numbers.
8. Replay with `--dry-run` uses fakes for both models and writes no network calls.
9. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `src/decide/jev.ts` + tests with a fake fetch (criteria 1–4, 6).
2. `src/decide/select.ts`, CLI `--decider`, `config/brief.json` `decisionModel` (default `haiku`), env `OPENROUTER_API_KEY` optional (criterion 5).
3. `src/replay/replay.ts` + `src/replay-cli.ts`, `npm run replay`, fixtures `test/fixtures/runs/2026-10-0{1,2}.json` (synthetic), `reports/` folder (criteria 7–8).
4. README: Jev section (OpenRouter key steps, allow-list host, `decisionModel` switch, replay usage with example table); `.env.example`; secrets standard lists `OPENROUTER_API_KEY`; `agent-os/product/tech-stack.md` AI line updated.
