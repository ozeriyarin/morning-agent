# Spec: Brief v6 — Telegram inbox: commands and feedback

Status: shaped 2026-10-10. Builds on v5. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

Yarin can talk back to the bot. An hourly inbox run (07:00–23:00 Asia/Jerusalem) reads new Telegram messages, answers commands within the hour, and stores feedback that the replay uses as ground truth. No server, no new secrets.

## Design

- `npm run inbox` (`src/inbox-cli.ts` → `src/inbox/inbox.ts`): calls Telegram `getUpdates` with the stored offset, handles each message from the configured chat id only (others ignored and counted), sends replies with the existing `TelegramSender`, then persists the new offset. Exits with no network beyond `getUpdates` when there is nothing new.
- State: `state/telegram-offset.json` (committed by the routine only when it changed) and `feedback/<date>.json` (committed when non-empty).
- Commands (prefix `/`, case-insensitive, Hebrew or English arguments):
  - `/weather <place>`: Open-Meteo geocoding (`https://geocoding-api.open-meteo.com/v1/search?name=…&language=he&count=1`) → forecast for today at that point → the same Hebrew weather line as the brief, prefixed with the resolved place name. Unknown place → `לא מצאתי מקום בשם "<place>"`.
  - `/cost [days]`: the v5 totals block for the last N days (default 7) as a Telegram-formatted message.
  - `/concept <name>`: appends `- [ ] <name>` to `concepts/queue.md` if not present (committed), replies with the queue position.
  - `/help` or unknown command: one message listing the commands.
- Feedback: any non-command text, or a Telegram reply to the brief message, is stored as `{ at, text, replyToBriefDate? }`. If the text contains a 👍 / 👎 or the words `כן`/`לא`/`לא מעניין`/`מעניין` together with a news title fragment that matches one item of the latest record (normalised substring match), it is stored as a labelled item `{ title, label: 'keep' | 'drop' }`; otherwise as free text. Reply `תודה, נרשם.`
- Replay (v4) gains an optional "feedback" column: for items with a feedback label, agreement is measured against `keep → must_read|mention`, `drop → skip`.
- Routine: "Inbox" cron `0 4-20 * * *` UTC (07:00–23:00 Israel in summer time), runs `npm ci` only if `node_modules` is missing (cached per sandbox is not possible, so keep `npm ci`), then `npm run inbox`; commits `state/`, `feedback/`, `concepts/queue.md` only when changed.
- Safety: ignore messages older than 24 h on first run; cap 20 messages per run; never execute anything from message text beyond the listed commands; replies are plain HTML with escaping.

## Acceptance criteria

1. `getUpdates` is called with the stored offset and the new offset (last update id + 1) is persisted; with no updates nothing else is called and no file changes.
2. Messages from a chat id other than the configured one are ignored and counted in the run output.
3. `/weather תל אביב` with a fixture geocoding response and a fixture forecast replies with the resolved name and the Hebrew weather line; an empty geocoding result replies with the not-found message.
4. `/cost` replies with the v5 totals for the last 7 days; `/cost 3` for 3 days.
5. `/concept RAG` appends the concept once (a second call does not duplicate) and replies with its position.
6. Unknown command replies with the help text.
7. A reply to the latest brief containing 👎 and a fragment of an item title stores `{ title, label: 'drop' }` in today's feedback file; plain text stores free text; both reply `תודה, נרשם.`
8. Replay reports a feedback agreement row when labelled items exist.
9. No secret (bot token, chat id) appears in state, feedback or reply text (redaction test).
10. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `src/inbox/telegram-updates.ts` (getUpdates client with offset), `src/inbox/commands.ts` (parser + handlers), `src/inbox/feedback.ts`, `src/inbox/inbox.ts` orchestration, `src/inbox-cli.ts`, `npm run inbox`.
2. Geocoding + point forecast added to `src/sources/weather.ts` (shared line formatter).
3. Replay feedback column.
4. README "Talking to the bot" section with the command list and the Inbox routine prompt; `.gitignore` unchanged (state and feedback are committed).
