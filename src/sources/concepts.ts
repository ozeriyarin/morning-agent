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

export interface QueueAddition {
  markdown: string;
  added: boolean;
  entry: QueueEntry;
  position: number | null;
}

// Case-insensitive presence check; `position` counts unused entries only, null once used.
export function addConcept(markdown: string, name: string): QueueAddition {
  const key = name.toLowerCase();
  const found = readQueue(markdown).find((e) => e.name.toLowerCase() === key);
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const body = markdown === '' || markdown.endsWith('\n') ? markdown : markdown + eol;
  const next = found ? markdown : `${body}- [ ] ${name}${eol}`;
  const entry = found ?? { name, usedOn: null };
  const pending = readQueue(next).filter((e) => e.usedOn === null);
  const position =
    entry.usedOn === null ? pending.findIndex((e) => e.name.toLowerCase() === key) + 1 : null;
  return { markdown: next, added: !found, entry, position };
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

  // Writes only when the concept was missing, so a repeated /concept leaves the file untouched.
  async add(name: string): Promise<QueueAddition> {
    const result = addConcept(await readFile(this.path, 'utf8'), name);
    if (result.added) await writeFile(this.path, result.markdown);
    return result;
  }
}
