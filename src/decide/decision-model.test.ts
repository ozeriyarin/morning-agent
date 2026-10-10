import { describe, expect, it } from 'vitest';
import { fakeClient } from '../testing/fake-client.js';
import type { Item } from '../types.js';
import { mapDecision } from './decision-model.js';
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
