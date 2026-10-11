import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseCommand, runCommand, type CommandContext } from './commands.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`test/fixtures/${name}`, 'utf8'));

const now = new Date('2026-10-10T08:00:00Z');

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'inbox-cmd-'));
  await mkdir(join(root, 'runs'));
  await mkdir(join(root, 'concepts'));
  await writeFile(
    join(root, 'concepts', 'queue.md'),
    '# Concept queue\n\n- [x] 2026-10-09 agent loop\n- [ ] tool calling\n',
  );
  const record = (date: string, costUsd: number) =>
    writeFile(
      join(root, 'runs', `${date}.json`),
      JSON.stringify({
        date,
        fetchedCount: 10,
        items: [{ title: 'Claude ships', link: 'l' }],
        calls: [{ role: 'decision', model: 'claude-haiku-4-5-20251001', costUsd }],
        delivery: { status: 'sent' },
      }),
    );
  await record('2026-10-03', 0.04);
  await record('2026-10-07', 0.02);
  await record('2026-10-10', 0.01);
  return root;
}

function context(root: string, responses: unknown[] = []): CommandContext & { urls: string[] } {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    urls.push(String(input));
    return Response.json(responses.shift());
  };
  return { root, timeZone: 'Asia/Jerusalem', now, fetchFn, urls };
}

const run = (text: string, ctx: CommandContext) => {
  const command = parseCommand(text);
  if (!command) throw new Error(`not a command: ${text}`);
  return runCommand(command, ctx);
};

describe('parseCommand', () => {
  it.each([
    ['/weather תל אביב', { name: 'weather', arg: 'תל אביב' }],
    ['/COST@morning_bot  3', { name: 'cost', arg: '3' }],
    ['  /help', { name: 'help', arg: '' }],
    ['/concept a\nb', { name: 'concept', arg: 'a b' }],
  ])('parses %j', (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it('treats text without a leading slash as not a command', () => {
    expect(parseCommand('מעניין, Claude Code hooks')).toBeNull();
  });
});

describe('inbox commands', () => {
  it('v6 criterion 3: "`/weather תל אביב` with a fixture geocoding response and a fixture forecast replies with the resolved name and the Hebrew weather line; an empty geocoding result replies with the not-found message."', async () => {
    const root = await makeRoot();
    const ctx = context(root, [
      fixture('geocoding-tel-aviv.json'),
      fixture('open-meteo-tel-aviv.json'),
    ]);
    expect(await run('/weather תל אביב', ctx)).toBe(
      '<b>תל אביב-יפו</b>: מעונן, 21°-29°, סיכוי לגשם 3%. יום נעים, אין צורך בהכנות מיוחדות.',
    );
    expect(ctx.urls[0]).toContain('name=%D7%AA%D7%9C+%D7%90%D7%91%D7%99%D7%91');
    expect(ctx.urls[1]).toContain('latitude=32.08088');
    expect(ctx.urls[1]).toContain('start_date=2026-10-10');

    const empty = context(root, [fixture('geocoding-empty.json')]);
    expect(await run('/weather <Atlantis>', empty)).toBe('לא מצאתי מקום בשם "&lt;Atlantis&gt;"');
    expect(empty.urls).toHaveLength(1);
  });

  it('v6 criterion 4: "`/cost` replies with the v5 totals for the last 7 days; `/cost 3` for 3 days."', async () => {
    const ctx = context(await makeRoot());
    const week = await run('/cost', ctx);
    expect(week).toContain('<b>עלות 7 הימים האחרונים</b>');
    expect(week).toContain('ימים שרצו: 2, נשלחו: 2');
    expect(week).toContain('פריטים: 20 נאספו, 2 בחלון, 0 הוחלטו');
    expect(week).toContain('עלות: $0.0300 (ממוצע $0.0150 ליום)');
    expect(week).toContain('לפי תפקיד: החלטות $0.0300, כתיבה $0.0000');
    expect(week).toContain('לפי מודל: claude-haiku-4-5-20251001: $0.0300');
    expect(week).toContain('שגיאות: 0');

    const three = await run('/cost 3', ctx);
    expect(three).toContain('<b>עלות 3 הימים האחרונים</b>');
    expect(three).toContain('ימים שרצו: 1, נשלחו: 1');
    expect(three).toContain('עלות: $0.0100');
  });

  it('/cost with a bad day count replies with the help text', async () => {
    const ctx = context(await makeRoot());
    expect(await run('/cost 0', ctx)).toBe(HELP_TEXT);
    expect(await run('/cost lots', ctx)).toBe(HELP_TEXT);
  });

  it('v6 criterion 5: "`/concept RAG` appends the concept once (a second call does not duplicate) and replies with its position."', async () => {
    const root = await makeRoot();
    const ctx = context(root);
    expect(await run('/concept RAG', ctx)).toBe('נוסף לתור: "RAG", מקום 2');
    expect(await run('/concept rag', ctx)).toBe('"RAG" כבר בתור, מקום 2');
    const queue = await readFile(join(root, 'concepts', 'queue.md'), 'utf8');
    expect(queue.match(/RAG/gi)).toHaveLength(1);
    expect(queue.endsWith('- [ ] tool calling\n- [ ] RAG\n')).toBe(true);
    expect(await run('/concept agent loop', ctx)).toBe('"agent loop" כבר נלמד ב-9.10');
  });

  it('v6 criterion 6: "Unknown command replies with the help text."', async () => {
    const ctx = context(await makeRoot());
    for (const text of ['/rm -rf /', '/help', '/weather', '/concept'])
      expect(await run(text, ctx)).toBe(HELP_TEXT);
    expect(HELP_TEXT).toContain('/weather');
    expect(HELP_TEXT).toContain('/cost');
    expect(HELP_TEXT).toContain('/concept');
    expect(HELP_TEXT).toContain('👍 או 👎 (או כן/לא)');
    expect(HELP_TEXT).toContain('npm run eval');
    expect(HELP_TEXT.split('\n').length).toBeLessThanOrEqual(8);
    expect(ctx.urls).toHaveLength(0);
  });
});
