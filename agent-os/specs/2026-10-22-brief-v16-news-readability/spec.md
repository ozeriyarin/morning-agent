# Spec: brief v16 — readable news layout on a phone

Status: shaped 2026-10-22 from the owner's report that the "AI היום" section is unreadable. Builds on v14. Standards applied: typescript-style, testing. Shipped 2026-10-22, commit 0fd7a88.

## Goal

Every must-read reads as a short Hebrew paragraph with its link under it, mentions are one per line, and no line mixes an English title with Hebrew prose in a way that Telegram renders left-to-right.

## Design

- **Cause**: `newsLines` rendered each must-read as one line `• <a>English title</a> - <Hebrew why>`. Telegram picks a paragraph's direction from its first strong character, so the line is laid out left-to-right and the Hebrew sentences after the dash are scrambled. The "עוד:" line joined three English links with " · " on one line.
- **Layout** (`src/write/template.ts`, `newsLines`): for each must-read, line 1 is the Hebrew `why` prefixed with a numbered bold marker (`<b>1.</b>`), line 2 is `קישור: <a>title</a>`, and a blank line separates items. Mentions follow a bold `עוד לקריאה:` header, one per line as `• <a>title</a>`.
- **Direction mark**: every news line that begins with a digit, a bullet or a Latin character starts with U+200F (right-to-left mark) so it renders right-to-left like the rest of the brief; `visibleLength` does not count the mark.
- The trim loop (`formatBrief`) is unchanged: mentions drop first, then extra must-reads.

## Acceptance criteria

1. A must-read renders as two lines, the Hebrew `why` with a numbered marker first and `קישור: <a href>title</a>` second, with a blank line between consecutive must-reads.
2. Mentions render under a `עוד לקריאה:` header, one `• <a>title</a>` line each, never joined on one line.
3. Every news line whose first visible character is not Hebrew starts with U+200F, and `visibleLength` ignores the mark.
4. `npm test` passes; every criterion has a test whose name quotes it.
