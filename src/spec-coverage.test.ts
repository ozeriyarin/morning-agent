import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const spec = readFileSync('agent-os/specs/2026-10-10-brief-v1/spec.md', 'utf8');
const section = spec.split('## Acceptance criteria')[1]?.split('\n## ')[0] ?? '';
const criteria = [...section.matchAll(/^(\d+)\. (.+?)\r?$/gm)].map((m) => ({
  n: m[1],
  text: m[2],
}));

const testSources = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => readFileSync(join('src', file), 'utf8').replace(/\\/g, ''))
  .join('\n');

describe('spec coverage', () => {
  it('criterion 10: "`npm test` passes; every criterion above has a test whose name quotes it."', () => {
    expect(criteria.map((c) => c.n)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    for (const { n, text } of criteria) {
      expect(testSources, `criterion ${n} has no quoting test`).toContain(
        `criterion ${n}: "${text}"`,
      );
    }
  });
});
