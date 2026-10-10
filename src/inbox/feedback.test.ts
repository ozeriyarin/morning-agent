import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendFeedback,
  feedbackLabel,
  loadFeedbackLabels,
  matchTitle,
  toFeedbackEntry,
} from './feedback.js';

const titles = [
  'Anthropic ships Claude Code hooks',
  'Ten tips for a tidy desk',
  'Claude Code hooks: a deep dive',
];

describe('feedback', () => {
  it.each([
    ['👎 desk', 'drop'],
    ['👍🏽 desk', 'keep'],
    ['לא מעניין', 'drop'],
    ['מעניין!', 'keep'],
    ['כן, Claude', 'keep'],
    ['לא', 'drop'],
    ['ספר לי עוד', null],
    ['לאט', null],
  ])('labels %j as %s', (text, label) => {
    expect(feedbackLabel(text)).toBe(label);
  });

  it.each([
    ['👎 tidy desk', 'Ten tips for a tidy desk'],
    ['לא מעניין: "TEN TIPS"', 'Ten tips for a tidy desk'],
    ['כן deep dive please', 'Claude Code hooks: a deep dive'],
    ['כן Claude Code hooks', null],
    ['👍 sea', null],
    ['👍', null],
  ])('matches %j to %j', (text, title) => {
    expect(matchTitle(text, titles)).toBe(title);
  });

  it('keeps unmatched text as free text', () => {
    const base = { at: '2026-10-10T05:00:00.000Z', text: 'תודה על הבריף' };
    expect(toFeedbackEntry(base, titles)).toEqual(base);
    expect(toFeedbackEntry({ ...base, text: '👎 desk' }, titles)).toEqual({
      ...base,
      text: '👎 desk',
      title: 'Ten tips for a tidy desk',
      label: 'drop',
    });
  });

  it('appends to the day file and loads labels by normalised title, the later one winning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feedback-'));
    const at = '2026-10-10T05:00:00.000Z';
    await appendFeedback(dir, '2026-10-10', [], []);
    await expect(readFile(join(dir, '2026-10-10.json'), 'utf8')).rejects.toThrow();
    await appendFeedback(dir, '2026-10-10', [{ at, text: 'a', title: 'Desk!', label: 'drop' }], []);
    await appendFeedback(dir, '2026-10-10', [{ at, text: 'free' }], []);
    await appendFeedback(dir, '2026-10-11', [{ at, text: 'b', title: 'desk', label: 'keep' }], []);
    expect(JSON.parse(await readFile(join(dir, '2026-10-10.json'), 'utf8'))).toHaveLength(2);
    expect(await loadFeedbackLabels(dir, '2026-10-09', '2026-10-10')).toEqual(
      new Map([['desk', 'drop']]),
    );
    expect(await loadFeedbackLabels(dir, '2026-10-10', '2026-10-11')).toEqual(
      new Map([['desk', 'keep']]),
    );
  });
});
