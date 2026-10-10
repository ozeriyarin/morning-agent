import { describe, expect, it } from 'vitest';
import type { Item, WriterInput } from '../types.js';
import {
  escapeHtml,
  formatBrief,
  MAX_BRIEF_CHARS,
  QUEUE_EMPTY_CONCEPT,
  templateBrief,
  visibleLength,
} from './template.js';
import { validateBrief } from './writer.js';

const item = (n: number, title = `Item ${n}`): Item => ({
  id: `https://example.com/${n}`,
  title,
  link: `https://example.com/${n}?a=1&b=2`,
  published: '2026-10-10T01:00:00.000Z',
  summary: '',
  sources: ['Simon Willison'],
});

const input: WriterInput = {
  greeting: 'בוקר טוב, יום שבת 10.10',
  weather: {
    date: '2026-10-10',
    min: 19,
    max: 31,
    precipitationProbability: 3,
    code: 3,
    label: 'מעונן',
  },
  mustRead: [item(1, 'Claude <Code> & MCP')],
  mention: [item(2)],
  concept: 'agent loop',
  calendar: [
    {
      title: 'יום הולדת',
      start: '2026-10-10',
      end: '2026-10-11',
      allDay: true,
      time: null,
      source: 'google',
    },
    {
      title: 'ראיון <טכני>',
      start: '2026-10-10T14:00:00+03:00',
      end: '2026-10-10T15:00:00+03:00',
      allDay: false,
      location: 'Zoom',
      time: '14:00–15:00',
      source: 'icloud',
    },
  ],
};

describe('templateBrief + formatBrief', () => {
  it('produces a schema-valid brief', () => {
    expect(validateBrief(templateBrief(input)).ok).toBe(true);
    expect(validateBrief(templateBrief({ ...input, weather: null, concept: null })).ok).toBe(true);
  });

  it('renders all five sections in the fixed order with bold titles', () => {
    const html = formatBrief({ ...templateBrief(input), footer: 'נוצר ב-07:00' });
    const order = [
      '<b>בוקר טוב, יום שבת 10.10</b>',
      '<b>מזג אוויר במודיעין</b>',
      '<b>היום ביומן</b>',
      '<b>AI היום</b>',
      '<b>מושג היום</b>',
      'נוצר ב-07:00',
    ];
    const positions = order.map((s) => html.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain('מעונן, 19°-31°, סיכוי לגשם 3%.');
  });

  it('escapes <, > and & in text and links', () => {
    const html = formatBrief(templateBrief(input));
    expect(html).toContain('Claude &lt;Code&gt; &amp; MCP');
    expect(html).toContain('<a href="https://example.com/1?a=1&amp;b=2">');
    expect(html).not.toContain('<Code>');
    expect(escapeHtml('a<b>&"c"')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
  });

  it('renders all-day events, then timed events with location, escaped', () => {
    expect(formatBrief(templateBrief(input))).toContain(
      '<b>היום ביומן</b>\nכל היום: יום הולדת\n14:00–15:00 ראיון &lt;טכני&gt; (Zoom)',
    );
  });

  it('says the calendar was unavailable when it is null', () => {
    expect(formatBrief(templateBrief({ ...input, calendar: null }))).toContain(
      '<b>היום ביומן</b>\nהיומן לא היה זמין',
    );
  });

  it('v2 criterion 7: "`formatBrief` renders `שאלה למחשבה:` followed by `תשובה:` on the next line, both bold labels."', () => {
    expect(formatBrief(templateBrief(input))).toContain(
      '<b>שאלה למחשבה:</b> מתי לא היית משתמש/ת ב-agent loop, ולמה?\n<b>תשובה:</b> ראו את ההסבר למעלה.',
    );
  });

  it('says it was a quiet day when nothing was kept', () => {
    const html = formatBrief(templateBrief({ ...input, mustRead: [], mention: [] }));
    expect(html).toContain('יום שקט');
  });

  it('says the queue is empty when there is no concept', () => {
    expect(formatBrief(templateBrief({ ...input, concept: null }))).toContain(
      QUEUE_EMPTY_CONCEPT.name,
    );
  });

  it('replaces a missing section with a חסר line', () => {
    const html = formatBrief(templateBrief(input), ['weather']);
    expect(html).toContain('<b>מזג אוויר במודיעין</b>\nחסר: מזג אוויר במודיעין');
    expect(html).not.toContain('מעונן, 19');
  });

  it('trims mention items, then extra must-reads, never the calendar or the concept', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      item(i, `A fairly long article title number ${i}`),
    );
    const html = formatBrief(
      templateBrief({ ...input, mustRead: many.slice(0, 20), mention: many.slice(20) }),
    );
    expect(visibleLength(html)).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(html).toContain('A fairly long article title number 0');
    expect(html).toContain('14:00–15:00 ראיון');
    expect(html).toContain('<b>תשובה:</b>');
  });
});
