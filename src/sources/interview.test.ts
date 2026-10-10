import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readQueue } from './concepts.js';
import {
  FileInterviewStore,
  markProblem,
  markTip,
  nextProblem,
  nextTip,
  parseProblem,
} from './interview.js';

const problems = [
  '# Interview problems',
  '',
  '- [x] 2026-10-09 two-sum | Two Sum | easy | hash map | https://leetcode.com/problems/two-sum/',
  '- [ ] 3sum | 3Sum | medium | two pointers | https://leetcode.com/problems/3sum/',
  '- [ ] min-stack | Min Stack | medium | stack | https://leetcode.com/problems/min-stack/',
  '',
].join('\n');
const tips = ['# Tips', '', '- [x] 2026-10-09 טיפ א', '- [ ] טיפ ב', '- [ ] טיפ ג', ''].join('\n');

describe('interview queues', () => {
  it('picks the first unused problem and tip', () => {
    expect(nextProblem(problems)).toEqual({
      slug: '3sum',
      title: '3Sum',
      difficulty: 'medium',
      pattern: 'two pointers',
      url: 'https://leetcode.com/problems/3sum/',
    });
    expect(nextTip(tips)).toEqual({ index: 1, text: 'טיפ ב' });
  });

  it('marks only the chosen problem by slug', () => {
    const next = markProblem(problems, '3sum', '2026-10-10');
    expect(next).toContain('- [x] 2026-10-10 3sum | 3Sum |');
    expect(next).toContain('- [ ] min-stack |');
    expect(nextProblem(next)?.slug).toBe('min-stack');
  });

  it('returns null when every problem is used and rejects a malformed line', () => {
    expect(nextProblem(markProblem(markProblem(problems, '3sum', 'd'), 'min-stack', 'd'))).toBe(
      null,
    );
    expect(() => parseProblem('two-sum | Two Sum')).toThrow('invalid problem line');
  });

  it('restarts an exhausted tip queue from the first tip, keeping the line endings', () => {
    const used = '- [x] 2026-10-01 טיפ א\r\n- [x] 2026-10-02 טיפ ב\r\n';
    expect(nextTip(used)).toEqual({ index: 0, text: 'טיפ א' });
    expect(markTip(used, 'טיפ א', '2026-10-10')).toBe('- [x] 2026-10-10 טיפ א\r\n- [ ] טיפ ב\r\n');
    expect(nextTip('# empty\n')).toBeNull();
  });

  it('the committed problem queue holds 30 easy or medium LeetCode problems', async () => {
    const lines = readQueue(await readFile('interview/problems.md', 'utf8'));
    expect(lines).toHaveLength(30);
    const parsed = lines.map((line) => parseProblem(line.name));
    for (const p of parsed) {
      expect(p.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(p.url).toBe(`https://leetcode.com/problems/${p.slug}/`);
      expect(['easy', 'medium']).toContain(p.difficulty);
    }
    expect(new Set(parsed.map((p) => p.slug)).size).toBe(30);
    expect(new Set(parsed.map((p) => p.pattern)).size).toBe(12);
  });

  it('every 7-day window of the committed problem queue mixes 7 different patterns', async () => {
    const patterns = readQueue(await readFile('interview/problems.md', 'utf8')).map(
      (line) => parseProblem(line.name).pattern,
    );
    for (let i = 0; i + 7 <= patterns.length; i++) {
      expect(new Set(patterns.slice(i, i + 7)).size).toBe(7);
    }
  });

  it('the committed tip queue holds 30 unused one-line Hebrew tips', async () => {
    const entries = readQueue(await readFile('interview/tips.md', 'utf8'));
    expect(entries).toHaveLength(30);
    for (const tip of entries) {
      expect(tip.usedOn).toBeNull();
      expect(tip.name).toMatch(/[א-ת]/);
    }
  });

  it('FileInterviewStore reads both queues and marks both with the date', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'interview-'));
    const store = new FileInterviewStore(join(dir, 'problems.md'), join(dir, 'tips.md'));
    await writeFile(join(dir, 'problems.md'), problems);
    await writeFile(join(dir, 'tips.md'), tips);
    const pick = await store.next();
    await store.markUsed(pick, '2026-10-10');
    expect(await readFile(join(dir, 'problems.md'), 'utf8')).toContain('- [x] 2026-10-10 3sum');
    expect(await readFile(join(dir, 'tips.md'), 'utf8')).toContain('- [x] 2026-10-10 טיפ ב');
    expect(await store.next()).toMatchObject({ problem: { slug: 'min-stack' }, tip: { index: 2 } });
  });
});
