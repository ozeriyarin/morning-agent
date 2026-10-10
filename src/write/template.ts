import type {
  Brief,
  CalendarEvent,
  Item,
  Section,
  WeatherDay,
  Writer,
  WriterInput,
  WriterResult,
} from '../types.js';

const TITLES: Record<Section, string> = {
  weather: 'מזג אוויר במודיעין',
  calendar: 'היום ביומן',
  news: 'AI היום',
  concept: 'מושג היום',
};

export const MAX_BRIEF_CHARS = 1500;

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

function weatherAdvice(day: WeatherDay): string {
  if (day.precipitationProbability >= 50) return 'כדאי לקחת מטרייה.';
  if (day.min <= 12) return 'קריר בבוקר, כדאי לקחת ז׳קט.';
  if (day.max >= 30) return 'חם היום, לשתות הרבה מים.';
  return 'יום נעים, אין צורך בהכנות מיוחדות.';
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
          summary: `${w.label}, ${w.min}°-${w.max}°, סיכוי לגשם ${w.precipitationProbability}%.`,
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
    footer: '',
    calendar: input.calendar,
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
    escapeHtml(brief.footer),
  ].join('\n');
}

export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot);/g, '_').length;
}

// Telegram HTML; drops mentions, then extra must-reads (never calendar or concept), until it fits.
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
