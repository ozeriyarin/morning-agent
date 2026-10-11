# Spec: Brief v8 — Apple Reminders in the calendar section

Status: shaped 2026-10-11. Builds on v3/v7. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

The `היום ביומן` section also lists today's Apple Reminders (the ones iOS shows in the Calendar app: reminders with a due date today), fetched over the same iCloud CalDAV account, no new credentials.

## Design

- iCloud stores reminder lists as CalDAV collections whose `supported-calendar-component-set` contains `VTODO` (not `VEVENT`). v3 discovery skips them; v8 keeps them in a second list `todoCalendars`.
- For each VTODO collection: `REPORT calendar-query` with `<c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"><c:time-range start=… end=…/></c:comp-filter></c:comp-filter>` for the local day; parse `VTODO` components: `SUMMARY`, `DUE` (DATE → all-day, DATE-TIME with TZID/Z → timed), `STATUS` / `COMPLETED` (completed ones dropped), `PRIORITY` ignored. If a server ignores time-range for VTODO, filter client-side on `DUE` within the local day; reminders without `DUE` are not shown.
- Rendering: after the events, a sub-block `תזכורות:` with one line per reminder: `HH:MM כותרת` for timed, `כל היום: כותרת` first for undated-time ones; sorted like events. No reminders → the sub-block is omitted (no "none" line). Merged with Google events logic untouched; dedupe not needed (different kind).
- Record: `reminders: [{ title, due, allDay }]` with the same redaction rules; `icloud` status unchanged; a VTODO failure records `calendar` error with reason `icloud-reminders` and the events still render.
- `--icloud <path>` preview also accepts an `.ics` with VTODOs; fixture `test/fixtures/icloud-reminders.ics` (synthetic: one timed, one all-day, one completed).
- Length target unchanged (1,800); reminders are never trimmed.

## Acceptance criteria

1. Discovery keeps VTODO collections in a separate list and VEVENT collections as before (fixture with one of each).
2. Parsing the reminders fixture yields two reminders (one timed with the correct local time, one all-day) and drops the completed one.
3. A reminder whose `DUE` is outside the local day is not shown; a reminder without `DUE` is not shown.
4. The brief renders `תזכורות:` under the events with all-day first, then by time; with zero reminders the sub-block is absent.
5. A VTODO query failure records a `calendar` error with reason `icloud-reminders` while events still render.
6. The record stores reminders as `{ title, due, allDay }` only (redaction test: description/alarms never stored).
7. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `src/sources/icloud-calendar.ts`: discovery split, VTODO query, `parseICalendar` extended to VTODO (shared unfold/parse), `ICloudCalendarSource` returns `{ events, reminders }` (or a sibling `ICloudRemindersSource` sharing the client).
2. Types, run orchestration, record, template rendering.
3. Fixture, tests, README (one paragraph under the iCloud section).
