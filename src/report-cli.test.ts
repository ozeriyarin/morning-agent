import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayIn } from './dates.js';
import { parseReportArgs, runReport } from './report-cli.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('report CLI', () => {
  it('v5 criterion 6: "The CLI with no flags uses the last 7 days ending today (Asia/Jerusalem) and writes `reports/report-<from>-<to>.json`; `--format md` prints only Markdown."', async () => {
    // 22:30 UTC on the 10th is already the 11th in Jerusalem.
    const today = todayIn('Asia/Jerusalem', new Date('2026-10-10T22:30:00Z'));
    const args = parseReportArgs([], today);
    expect(args).toEqual({ from: '2026-10-05', to: '2026-10-11', format: 'md' });

    const root = await mkdtemp(join(tmpdir(), 'report-cli-'));
    await mkdir(join(root, 'runs'));
    const record = { date: '2026-10-06', items: [], delivery: { status: 'sent' } };
    await writeFile(join(root, 'runs', '2026-10-06.json'), JSON.stringify(record));
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const md = await runReport(root, parseReportArgs(['--format', 'md'], today));
    const written = JSON.parse(
      await readFile(join(root, 'reports', 'report-2026-10-05-2026-10-11.json'), 'utf8'),
    );
    expect(written.totals).toMatchObject({ daysRun: 1, daysDelivered: 1 });
    expect(md.startsWith('## Run report\n\nDays with a record: 2026-10-06\n')).toBe(true);
    expect(md).not.toContain('{');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^report: /));

    const json = await runReport(root, parseReportArgs(['--format', 'json'], today));
    expect(JSON.parse(json)).toEqual(written);
  });

  it.each([
    [['--from', '2026-10-02', '--to', '2026-10-01']],
    [['--from', '2026-10-1']],
    [['--format', 'csv']],
  ])('rejects %j', (argv) => {
    expect(() => parseReportArgs(argv, '2026-10-10')).toThrow();
  });

  it('honours an explicit range', () => {
    expect(parseReportArgs(['--from', '2026-10-04', '--to', '2026-10-10'], '2026-10-20')).toEqual({
      from: '2026-10-04',
      to: '2026-10-10',
      format: 'md',
    });
  });
});
