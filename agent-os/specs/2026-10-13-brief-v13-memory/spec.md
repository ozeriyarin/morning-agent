# Spec: Brief v13 — memory: retrieval over past runs ("seen before" and few-shot decisions)

Status: shaped 2026-10-13. Builds on v4/v7/v12. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

The agent remembers. A committed vector index over past news items (with their decisions and labels) and past concepts lets two things happen every morning: the writer can say a must-read is a follow-up to something already seen, and the decision model gets the most similar labelled items as examples. No vector database, no RAG framework: one embedding API, one JSON index, cosine similarity in TypeScript.

## Design

- **Embedder** `src/retrieve/embed.ts`: `Embedder { model: string; embed(texts: string[]): Promise<number[][]> }`. `VoyageEmbedder` calls `POST https://api.voyageai.com/v1/embeddings` with model `voyage-3.5-lite`, `input_type: 'document'` for indexing and `'query'` for search, batches of at most 128 texts, timeout 30 s, one retry on 429/5xx. Key `VOYAGE_API_KEY` from the environment (`.env.example` gains it); usage (`total_tokens`) is priced from `config/prices.json` (new entry, 0.02 USD per million) and recorded as calls with role `embed`. A `FakeEmbedder` for tests returns deterministic vectors from a hash of the text.
- **Index** `memory/index.json` (committed, pretty JSON, trailing newline): `{ "version": 1, "model": "voyage-3.5-lite", "dims": number, "chunks": [{ "id", "kind": "news" | "concept", "text", "date", "vector": number[], "meta": { "title", "link", "decision"?, "label"?, "name"? } }] }`. Ids: news → the eval id (`evalId(title)`), concept → `concept:<normalised name>`. `npm run memory -- build [--from --to]` (`src/memory-cli.ts`): collects news items from run records (`collectItems`) joined with the stored decision and any eval label, plus concepts from `concepts/queue.md` marked `[x]` (text = name; the writer's explanation is not stored anywhere, so only the name is embedded), embeds only ids not yet in the index, appends, saves. `--dry-run` uses the fake embedder and writes nothing. Prints `added N, index size M`.
- **Search** `src/retrieve/search.ts`: `search(index, queryVector, { kind?, k, minScore?, before? })` → top-k by cosine similarity, optional filters on `kind` and `date < before`. Pure, no I/O.
- **Memory source** `src/retrieve/memory.ts`: `MemorySource` loads the index once per run, embeds the queries of the day (one Voyage call: all titles + the concept name), and returns:
  - `seenBefore: Map<itemId, { title, link, date, score }>`: for each item in the day's window, the best news chunk with `date` before today and score ≥ `config.memory.seenThreshold` (default 0.80).
  - `examples: Map<itemId, { title, label, score }[]>`: for each item, the top `config.memory.examples` (default 3) chunks that carry an eval `label`, score ≥ `config.memory.exampleThreshold` (default 0.60).
  - `relatedConcepts: { name, score }[]` for the day's concept (top 2, score ≥ 0.60).
  If the index is missing or Voyage fails, the source throws a `SourceError('memory', …)`; the run records one error and continues without memory (same pattern as the calendar).
- **Few-shot decisions**: `DecisionModel.decide(item, examples?)`; `HaikuDecisionModel` and `JevDecisionModel` append an `Examples` block to the item prompt / Jev instructions: `"<title>" → <label>` lines. The `DECISION_RULES` text says examples are prior human labels for similar items and take precedence over the model's own judgment when the item is a near-duplicate. The record's decision entry gains `examples: number` (count only).
- **Writer**: `WriterInput.mustRead[]` / `mention[]` items gain optional `seenBefore: { title, date }`; the system prompt gains one rule: when `seenBefore` is present, the `why` line (must-read) starts with `המשך ל"<title>" מה-<D.M>:`; mention items are unchanged. `WriterInput.concept` becomes `{ name, related: string[] }` and the prompt asks the explanation to connect to one related concept in one clause when `related` is non-empty. Template fallback: must-read lines get the same prefix.
- **Record**: `memory: { indexSize, seenBefore: number, examples: number, related: number, chunkIds: string[] } | null` (ids only, no texts), embed calls in `calls` with their cost.
- **Routine**: after the brief, `npm run memory -- build` and commit `memory/index.json` with the run record (README documents the step; the owner applies it). Allow list gains `api.voyageai.com`.
- **Config** `config/brief.json`: `memory: { enabled: true, seenThreshold: 0.8, exampleThreshold: 0.6, examples: 3, seenDays: 30 }`. With `enabled: false` or no `VOYAGE_API_KEY`, the run skips memory with one warning line and no error.
- **Dry run**: fake embedder, index from `--memory <path>` (fixture `test/fixtures/memory/index.json`, small, synthetic, 8-dim vectors) or none.

## Acceptance criteria

1. `memory build` over fixture records, the eval fixture and a concept queue embeds each new id once (a second build adds nothing), stores decision and label in `meta`, and never stores feedback text or anything beyond title, link, decision, label, name (redaction test).
2. `search` returns the top-k by cosine similarity, honours `kind` and `before` filters, and excludes chunks below `minScore` (pure unit test with hand-built vectors).
3. A must-read whose nearest past news chunk scores ≥ 0.8 and is dated before today gets `seenBefore` with that chunk's title and date; a chunk dated today or scoring below the threshold does not.
4. Decisions receive at most `examples` labelled chunks each, ordered by score, and the Haiku prompt contains an `Examples` block with `"<title>" → <label>` lines; with no labelled chunks the block is absent and the prompt is byte-identical to v12.
5. The writer prompt gains the `seenBefore` rule and the related-concept rule; the template fallback prefixes a seen-before must-read with `המשך ל"<title>" מה-<D.M>:`.
6. The record stores `memory` with counts and chunk ids only, and the embed call with its cost; when the index is missing or the embedder throws, the record has one `memory` error and the brief is still delivered with no `seenBefore` and no examples.
7. With `memory.enabled: false` or no `VOYAGE_API_KEY`, no embed call is made, no error is recorded, and the output equals a v12 run.
8. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `src/retrieve/embed.ts` (Voyage + fake), `src/retrieve/search.ts`, index schema + `src/memory-cli.ts` (`npm run memory`), prices entry, `.env.example`.
2. `src/retrieve/memory.ts` source, run wiring and config, decision `examples`, writer input/prompt/template changes, record field.
3. Fixtures (`test/fixtures/memory/index.json`), tests for criteria 1–7, README section "Memory (retrieval)" with the build step for the routine and the allow-list host, roadmap closeout.
