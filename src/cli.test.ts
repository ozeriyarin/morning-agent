import { describe, expect, it } from 'vitest';
import { parseCli } from './cli.js';

describe('parseCli', () => {
  it.each([
    [[], { dryRun: false, date: undefined }],
    [['--dry-run'], { dryRun: true, date: undefined }],
    [['--dry-run', '--date', '2026-10-11'], { dryRun: true, date: '2026-10-11' }],
  ])('parses %j', (argv, expected) => {
    expect(parseCli(argv)).toEqual(expected);
  });

  it.each([[['--date', '11.10.2026']], [['--unknown']]])('rejects %j', (argv) => {
    expect(() => parseCli(argv)).toThrow();
  });
});
