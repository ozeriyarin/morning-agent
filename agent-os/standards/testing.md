# Testing

- Vitest. Spec files sit next to the code as `*.test.ts`.
- Pure transforms get table-driven unit tests (feed parsing, weather mapping, decision mapping, brief formatting, record redaction).
- Clients (`Source`, `DecisionModel`, `Writer`, `Sender`) are tested through fakes; no network in tests. Fixtures in `test/fixtures/` are real captured responses, trimmed.
- `run/` is tested end to end with fakes: a full run produces one brief and one record; a failing source produces a brief with a missing-section note.
- Every spec's acceptance criteria map to at least one test name; the test name quotes the criterion.
- `npm test` must pass before a commit; the cloud routine runs `npm test` before `npm run brief`.
