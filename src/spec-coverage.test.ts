import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function criteria(spec: string) {
  const text = readFileSync(`agent-os/specs/${spec}/spec.md`, 'utf8');
  const section = text.split('## Acceptance criteria')[1]?.split('\n## ')[0] ?? '';
  return [...section.matchAll(/^(\d+)\. (.+?)\r?$/gm)].map((m) => ({ n: m[1], text: m[2] }));
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => String(i + 1));

const testSources = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => readFileSync(join('src', file), 'utf8').replace(/\\/g, ''))
  .join('\n');

describe('spec coverage', () => {
  it.each([
    ['2026-10-10-brief-v1', '', 10],
    ['2026-10-10-brief-v2-calendar', 'v2 ', 9],
    ['2026-10-10-brief-v3-icloud', 'v3 ', 9],
    ['2026-10-10-brief-v4-jev', 'v4 ', 9],
    ['2026-10-10-brief-v5-cost-view', 'v5 ', 9],
    ['2026-10-10-brief-v6-inbox', 'v6 ', 10],
    ['2026-10-10-brief-v7-interview', 'v7 ', 7],
    ['2026-10-11-brief-v8-reminders', 'v8 ', 7],
    ['2026-10-11-brief-v9-reminders-mail', 'v9 ', 7],
    ['2026-10-11-brief-v10-resilience', 'v10 ', 8],
    ['2026-10-11-brief-v11-record-privacy', 'v11 ', 5],
    ['2026-10-11-brief-v12-eval-set', 'v12 ', 6],
    ['2026-10-13-brief-v13-memory', 'v13 ', 8],
    ['2026-10-19-brief-v14-news-substance', 'v14 ', 6],
    ['2026-10-20-brief-v15-json-sources', 'v15 ', 5],
  ])('%s: every acceptance criterion has a test whose name quotes it', (spec, prefix, count) => {
    const list = criteria(spec);
    expect(list.map((c) => c.n)).toEqual(numbered(count));
    for (const { n, text } of list) {
      expect(testSources, `${spec} criterion ${n} has no quoting test`).toContain(
        `${prefix}criterion ${n}: "${text}"`,
      );
    }
  });

  it('criterion 10: "`npm test` passes; every criterion above has a test whose name quotes it."', () => {
    expect(criteria('2026-10-10-brief-v1')).toHaveLength(10);
  });

  it('v2 criterion 9: "`npm test` passes; every criterion above has a test whose name quotes it."', () => {
    expect(criteria('2026-10-10-brief-v2-calendar')).toHaveLength(9);
  });

  it('v3 criterion 9: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-10-brief-v3-icloud')).toHaveLength(9);
  });

  it('v4 criterion 9: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-10-brief-v4-jev')).toHaveLength(9);
  });

  it('v5 criterion 9: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-10-brief-v5-cost-view')).toHaveLength(9);
  });

  it('v6 criterion 10: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-10-brief-v6-inbox')).toHaveLength(10);
  });

  it('v7 criterion 7: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-10-brief-v7-interview')).toHaveLength(7);
  });

  it('v8 criterion 7: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-11-brief-v8-reminders')).toHaveLength(7);
  });

  it('v9 criterion 7: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-11-brief-v9-reminders-mail')).toHaveLength(7);
  });

  it('v10 criterion 8: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-11-brief-v10-resilience')).toHaveLength(8);
  });

  it('v11 criterion 5: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-11-brief-v11-record-privacy')).toHaveLength(5);
  });

  it('v12 criterion 6: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-11-brief-v12-eval-set')).toHaveLength(6);
  });

  it('v13 criterion 8: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-13-brief-v13-memory')).toHaveLength(8);
  });

  it('v14 criterion 6: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-19-brief-v14-news-substance')).toHaveLength(6);
  });

  it('v15 criterion 5: "`npm test` passes; every criterion has a test whose name quotes it."', () => {
    expect(criteria('2026-10-20-brief-v15-json-sources')).toHaveLength(5);
  });
});
