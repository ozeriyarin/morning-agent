# TypeScript style

- Node 20, ESM (`"type": "module"`), `strict: true`, no `any`; use `unknown` and narrow.
- One module per concern under `src/`: `sources/` (fetchers), `decide/` (decision models), `write/` (brief composer), `deliver/` (senders), `run/` (orchestration, records).
- Every external system sits behind a small interface (`Source`, `DecisionModel`, `Writer`, `Sender`) so tests use fakes and models can be swapped.
- Pure functions for transforms (parsing, mapping, formatting); side effects only in the client modules and `run/`.
- Errors: throw typed errors at the boundary, catch once in `run/`, never swallow silently; a failed source degrades the brief, it does not abort it.
- Names: `camelCase` values, `PascalCase` types, file names `kebab-case.ts`. No default exports.
- Comments: one line, only for non-obvious intent. Hebrew strings are literal UTF-8, never `\u` escapes.
