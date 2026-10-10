import { readFile, writeFile } from 'node:fs/promises';
import type { InterviewPick, InterviewProblem } from '../types.js';
import { markUsed, readQueue } from './concepts.js';

// Queue line body: `<slug> | <title> | <difficulty> | <pattern> | <url>`.
export function parseProblem(line: string): InterviewProblem {
  const [slug, title, difficulty, pattern, url, ...rest] = line.split(' | ').map((s) => s.trim());
  if (!slug || !title || !difficulty || !pattern || !url || rest.length) {
    throw new Error(`invalid problem line: "${line}"`);
  }
  return { slug, title, difficulty, pattern, url };
}

export function nextProblem(markdown: string): InterviewProblem | null {
  const line = readQueue(markdown).find((entry) => entry.usedOn === null)?.name;
  return line === undefined ? null : parseProblem(line);
}

export function markProblem(markdown: string, slug: string, date: string): string {
  const entry = readQueue(markdown).find(
    (e) => e.usedOn === null && e.name.startsWith(`${slug} |`),
  );
  return entry ? markUsed(markdown, entry.name, date) : markdown;
}

// First unused tip; when every tip is used the queue cycles back to the first one.
export function nextTip(markdown: string): { index: number; text: string } | null {
  const tips = readQueue(markdown);
  const index = Math.max(
    tips.findIndex((tip) => tip.usedOn === null),
    0,
  );
  const tip = tips[index];
  return tip ? { index, text: tip.name } : null;
}

// Restarts an exhausted queue (every line back to `- [ ]`) before marking the tip.
export function markTip(markdown: string, text: string, date: string): string {
  const exhausted = readQueue(markdown).every((tip) => tip.usedOn !== null);
  const queue = exhausted
    ? markdown.replace(/^(\s*)- \[x\] \d{4}-\d{2}-\d{2} /gm, '$1- [ ] ')
    : markdown;
  return markUsed(queue, text, date);
}

export interface InterviewStore {
  next(): Promise<InterviewPick>;
  markUsed(pick: InterviewPick, date: string): Promise<void>;
}

export class FileInterviewStore implements InterviewStore {
  constructor(
    private readonly problemsPath: string,
    private readonly tipsPath: string,
  ) {}

  async next(): Promise<InterviewPick> {
    const [problems, tips] = await Promise.all([
      readFile(this.problemsPath, 'utf8'),
      readFile(this.tipsPath, 'utf8'),
    ]);
    return { problem: nextProblem(problems), tip: nextTip(tips) };
  }

  async markUsed(pick: InterviewPick, date: string): Promise<void> {
    if (pick.problem) {
      const problems = await readFile(this.problemsPath, 'utf8');
      await writeFile(this.problemsPath, markProblem(problems, pick.problem.slug, date));
    }
    if (pick.tip) {
      const tips = await readFile(this.tipsPath, 'utf8');
      await writeFile(this.tipsPath, markTip(tips, pick.tip.text, date));
    }
  }
}
