import type { DecisionModel, DecisionResult, Item } from '../types.js';
import { mapDecision } from './decision-model.js';

const MUST_READ = /\b(claude|anthropic|mcp|agent|codex|gpt-\d|gemini|llama|mistral|rag|model)\b/i;
const MENTION = /\b(benchmark|funding|raises|llm|ai)\b/i;

function keywordDecision(item: Item): unknown {
  if (MUST_READ.test(item.title)) return { decision: 'must_read' };
  if (MENTION.test(item.title)) return { decision: 'mention' };
  return { decision: 'skip' };
}

// Offline stand-in for dry runs and tests; raw outputs go through the same mapping as Haiku.
export class FakeDecisionModel implements DecisionModel {
  readonly model = 'fake';

  constructor(private readonly rawFor: (item: Item) => unknown = keywordDecision) {}

  async decide(item: Item): Promise<DecisionResult> {
    return mapDecision(this.rawFor(item));
  }
}
