# Spec: Brief v10 — resilience: writer chain and Telegram retry

Status: shaped 2026-10-11. Builds on v1/v7. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

A Sonnet-only failure no longer drops the brief to the template, and a transient Telegram error no longer loses the morning. The writer becomes a chain, Sonnet → Haiku → template, and delivery retries once. The record says which rung wrote the brief and how many send attempts it took.

## Design

- `src/write/chain.ts`: `ChainWriter implements Writer` takes an ordered list of writers. It tries each in order; a rung is skipped when its `write` throws or when its output fails `validateBrief` (the same check the run applies today). The first rung whose output validates wins. The last rung is always `TemplateWriter`, which cannot fail. Every attempted rung's `call` usage is returned so cost is complete; each failed rung adds a `writer` error `writer <model> failed: <reason>` to the run.
- `SonnetWriter` gains a `model` constructor option (default `claude-sonnet-5-5`); the Haiku rung is the same class with `claude-haiku-4-5-20251001` and the same system prompt, cache control and schema. No second prompt to maintain.
- Record: `writer` becomes `'sonnet' | 'haiku' | 'template'` plus `writerAttempts: number`. `src/records.ts` keeps accepting the old values `'ai' | 'template' | 'fallback'`; the report maps `ai → sonnet`, `fallback → template`. The report totals gain "briefs by writer".
- Wiring: `ChainWriter([sonnet, haiku, template])` when a client exists, `TemplateWriter` alone otherwise. `--dry-run` keeps the template only (no model calls), as today.
- Telegram: `TelegramSender` retries once after `retryDelayMs` (default 2 000 ms) on a network error, a timeout, a 429 or a 5xx; a 4xx other than 429 is not retried (a bad token or chat id will not get better). `SendResult` gains `attempts`. The record's `delivery` stores `attempts`.
- Cost guard: the Haiku rung runs only when Sonnet failed; the normal morning still makes exactly one writer call.

## Acceptance criteria

1. With a Sonnet writer that throws and a Haiku writer that returns a valid brief, the chain returns the Haiku brief, the record says `writer: 'haiku'` and `writerAttempts: 2`, and the run has one `writer` error naming Sonnet.
2. With a Sonnet output that fails validation, the chain moves to the next rung instead of using the template directly; with both model rungs failing, the template renders and `writer: 'template'`, `writerAttempts: 3`.
3. When Sonnet succeeds, Haiku is never called and `writerAttempts` is 1 (spy assertion).
4. Cost usage from a failed rung is still included in the record's `calls` and total cost.
5. The Telegram sender retries once on a 500, a 429 and a network error, and succeeds on the second attempt with `attempts: 2`; it does not retry a 400 or a 401 and throws after one attempt.
6. A second Telegram failure still records `delivery.status: 'failed'` with `attempts: 2` and the run exits non-zero.
7. Older records with `writer: 'ai' | 'fallback'` still load and the report counts them under `sonnet` / `template`.
8. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `src/write/chain.ts`, `SonnetWriter` model option, wiring; `writer` / `writerAttempts` in `src/types.ts` and `src/records.ts`; report mapping.
2. Telegram retry with `attempts`; `delivery.attempts` in the record.
3. Tests (fake writers, fake fetch with scripted responses), README "Resilience" paragraph (chain order, what each failure costs), roadmap closeout.
