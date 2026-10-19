import { describe, expect, it } from 'vitest';
import { fakeClient } from '../testing/fake-client.js';
import type { DecisionExample, Item } from '../types.js';
import { DECISION_RULES, itemPrompt, mapDecision } from './decision-model.js';
import { FakeDecisionModel } from './fake.js';
import { HAIKU_MODEL, HaikuDecisionModel } from './haiku.js';

const item: Item = {
  id: 'https://x/1',
  title: 'Claude Code ships hooks',
  link: 'https://x/1',
  published: '2026-10-10T01:00:00.000Z',
  summary: 'release notes',
  sources: ['Simon Willison'],
};

describe('decision mapping', () => {
  it.each([
    [{ decision: 'must_read' }, 'must_read', false],
    [{ decision: 'mention' }, 'mention', false],
    [{ decision: 'skip' }, 'skip', false],
    [{ decision: 'MUST_READ' }, 'skip', true],
    [{ decision: 'important' }, 'skip', true],
    [{ decision: 'mention', extra: 1 }, 'skip', true],
    [{}, 'skip', true],
    ['must_read', 'skip', true],
    [undefined, 'skip', true],
  ])(
    'criterion 4: "Decision mapping: the decision model\'s tool output maps exactly to the enum; an invalid value becomes `skip` with an error noted in the record." (%j)',
    (raw, decision, hasError) => {
      const mapped = mapDecision(raw);
      expect(mapped.decision).toBe(decision);
      expect(mapped.error !== undefined).toBe(hasError);
    },
  );
});

describe('HaikuDecisionModel', () => {
  it('forces the closed-choice tool and maps its input', async () => {
    const client = fakeClient([
      { type: 'tool_use', id: 't1', name: 'record_decision', input: { decision: 'must_read' } },
    ]);
    const result = await new HaikuDecisionModel(client).decide(item);
    const request = client.requests[0];
    expect(request?.model).toBe(HAIKU_MODEL);
    expect(request?.tool_choice).toEqual({ type: 'tool', name: 'record_decision' });
    expect(JSON.stringify(request?.tools)).toContain('"enum":["must_read","mention","skip"]');
    expect(result.decision).toBe('must_read');
    expect(result.call).toMatchObject({
      role: 'decision',
      inputTokens: 1000,
      cacheReadTokens: 800,
    });
  });

  it('v13 criterion 4: "Decisions receive at most `examples` labelled chunks each, ordered by score, and the Haiku prompt contains an `Examples` block with `"<title>" → <label>` lines; with no labelled chunks the block is absent and the prompt is byte-identical to v12." (prompt)', async () => {
    const examples: DecisionExample[] = [
      { title: 'Anthropic ships Claude Code hooks', label: 'must_read', score: 0.93 },
      { title: 'Ten tips for a tidy desk', label: 'skip', score: 0.71 },
    ];
    const v12 = 'Source: Simon Willison\nTitle: Claude Code ships hooks\nSummary: release notes';
    const tool = { type: 'tool_use' as const, id: 't1', name: 'record_decision', input: {} };
    const client = fakeClient([tool]);
    await new HaikuDecisionModel(client).decide(item, examples);
    await new HaikuDecisionModel(client).decide(item, []);
    await new HaikuDecisionModel(client).decide(item);
    const prompts = client.requests.map((r) => r.messages[0]?.content);
    expect(prompts[0]).toBe(
      `${v12}\nExamples:\n"Anthropic ships Claude Code hooks" → must_read\n"Ten tips for a tidy desk" → skip`,
    );
    expect(prompts[1]).toBe(v12);
    expect(prompts[2]).toBe(v12);
    expect(itemPrompt(item)).toBe(v12);
    expect(client.requests[0]?.system).toBe(DECISION_RULES);
    expect(DECISION_RULES).toContain('prior human labels for similar items');
  });

  it('a reply without a tool call becomes skip with an error', async () => {
    const client = fakeClient([{ type: 'text', text: 'must_read' }]);
    const result = await new HaikuDecisionModel(client).decide(item);
    expect(result).toMatchObject({ decision: 'skip', error: expect.stringContaining('invalid') });
  });
});

describe('FakeDecisionModel', () => {
  it('classifies by keywords offline and maps injected raw output', async () => {
    expect((await new FakeDecisionModel().decide(item)).decision).toBe('must_read');
    expect((await new FakeDecisionModel(() => ({ decision: 'x' })).decide(item)).decision).toBe(
      'skip',
    );
  });
});

describe('v14 decision rules', () => {
  it('v14 criterion 4: "The decision rules name SDD frameworks and Jev/Claude Code releases as must_read and include the thin-day instruction; the eval score on `eval/decisions.json` does not drop."', () => {
    const mustRead = DECISION_RULES.split('\n').find((l) => l.startsWith('- must_read: '));
    for (const name of [
      'spec-driven',
      'Agent OS',
      'spec-kit',
      'BMAD',
      'Claude Code or Jev release',
    ])
      expect(mustRead).toContain(name);
    expect(DECISION_RULES).toContain(
      'On a thin day, pick the two or three strongest AI-engineering items as must_read',
    );
  });
});
