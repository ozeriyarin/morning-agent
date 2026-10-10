# Tech stack

- **Language / runtime:** TypeScript on Node 20, ESM, strict mode. `npm run brief` is the single entry point.
- **Data sources:** Open-Meteo (weather, no key) for Modi'in; RSS/Atom feeds parsed in-process; Google Calendar via the claude.ai connector attached to the routine; iCloud Calendar via CalDAV.
- **AI:** Anthropic SDK, plus OpenRouter over plain `fetch` for Jev. Decision step behind a `DecisionModel` interface: `HaikuDecisionModel` (claude-haiku-4-5, default) or `JevDecisionModel` (`typesafe/jev-1.13` via the OpenRouter decisions API), switched by `decisionModel` in `config/brief.json` or `--decider`, and A/B-compared on recorded runs with `npm run replay`. Writer: claude-sonnet-5-5 with a cached system prompt and a fixed output schema (structured output).
- **Delivery:** Telegram Bot API over plain HTTPS (`sendMessage`, MarkdownV2 or HTML).
- **Scheduling:** Claude Code cloud routine, cron at 04:00 UTC (07:00 Asia/Jerusalem, 06:00 in winter time: adjust when DST ends). The routine checks out this repo, runs the brief, and commits the run record.
- **Secrets:** environment variables only (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`, `ICLOUD_APP_PASSWORD`, `OPENROUTER_API_KEY`), set in the cloud environment, never committed. `.env` is gitignored; `.env.example` lists the names.
- **Tests:** Vitest. Pure transforms (feed parsing, decision mapping, brief formatting) unit-tested; API clients behind interfaces with fakes.
- **Records:** `runs/YYYY-MM-DD.json` committed by the routine: items fetched, decisions, model, tokens, cost, latency.
- **Tooling:** Agent OS v3 (standards, product, specs), Claude Code for implementation, ESLint + Prettier.
