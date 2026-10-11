# Spec: Brief v9 — Apple Reminders via a mailed hand-off file

Status: shaped 2026-10-11. Builds on v2/v8. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

Today's Apple Reminders reach the `היום ביומן` section even though iCloud's upgraded Reminders are not served over CalDAV (verified 2026-10-11: the account exposes one empty legacy VTODO list). An iPhone Shortcut mails the day's reminders to Yarin's own Gmail at 06:45; the cloud routine copies the mail body into a hand-off file; the program reads it. Nothing about reminders is committed or made public.

## Design

- Hand-off file `input/reminders-<date>.json` (the `input/` folder is never committed), shape:
  `{ "date": "YYYY-MM-DD", "timezone": "Asia/Jerusalem", "source": "shortcut", "reminders": [{ "title": string, "due": ISO-8601 datetime or "YYYY-MM-DD", "allDay": boolean }] }`.
  The Shortcut produces `reminders` entries; the routine wraps them with `date`, `timezone`, `source` if the mail body is a bare array.
- `src/sources/reminders-file.ts`: `RemindersFileSource` modelled on `CalendarFileSource` (zod schema, `missing` / `invalid` failures, date mismatch is `invalid`), returns `Reminder[]` via the existing `remindersOnDay` sort (all-day first, then by time); `due` of a timed reminder is rendered to `HH:MM` in the configured zone.
- Precedence in the run: the file source is the reminders source when the file exists; iCloud VTODO stays the fallback only when the file is `missing`; an `invalid` file records a `calendar` error with reason `reminders-file` and falls back to iCloud. Both failing records one error (the file one).
- Record privacy: `RunRecord.reminders` becomes `{ count: number, source: 'file' | 'icloud' | 'none' }` — no titles, no due times (the v8 shape stored titles and would have been committed publicly). The v8 criterion 6 redaction test is replaced by the new criterion 5 below; keep its name quoting the v8 text only inside the v8 spec coverage check if the coverage test needs it, otherwise retire it together with the v8 criterion text (spec-coverage test must still pass).
- CLI: `--reminders <path>` preview flag mirroring `--calendar`; fixture `test/fixtures/reminders-file.json` (synthetic: one timed, one all-day, one for another day that must be dropped).
- Routine prompt (documented in README, applied by the owner): after the calendar step, search Gmail for a message with subject `reminders <date>` received in the last 12 hours, write its body to `input/reminders-<date>.json`; if none, continue. Allowed tools gain `mcp__Gmail__*`.
- README: one paragraph "Apple Reminders via Shortcut" with the mail subject and the JSON the Shortcut must send; the Shortcut steps live there too.

## Acceptance criteria

1. The reminders file for today yields its reminders sorted all-day first then by time, with `HH:MM` times in the configured zone; a reminder dated another day is dropped.
2. A missing reminders file falls back to the iCloud reminders source; an invalid file records a `calendar` error with reason `reminders-file` and still renders iCloud reminders.
3. When both the file and iCloud fail, exactly one error is recorded.
4. The brief renders `תזכורות:` from the file source exactly as from iCloud (same template, no new rendering).
5. The record stores only `reminders: { count, source }`; no title or due value from the file appears anywhere in the record (redaction test).
6. `--reminders <path>` renders the fixture in a dry run and marks nothing.
7. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `src/sources/reminders-file.ts` + schema, `RunDeps.remindersFile`, wiring and CLI flag.
2. Run precedence and single-error rule; record shape change in `src/types.ts` / `src/records.ts` (report must tolerate the v8 array shape and the new object shape).
3. Fixture, tests, README paragraph with the Shortcut JSON contract and the routine step text.
