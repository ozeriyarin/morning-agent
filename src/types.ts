export const DECISIONS = ['must_read', 'mention', 'skip'] as const;
export type Decision = (typeof DECISIONS)[number];

export const SECTIONS = ['weather', 'calendar', 'news', 'concept'] as const;
// `interview` is missing only when its queues fail; a bad writer explanation falls back instead.
export type Section = (typeof SECTIONS)[number] | 'interview';

export const FEED_KINDS = ['news', 'release'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export const FEED_FORMATS = ['rss', 'hn-algolia', 'github-releases'] as const;

export interface Item {
  id: string;
  title: string;
  link: string;
  published: string;
  summary: string;
  sources: string[];
  kind?: FeedKind;
  windowHours?: number;
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

export interface Reminder {
  title: string;
  due: string;
  allDay: boolean;
  time: string | null;
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
  role: 'decision' | 'writer' | 'embed';
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  costUsd: number;
  provider?: 'openrouter';
}

// A provider that reports its own cost sets costUsd; otherwise it is priced from config/prices.json.
export type CallUsage = Omit<CallRecord, 'costUsd'> & { costUsd?: number };

export interface InterviewProblem {
  slug: string;
  title: string;
  difficulty: string;
  pattern: string;
  url: string;
}

export interface InterviewPick {
  problem: InterviewProblem | null;
  tip: { index: number; text: string } | null;
}

export interface DecisionResult {
  decision: Decision;
  reason?: 'release';
  error?: string;
  call?: CallUsage;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface DecisionExample {
  title: string;
  label: Decision;
  score: number;
}

export interface DecisionModel {
  readonly model: string;
  decide(item: Item, examples?: DecisionExample[]): Promise<DecisionResult>;
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
  interview: { approach: string; complexity: string; trap: string };
  footer: string;
}

export interface WeeklySummary {
  days: number;
  costUsd: number;
  items: number;
  errors: number;
}

export interface Brief extends WrittenBrief {
  calendar: CalendarEvent[] | null;
  icloudUnavailable?: boolean;
  reminders?: Reminder[];
  weekly?: WeeklySummary;
  interviewPick: InterviewPick;
  interviewExplained: boolean;
}

export interface NewsItem extends Item {
  seenBefore?: { title: string; date: string };
}

export interface WriterInput {
  greeting: string;
  weather: WeatherDay | null;
  mustRead: NewsItem[];
  mention: NewsItem[];
  concept: { name: string; related: string[] } | null;
  calendar: CalendarEvent[] | null;
  interview: InterviewPick;
}

export interface WriterResult {
  brief: unknown;
  call?: CallUsage;
}

export type WriterName = 'sonnet' | 'haiku' | 'template';

export interface Writer {
  readonly name: WriterName;
  readonly model?: string;
  write(input: WriterInput): Promise<WriterResult>;
}

export interface SendResult {
  status: 'sent' | 'printed';
  attempts: number;
}

export interface Sender {
  readonly name: string;
  send(html: string): Promise<SendResult>;
}

export interface RunError {
  stage: 'source' | 'decision' | 'writer' | 'delivery' | 'concepts' | 'interview';
  source?: string;
  reason?: SourceFailure;
  message: string;
}

export interface RunRecord {
  date: string;
  generatedAt: string;
  dryRun: boolean;
  fetchedCount: number;
  items: Pick<Item, 'title' | 'link' | 'published' | 'summary' | 'sources'>[];
  calendar: {
    count: number;
    allDay: number;
    timed: number;
    bySource: Record<CalendarEvent['source'], number>;
  } | null;
  icloud: 'ok' | 'disabled' | 'failed';
  reminders: { count: number; source: 'file' | 'icloud' | 'none' };
  skippedUnseen: number;
  decisions: {
    title: string;
    link: string;
    decision: Decision;
    reason?: 'release';
    model?: string;
    confidence?: number;
    probabilities?: Record<string, number>;
    error?: string;
    examples: number;
  }[];
  calls: CallRecord[];
  totalCostUsd: number;
  writer: WriterName;
  writerAttempts: number;
  missingSections: Section[];
  concept: { name: string | null; queueEmpty: boolean; marked: boolean };
  interview: { slug: string | null; tipIndex: number | null; marked: boolean };
  memory: {
    indexSize: number;
    seenBefore: number;
    examples: number;
    related: number;
    chunkIds: string[];
  } | null;
  delivery: { sender: string; status: 'sent' | 'printed' | 'failed'; attempts: number };
  briefChars: number;
  errors: RunError[];
  warnings?: string[];
}

export type SourceFailure =
  'missing' | 'invalid' | 'icloud' | 'icloud-reminders' | 'reminders-file';

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
