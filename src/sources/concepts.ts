import { readFile, writeFile } from 'node:fs/promises';

export interface QueueEntry {
  name: string;
  usedOn: string | null;
}

const LINE = /^- \[( |x)\] (?:(\d{4}-\d{2}-\d{2}) )?(.+)$/;

export function readQueue(markdown: string): QueueEntry[] {
  return markdown.split(/\r?\n/).flatMap((line) => {
    const m = LINE.exec(line.trim());
    if (!m?.[3]) return [];
    return [{ name: m[3].trim(), usedOn: m[1] === 'x' ? (m[2] ?? '') : null }];
  });
}

export function nextConcept(markdown: string): string | null {
  return readQueue(markdown).find((entry) => entry.usedOn === null)?.name ?? null;
}

export function markUsed(markdown: string, name: string, date: string): string {
  let done = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (done || line.trim().replace(/\r$/, '') !== `- [ ] ${name}`) return line;
      done = true;
      return line.replace(`- [ ] ${name}`, `- [x] ${date} ${name}`);
    })
    .join('\n');
}

export interface ConceptStore {
  next(): Promise<string | null>;
  markUsed(name: string, date: string): Promise<void>;
}

export class FileConceptStore implements ConceptStore {
  constructor(private readonly path: string) {}

  async next(): Promise<string | null> {
    return nextConcept(await readFile(this.path, 'utf8'));
  }

  async markUsed(name: string, date: string): Promise<void> {
    await writeFile(this.path, markUsed(await readFile(this.path, 'utf8'), name, date));
  }
}
