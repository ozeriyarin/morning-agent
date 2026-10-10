import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Item } from '../types.js';
import { DECISION_RULES } from './decision-model.js';
import { JEV_MODEL, JevDecisionModel, OPENROUTER_DECISIONS_URL } from './jev.js';

const KEY = 'sk-or-v1-synthetic-test-key';
const captured = JSON.parse(await readFile('test/fixtures/openrouter-decision.json', 'utf8'));

const item: Item = {
  id: 'https://example.com/1',
  title: 'Claude Code ships hooks',
  link: 'https://example.com/1',
  published: '2026-10-10T01:00:00.000Z',
  summary: 'release notes',
  sources: ['Simon Willison', 'Hacker News AI'],
};

interface Sent {
  url: string;
  init: RequestInit;
}

function fakeFetch(...replies: (Response | (() => Response))[]) {
  const sent: Sent[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    sent.push({ url: String(url), init: init ?? {} });
    const reply = replies[Math.min(sent.length, replies.length) - 1];
    if (!reply) throw new Error('no reply');
    return typeof reply === 'function' ? reply() : reply;
  };
  return { sent, fetchFn };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
const withChoice = (choice: unknown) =>
  json({ ...captured, answers: { decision: { ...captured.answers.decision, choice } } });
const jev = (fetchFn: typeof fetch) => new JevDecisionModel(KEY, fetchFn, { retryDelayMs: 0 });

describe('JevDecisionModel', () => {
  it('v4 criterion 1: "Given a captured-shape OpenRouter decisions response with `choice: "mention"`, `JevDecisionModel` returns `mention` with the confidence and probabilities attached, and the call record has `provider: \'openrouter\'` and `costUsd` equal to `usage.cost`."', async () => {
    const { fetchFn } = fakeFetch(json(captured));
    const result = await jev(fetchFn).decide(item);
    expect(result).toMatchObject({
      decision: 'mention',
      confidence: 0.82,
      probabilities: { must_read: 0.11, mention: 0.82, skip: 0.07 },
      call: {
        role: 'decision',
        model: JEV_MODEL,
        provider: 'openrouter',
        inputTokens: 412,
        costUsd: captured.usage.cost,
      },
    });
    expect(result.error).toBeUndefined();
  });

  it('v4 criterion 2: "The request body sent to OpenRouter has `model`, `state.item` with only title/summary/source/publishedAt, and a `questions.decision` choice question whose `criteria` keys are exactly `must_read`, `mention`, `skip`; the Authorization header is `Bearer <key>`."', async () => {
    const { sent, fetchFn } = fakeFetch(json(captured));
    await jev(fetchFn).decide(item);
    const [request] = sent;
    expect(request?.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(request?.init.method).toBe('POST');
    expect((request?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(request?.init.body));
    expect(body.model).toBe(JEV_MODEL);
    expect(body.state.item).toEqual({
      title: item.title,
      summary: item.summary,
      source: 'Simon Willison, Hacker News AI',
      publishedAt: item.published,
    });
    expect(body.state.rules).toBe(DECISION_RULES);
    expect(body.questions.decision.type).toBe('choice');
    expect(Object.keys(body.questions.decision.criteria)).toEqual(['must_read', 'mention', 'skip']);
  });

  it('builds instructions and criteria from the same DECISION_RULES text Haiku gets', async () => {
    const { sent, fetchFn } = fakeFetch(json(captured));
    await jev(fetchFn).decide(item);
    const { instructions, criteria } = JSON.parse(String(sent[0]?.init.body)).questions.decision;
    expect(DECISION_RULES).toContain(instructions.split(' Classify state.item')[0]);
    for (const [option, text] of Object.entries(criteria))
      expect(DECISION_RULES).toContain(`- ${option}: ${text}`);
  });

  it.each([['important'], ['MUST_READ'], [null]])(
    'v4 criterion 3: "An answer outside the three options maps to `skip` with an error in the record (same rule as Haiku)." (%j)',
    async (choice) => {
      const { fetchFn } = fakeFetch(withChoice(choice));
      const result = await jev(fetchFn).decide(item);
      expect(result).toMatchObject({ decision: 'skip', error: expect.stringContaining('invalid') });
      expect(result.call?.costUsd).toBe(captured.usage.cost);
    },
  );

  it.each([[429], [500], [503]])(
    'v4 criterion 4: "A 429 or 5xx is retried once; a second failure or a timeout records an error and the item is `skip` (the brief still sends)." (HTTP %i, then success)',
    async (status) => {
      const { sent, fetchFn } = fakeFetch(json({}, status), json(captured));
      expect((await jev(fetchFn).decide(item)).decision).toBe('mention');
      expect(sent).toHaveLength(2);
    },
  );

  it('v4 criterion 4: "A 429 or 5xx is retried once; a second failure or a timeout records an error and the item is `skip` (the brief still sends)." (second failure, no third try)', async () => {
    const { sent, fetchFn } = fakeFetch(json({}, 502), json({}, 429), json(captured));
    await expect(jev(fetchFn).decide(item)).rejects.toThrow('HTTP 429');
    expect(sent).toHaveLength(2);
  });

  it('v4 criterion 4: "A 429 or 5xx is retried once; a second failure or a timeout records an error and the item is `skip` (the brief still sends)." (timeout, not retried)', async () => {
    let calls = 0;
    const hanging: typeof fetch = (_url, init) => {
      calls += 1;
      return new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      );
    };
    const model = new JevDecisionModel(KEY, hanging, { timeoutMs: 20, retryDelayMs: 0 });
    await expect(model.decide(item)).rejects.toThrow(/timeout|abort/i);
    expect(calls).toBe(1);
  });

  it('a 4xx other than 429 is not retried and a malformed body is an error', async () => {
    const unauthorized = fakeFetch(json({}, 401));
    await expect(jev(unauthorized.fetchFn).decide(item)).rejects.toThrow('HTTP 401');
    expect(unauthorized.sent).toHaveLength(1);
    await expect(jev(fakeFetch(json({ answers: {} })).fetchFn).decide(item)).rejects.toThrow(
      'unexpected shape',
    );
  });
});
