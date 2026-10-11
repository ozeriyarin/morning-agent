import { weatherAdvice, weatherSummary } from '../sources/weather.js';
import type {
  Brief,
  CalendarEvent,
  Item,
  Reminder,
  Section,
  WeeklySummary,
  Writer,
  WriterInput,
  WriterResult,
} from '../types.js';

export const TITLES: Record<Section, string> = {
  weather: 'מזג אוויר במודיעין',
  calendar: 'היום ביומן',
  news: 'AI היום',
  concept: 'מושג היום',
  interview: 'שאלת ראיון',
};

export const MAX_BRIEF_CHARS = 1800;
const SEE_LINK = 'ראו את הקישור';

export const QUEUE_EMPTY_CONCEPT: Brief['concept'] = {
  name: 'תור המושגים ריק',
  explanation: 'כל המושגים בתור נלמדו. הוסיפו מושגים חדשים ל-concepts/queue.md.',
  question: 'איזה מושג הכי חסר לך לקראת הראיון הבא?',
  answer: 'בחרו את המושג שהכי קשה לכם להסביר בקול, והוסיפו אותו ראשון לתור.',
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const link = (url: string, title: string) =>
  `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`;

// Deterministic brief from raw data: used by --dry-run and as the fallback when the writer fails.
export function templateBrief(input: WriterInput): Brief {
  const w = input.weather;
  const toLink = (item: Item) => ({ title: item.title, url: item.link });
  return {
    greeting: input.greeting,
    weather: w
      ? {
          summary: weatherSummary(w),
          advice: weatherAdvice(w),
        }
      : { summary: 'אין נתוני מזג אוויר.', advice: 'כדאי לבדוק תחזית לפני היציאה.' },
    news: {
      mustRead: input.mustRead.map((item) => ({
        ...toLink(item),
        why: `(${item.sources.join(', ')})`,
      })),
      mention: input.mention.map(toLink),
      quietDay: input.mustRead.length + input.mention.length === 0,
    },
    concept: input.concept
      ? {
          name: input.concept,
          explanation: `במצב תבנית אין הסבר כתוב. נסו להסביר לעצמכם את "${input.concept}" בשלוש שורות: מה זה, למה צריך, ומה המחיר.`,
          question: `מתי לא היית משתמש/ת ב-${input.concept}, ולמה?`,
          answer: 'ראו את ההסבר למעלה.',
        }
      : QUEUE_EMPTY_CONCEPT,
    interview: { approach: SEE_LINK, complexity: SEE_LINK, trap: SEE_LINK },
    footer: '',
    calendar: input.calendar,
    interviewPick: input.interview,
    interviewExplained: false,
  };
}

export class TemplateWriter implements Writer {
  readonly mode = 'template';

  async write(input: WriterInput): Promise<WriterResult> {
    return { brief: templateBrief(input) };
  }
}

function newsLines(news: Brief['news']): string[] {
  if (news.quietDay || news.mustRead.length + news.mention.length === 0) {
    return ['יום שקט: אין היום חדשות AI שדורשות תשומת לב.'];
  }
  const lines = news.mustRead.map((n) => `• ${link(n.url, n.title)} - ${escapeHtml(n.why)}`);
  if (news.mention.length)
    lines.push(`עוד: ${news.mention.map((n) => link(n.url, n.title)).join(' · ')}`);
  return lines;
}

function calendarLines(events: CalendarEvent[] | null): string[] {
  if (events === null) return ['היומן לא היה זמין'];
  if (events.length === 0) return ['אין אירועים היום'];
  return events.map((e) => {
    if (e.time === null) return `כל היום: ${escapeHtml(e.title)}`;
    const where = e.location ? ` (${escapeHtml(e.location)})` : '';
    return `${e.time} ${escapeHtml(e.title)}${where}`;
  });
}

function reminderLines(reminders: Reminder[] = []): string[] {
  if (reminders.length === 0) return [];
  return ['תזכורות:', ...reminders.map((r) => `${r.time ?? 'כל היום:'} ${escapeHtml(r.title)}`)];
}

// Only an AI-written explanation is shown; the template and the fallback point to the link.
function interviewLines(brief: Brief): string[] {
  const { problem, tip } = brief.interviewPick;
  const { approach, complexity, trap } = brief.interview;
  const explanation = brief.interviewExplained
    ? [
        `<b>גישה:</b> ${escapeHtml(approach)}`,
        `<b>סיבוכיות:</b> ${escapeHtml(complexity)}`,
        `<b>מלכודת:</b> ${escapeHtml(trap)}`,
      ]
    : [`הסבר: ${SEE_LINK}`];
  const lines = problem
    ? [
        `${link(problem.url, problem.title)} · ${escapeHtml(problem.difficulty)} · ${escapeHtml(problem.pattern)}`,
        ...explanation,
      ]
    : ['תור השאלות ריק'];
  return tip ? [...lines, `<b>טיפ:</b> ${escapeHtml(tip.text)}`] : lines;
}

function weeklyLine(w: WeeklySummary): string {
  return `השבוע: ${w.days} ימים, עלות ~$${w.costUsd.toFixed(3)}, ${w.items} פריטים נבדקו, ${w.errors} שגיאות`;
}

function render(brief: Brief, missing: Section[]): string {
  const section = (key: Section, body: string[]) => [
    `<b>${TITLES[key]}</b>`,
    ...(missing.includes(key) ? [`חסר: ${TITLES[key]}`] : body),
  ];
  const c = brief.concept;
  return [
    `<b>${escapeHtml(brief.greeting)}</b>`,
    '',
    ...section('weather', [escapeHtml(brief.weather.summary), escapeHtml(brief.weather.advice)]),
    '',
    `<b>${TITLES.calendar}</b>`,
    ...calendarLines(brief.calendar),
    ...reminderLines(brief.reminders),
    ...(brief.icloudUnavailable ? ['(iCloud לא היה זמין)'] : []),
    '',
    ...section('news', newsLines(brief.news)),
    '',
    ...section('concept', [
      `<i>${escapeHtml(c.name)}</i>`,
      escapeHtml(c.explanation),
      `<b>שאלה למחשבה:</b> ${escapeHtml(c.question)}`,
      `<b>תשובה:</b> ${escapeHtml(c.answer)}`,
    ]),
    '',
    ...section('interview', interviewLines(brief)),
    '',
    escapeHtml(brief.footer),
    ...(brief.weekly ? [weeklyLine(brief.weekly)] : []),
  ].join('\n');
}

export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot);/g, '_').length;
}

// Telegram HTML; drops mentions, then extra must-reads, never calendar/concept/interview, to fit.
export function formatBrief(brief: Brief, missing: Section[] = []): string {
  const news = {
    ...brief.news,
    mustRead: [...brief.news.mustRead],
    mention: [...brief.news.mention],
  };
  let html = render({ ...brief, news }, missing);
  while (
    visibleLength(html) > MAX_BRIEF_CHARS &&
    (news.mention.length || news.mustRead.length > 1)
  ) {
    if (news.mention.length) news.mention.pop();
    else news.mustRead.pop();
    html = render({ ...brief, news }, missing);
  }
  return html;
}
