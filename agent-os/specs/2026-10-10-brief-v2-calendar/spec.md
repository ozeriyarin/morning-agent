# Spec: Brief v2 — Google Calendar via the claude.ai connector, concept answer

Status: shaped 2026-10-10. Builds on `2026-10-10-brief-v1`. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

The brief gains a `היום ביומן` section with today's Google Calendar events, and the concept section ends with an answer, not only a question.

## Design decision: calendar through the routine, not through code

The cloud routine runs as a Claude Code session with the claude.ai **Google Calendar** connector attached. The session queries today's events through the connector and writes them to `input/calendar-<date>.json` before running `npm run brief`. The script treats that file as a source (`CalendarFileSource`): present and valid → events section; absent → the brief says the calendar was not available. No OAuth code, no Google secrets in the environment, and a local dry run can use a fixture file. The hand-off file is gitignored; the run record keeps event titles and times only (no attendee emails, no descriptions, no links). Since v3 each recorded event also carries `source` (`google` | `icloud`).

Hand-off file schema (`input/calendar-YYYY-MM-DD.json`):
```json
{ "date": "2026-10-11", "timezone": "Asia/Jerusalem", "source": "google",
  "events": [ { "title": "פגישה עם נוי", "start": "2026-10-11T10:00:00+03:00", "end": "2026-10-11T10:30:00+03:00", "allDay": false, "location": "Zoom" } ] }
```
`events` may be empty. Unknown fields are ignored. The script validates with zod; an invalid file counts as a failed source (brief shows `היומן לא היה זמין`, record lists the error with reason `invalid`).

## Brief changes

- New section after the weather: `היום ביומן` — events sorted by start, `HH:MM–HH:MM כותרת (מיקום)`, all-day events first as `כל היום: כותרת`. Zero events: `אין אירועים היום`. If the file is missing: `היומן לא היה זמין`.
- Concept section (all versions): after `שאלה למחשבה: …` add `תשובה: …` — 2–4 lines, concrete, in Hebrew. Writer schema gains `concept.answer` (required); template fallback writes `תשובה: ראו את ההסבר למעלה.`
- Length target rises to 1,500 characters; the mention list is trimmed first, then must-read extras, never the calendar or the concept.

## Acceptance criteria

1. Given a valid hand-off file with three events (one all-day), the brief's calendar section lists the all-day event first, then the two timed events in start order with `HH:MM–HH:MM` in Asia/Jerusalem.
2. Given a hand-off file with `events: []`, the section says `אין אירועים היום`.
3. Given no hand-off file, the brief still sends and the section says `היומן לא היה זמין`; the record lists a `calendar` source error with reason `missing`.
4. Given an invalid hand-off file (bad JSON or wrong shape), same as 3 with reason `invalid`.
5. The record stores for each event only `title`, `start`, `end`, `allDay`; attendee emails or descriptions present in the file never reach the record (redaction test).
6. The writer schema requires `concept.answer`; a writer output without it fails validation and the template fallback includes `תשובה:`.
7. `formatBrief` renders `שאלה למחשבה:` followed by `תשובה:` on the next line, both bold labels.
8. `--dry-run` reads `test/fixtures/calendar-sample.json` when `--calendar <path>` is passed, so the calendar section can be previewed offline.
9. `npm test` passes; every criterion above has a test whose name quotes it.

## Routine changes (after the code lands)

- Attach the Google Calendar connector to the routine.
- Prompt step before `npm run brief`: "Using the Google Calendar connector, list the events for today (Asia/Jerusalem) on the primary calendar; write them to `input/calendar-<today>.json` exactly in the hand-off schema (title, start, end, allDay, location; nothing else). If the connector fails, do not create the file and continue."

## Tasks

1. `src/sources/calendar-file.ts`: zod schema for the hand-off file, `CalendarFileSource` (reads `input/calendar-<date>.json` or an explicit path), mapping to `CalendarEvent[]` with Asia/Jerusalem formatting, `missing` / `invalid` errors.
2. Types: `CalendarEvent`, `Brief.calendar`, writer schema `concept.answer`, record redaction for events.
3. Writer prompt: calendar section rules and the answer rule; template fallback updated; `formatBrief` renders both.
4. CLI `--calendar <path>`; `.gitignore` adds `input/`; fixture `test/fixtures/calendar-sample.json`.
5. Tests for criteria 1–9; README section "Calendar hand-off" with the schema and the routine step.
