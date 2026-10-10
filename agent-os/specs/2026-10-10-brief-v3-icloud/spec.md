# Spec: Brief v3 — iCloud (Apple) Calendar via CalDAV

Status: shaped 2026-10-10. Builds on v2. Standards applied: typescript-style, secrets-and-config, ai-calls, testing.

## Goal

The `היום ביומן` section shows events from both calendars: Google (v2 hand-off file) and iCloud (fetched by the script over CalDAV). Duplicates that exist in both are shown once.

## Design

- New source `ICloudCalendarSource` in `src/sources/icloud-calendar.ts`, behind the same `CalendarEvent[]` contract as the v2 file source. No new dependency: CalDAV is HTTP + XML (fast-xml-parser is already present) and the response is iCalendar text parsed by a small `parseICalendar()`.
- Credentials: `ICLOUD_USERNAME` (the Apple ID email) and `ICLOUD_APP_PASSWORD` from `process.env`, both optional: when either is absent the iCloud source is disabled and the record notes `icloud: disabled`. The username is a config-like value but still read from env so the repo stays personal-data-free. Basic auth over HTTPS to `https://caldav.icloud.com`.
- Discovery (cached per run): `PROPFIND /` for `current-user-principal` → `PROPFIND <principal>` for `calendar-home-set` → `PROPFIND <home>` (Depth 1) listing calendars with `displayname` and `resourcetype` containing `calendar`; skip calendars whose `supported-calendar-component-set` lacks `VEVENT`.
- Events: for each calendar, `REPORT` `calendar-query` with `<c:comp-filter name="VEVENT"><c:time-range start=… end=…/></c:comp-filter>` for the local day in UTC, and `<c:expand start end/>` so the server expands recurring events into instances. Parse `VEVENT`s: `SUMMARY`, `DTSTART`/`DTEND` (DATE → all-day; DATE-TIME with `TZID` or `Z`), `LOCATION`, `STATUS:CANCELLED` dropped.
- Merge: `mergeCalendars(google, icloud)` dedupes on normalised title + start minute; all-day first, then start order. The record lists each event with `source: 'google' | 'icloud'`.
- Failure: any CalDAV or parse error is a `calendar` source error with reason `icloud` and the Google events still render; the section footer says `(iCloud לא היה זמין)` when iCloud failed and Google worked.
- Timeouts 25 s; at most 3 calendars queried in parallel; PROPFIND responses capped at 1 MB.
- Network: the environment allow list must include `caldav.icloud.com` (and the redirect targets Apple may use, `*.icloud.com`).

## Acceptance criteria

1. Given captured PROPFIND fixtures, discovery yields the calendar home and the list of VEVENT calendars with display names.
2. Given a captured REPORT response with three events (one all-day DATE, one DATE-TIME with TZID Asia/Jerusalem, one UTC `Z`), parsing yields three `CalendarEvent`s with correct local times and `allDay` flags.
3. A `STATUS:CANCELLED` VEVENT is dropped.
4. `mergeCalendars` shows an event present in both Google and iCloud once, keeps the Google copy, and sorts all-day first then by start.
5. When `ICLOUD_USERNAME` or `ICLOUD_APP_PASSWORD` is missing, the iCloud source is disabled, the record says so, and the Google file still renders.
6. When CalDAV returns 401 or times out, the brief still sends with Google events and the `(iCloud לא היה זמין)` note; the record has a `calendar` error with reason `icloud`.
7. The record never contains the Apple ID, the app password or the raw iCalendar text (redaction test using an error message that embeds the request URL with credentials).
8. `--dry-run --icloud test/fixtures/icloud-report.ics` previews the iCloud parsing offline.
9. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `src/sources/icloud-calendar.ts`: CalDAV client (propfind, report with expand), `parseICalendar`, `ICloudCalendarSource`.
2. `src/sources/calendar-merge.ts`: `mergeCalendars`; `CalendarEvent.source`.
3. Wiring: env (`ICLOUD_USERNAME`, `ICLOUD_APP_PASSWORD` optional), source enabled only when both present, record fields, redaction.
4. Fixtures: `test/fixtures/icloud-propfind-*.xml`, `test/fixtures/icloud-report.ics` (synthetic, no real data). CLI `--icloud <path>`.
5. README: iCloud section with the app-specific password steps and the allow-list hosts; `.env.example` updated; `agent-os/standards/secrets-and-config.md` lists `ICLOUD_USERNAME`.
