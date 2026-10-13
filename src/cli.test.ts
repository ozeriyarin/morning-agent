import { describe, expect, it } from 'vitest';
import { parseCli } from './cli.js';

describe('parseCli', () => {
  it.each([
    [[], { dryRun: false, date: undefined }],
    [['--dry-run'], { dryRun: true, date: undefined }],
    [['--dry-run', '--date', '2026-10-11'], { dryRun: true, date: '2026-10-11' }],
    [['--dry-run', '--calendar', 'cal.json'], { dryRun: true, calendar: 'cal.json' }],
    [['--dry-run', '--icloud', 'r.ics'], { dryRun: true, icloud: 'r.ics' }],
    [['--dry-run', '--reminders', 'r.json'], { dryRun: true, reminders: 'r.json' }],
    [['--dry-run', '--memory', 'index.json'], { dryRun: true, memory: 'index.json' }],
  ])('parses %j', (argv, expected) => {
    expect(parseCli(argv)).toEqual(expected);
  });

  it.each([[['--date', '11.10.2026']], [['--unknown']], [['--memory', 'index.json']]])(
    'rejects %j',
    (argv) => {
      expect(() => parseCli(argv)).toThrow();
    },
  );
});
