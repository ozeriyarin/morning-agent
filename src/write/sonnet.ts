import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { callUsage, type MessagesClient } from '../cost.js';
import { dayMonth } from '../dates.js';
import { HAIKU_MODEL } from '../decide/haiku.js';
import type {
  CalendarEvent,
  InterviewProblem,
  NewsItem,
  Writer,
  WriterInput,
  WriterName,
  WriterResult,
} from '../types.js';
import { BriefSchema, WriterError } from './writer.js';

export const SONNET_MODEL = 'claude-sonnet-5-5';

const BRIEF_FORMAT = { type: 'json_schema' as const, schema: zodOutputFormat(BriefSchema).schema };

export const WRITER_SYSTEM = `You write Yarin's morning brief: one short Hebrew Telegram message read on a phone at 07:00 in Modi'in.
Yarin is a full-stack / AI developer preparing for AI-engineering interviews.

Output: JSON matching the schema. Write every field in Hebrew except product names and article titles, which stay as published.
- greeting: "בוקר טוב, יום <weekday> <D.M>" exactly as given in the input.
- weather.summary: one line with the condition, min-max temperature and rain chance from the data.
- weather.advice: one practical line (jacket, umbrella, water). If weather is null, summary says the data is missing.
- news.mustRead: every must_read item, in the given order: title as published, why = one Hebrew sentence on why it matters to an AI developer, url copied exactly from the input.
- news.mustRead seen_before: when an item has seen_before, its why starts with המשך ל"<seen_before.title>" מה-<seen_before.date>: and then the sentence.
- news.mention: every mention item as { title, url } with the url copied exactly; mention items ignore seen_before.
- news.quietDay: true only when both lists are empty.
- concept: name = concept.name as given; explanation in 3-5 short lines separated by newlines, concrete and interview-ready; when concept.related is non-empty, connect the explanation to one related concept in one clause; question = one interview-style question to think about; answer = 2-4 short lines that answer that question concretely, in Hebrew. If concept is null, write a one-line note that the queue is empty and still fill question and answer.
- interview: problem is today's practice problem { title, difficulty, pattern, url } (null when the queue is empty) and tip is shown by the program as is. approach = 1-3 short lines: the pattern, the key idea and the steps; complexity = one line with time and space in big-O; trap = one line with the common mistake or edge case. Hebrew, no code blocks and never a full solution. If problem is null, write one short line in each field suggesting a pattern to review.
- calendar (input only): today's events, all-day ones first, or null when the calendar was unavailable. The program renders the "היום ביומן" section itself, so never list events in any field; weather.advice may mention an event when the weather matters for it.
- footer: empty string; the program fills it.

Rules: never invent links or items; no emojis; dates as D.M, times as HH:MM; keep the whole brief under 1,800 characters, so the why lines stay short.`;

const toNews = (item: NewsItem) => ({
  title: item.title,
  url: item.link,
  summary: item.summary,
  ...(item.seenBefore && {
    seen_before: { title: item.seenBefore.title, date: dayMonth(item.seenBefore.date) },
  }),
});
const toEvent = (e: CalendarEvent) => ({ title: e.title, time: e.time ?? 'כל היום' });
const toProblem = (p: InterviewProblem | null) =>
  p && { title: p.title, difficulty: p.difficulty, pattern: p.pattern, url: p.url };

export class SonnetWriter implements Writer {
  readonly name: WriterName;
  readonly model: string;

  constructor(
    private readonly client: MessagesClient,
    options: { model?: string } = {},
  ) {
    this.model = options.model ?? SONNET_MODEL;
    this.name = this.model === HAIKU_MODEL ? 'haiku' : 'sonnet';
  }

  async write(input: WriterInput): Promise<WriterResult> {
    const started = performance.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      system: [{ type: 'text', text: WRITER_SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: BRIEF_FORMAT },
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            greeting: input.greeting,
            weather: input.weather,
            must_read: input.mustRead.map(toNews),
            mention: input.mention.map(toNews),
            concept: input.concept,
            calendar: input.calendar?.map(toEvent) ?? null,
            interview: {
              problem: toProblem(input.interview.problem),
              tip: input.interview.tip?.text ?? null,
            },
          }),
        },
      ],
    });
    const call = callUsage('writer', this.model, response.usage, performance.now() - started);
    if (response.stop_reason !== 'end_turn') {
      throw new WriterError(
        `writer stopped with ${response.stop_reason ?? 'no stop reason'}`,
        call,
      );
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    try {
      return { brief: JSON.parse(textBlock?.text ?? ''), call };
    } catch {
      return { brief: null, call };
    }
  }
}
