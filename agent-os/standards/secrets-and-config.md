# Secrets and configuration

- Secrets come from `process.env` only: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MORNING_ANTHROPIC_API_KEY` (fallback `ANTHROPIC_API_KEY`, which Claude Code cloud sessions withhold from the shell), `ICLOUD_APP_PASSWORD`. Never in code, specs, run records or logs.
- `src/config.ts` reads and validates env once at startup (zod) and fails fast with the missing variable name; nothing else touches `process.env`.
- `.env` is gitignored. `.env.example` lists every variable with a placeholder and one-line purpose.
- Non-secret settings (location, feeds, recipient language, schedule) live in `config/brief.json` and are committed.
- Run records (`runs/*.json`) must never contain tokens, calendar attendee emails or raw credentials; redact at the record boundary.
