export const DECISIONS = ['must_read', 'mention', 'skip'] as const;
export type Decision = (typeof DECISIONS)[number];

export const SECTIONS = ['weather', 'calendar', 'news', 'concept'] as const;
export type Section = (typeof SECTIONS)[number];

export interface Item {
  id: string;
  title: string;
  link: string;
  published: string;
  summary: string;
  sources: string[];
}

export interface WeatherDay {
  date: string;
  min: number;
  max: number;
  precipitationProbability: number;
  code: number;
  label: string;
}

export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  time: string | null;
  source: 'google' | 'icloud';
}

export interface FetchContext {
  date: string;
  reference: Date;
}

export interface Source<T> {
  readonly name: string;
  fetch(ctx: FetchContext): Promise<T>;
}

export interface CallRecord {
  role: 'decision' | 'writer';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  costUsd: number;
}

export type CallUsage = Omit<CallRecord, 'costUsd'>;

export interface DecisionResult {
  decision: Decision;
  error?: string;
  call?: CallUsage;
}

export interface DecisionModel {
  readonly model: string;
  decide(item: Item): Promise<DecisionResult>;
}

export interface WrittenBrief {
  greeting: string;
  weather: { summary: string; advice: string };
  news: {
    mustRead: { title: string; why: string; url: string }[];
    mention: { title: string; url: string }[];
    quietDay: boolean;
  };
  concept: { name: string; explanation: string; question: string; answer: string };
  footer: string;
}

export interface Brief extends WrittenBrief {
  calendar: CalendarEvent[] | null;
  icloudUnavailable?: boolean;
}

export interface WriterInput {
  greeting: string;
  weather: WeatherDay | null;
  mustRead: Item[];
  mention: Item[];
  concept: string | null;
  calendar: CalendarEvent[] | null;
}

export interface WriterResult {
  brief: unknown;
  call?: CallUsage;
}

export interface Writer {
  readonly mode: 'ai' | 'template';
  write(input: WriterInput): Promise<WriterResult>;
}

export interface SendResult {
  status: 'sent' | 'printed';
}

export interface Sender {
  readonly name: string;
  send(html: string): Promise<SendResult>;
}

export interface RunError {
  stage: 'source' | 'decision' | 'writer' | 'delivery' | 'concepts';
  source?: string;
  reason?: SourceFailure;
  message: string;
}

export interface RunRecord {
  date: string;
  generatedAt: string;
  dryRun: boolean;
  fetchedCount: number;
  items: Pick<Item, 'title' | 'link' | 'published' | 'sources'>[];
  calendar: Pick<CalendarEvent, 'title' | 'start' | 'end' | 'allDay' | 'source'>[] | null;
  icloud: 'ok' | 'disabled' | 'failed';
  skippedUnseen: number;
  decisions: { title: string; link: string; decision: Decision; error?: string }[];
  calls: CallRecord[];
  totalCostUsd: number;
  writer: 'ai' | 'template' | 'fallback';
  missingSections: Section[];
  concept: { name: string | null; queueEmpty: boolean; marked: boolean };
  delivery: { sender: string; status: 'sent' | 'printed' | 'failed' };
  briefChars: number;
  errors: RunError[];
}

export type SourceFailure = 'missing' | 'invalid' | 'icloud';

export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly reason?: SourceFailure,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}
