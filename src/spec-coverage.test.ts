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
});
