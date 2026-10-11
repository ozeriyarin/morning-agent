# Spec: Brief v11 — record privacy: no calendar titles in committed records

Status: shaped 2026-10-11. Builds on v2/v3/v9. Standards applied: typescript-style, secrets-and-config, testing.

## Goal

The run record is committed to a public repo, and today it stores the titles of every calendar event (Google and iCloud) with start and end times. v9 already reduced reminders to a count and source; v11 does the same for events. Nothing personal beyond counts leaves the sandbox.

## Design

- `RunRecord.calendar` becomes `{ count: number, allDay: number, timed: number, bySource: { google: number, icloud: number } }` or `null` when both calendars were unavailable (as the array was null before). No titles, no times, no locations.
- `src/records.ts` accepts the old array shape and the new object; the report derives the counts from either (`events` per day column unchanged).
- The `--dry-run` record follows the same rule (it is gitignored but should not differ in shape).
- The redaction test for the record is extended: no event title from any fixture may appear anywhere in the record JSON (the existing v9 reminders test is the pattern).
- README "Records" paragraph updated: what the record stores and the explicit statement that titles are never committed.
- Out of scope: rewriting git history to purge the titles already committed on 2026-10-10 and 2026-10-11 (owner's decision; documented as a note in the README paragraph).

## Acceptance criteria

1. A delivered run with two Google events and two iCloud events (one all-day) stores `calendar: { count: 4, allDay: 1, timed: 3, bySource: { google: 2, icloud: 2 } }`.
2. No calendar event title, location or time from the fixtures appears anywhere in the record JSON (redaction test over the serialised record).
3. When both calendars fail the record stores `calendar: null` and the error entries as before.
4. Older records with the array shape still load, and the report's per-day event count is the array length for them and `count` for new ones.
5. `npm test` passes; every criterion has a test whose name quotes it.

## Tasks

1. `src/types.ts` record shape, `src/run/run-brief.ts` mapping, `src/records.ts` tolerant schema, report derivation.
2. Tests (criteria 1–4), README paragraph, roadmap closeout (move v11 to Shipped).
