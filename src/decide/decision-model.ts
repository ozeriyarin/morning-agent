import { z } from 'zod';
import { DECISIONS, type Decision, type Item } from '../types.js';

export const decisionSchema = z.object({ decision: z.enum(DECISIONS) }).strict();

export const DECISION_TOOL_NAME = 'record_decision';

export const DECISION_RULES = `You triage AI news for a full-stack / AI developer in Israel.
Classify the item by calling the ${DECISION_TOOL_NAME} tool exactly once.
- must_read: a new model or major feature from Anthropic, OpenAI, Google, Meta or Mistral; agent or coding-tool releases; anything about Claude Code, MCP, Jev or decision models, RAG tooling; Israeli AI companies.
- mention: benchmark posts, funding news, opinion pieces from known engineers.
- skip: marketing, duplicates of a must_read, crypto, politics, listicles, anything else.`;

export function itemPrompt(item: Item): string {
  return `Source: ${item.sources.join(', ')}\nTitle: ${item.title}\nSummary: ${item.summary}`;
}

// Anything outside the closed enum becomes skip, with the reason kept for the record.
export function mapDecision(raw: unknown): { decision: Decision; error?: string } {
  const parsed = decisionSchema.safeParse(raw);
  if (parsed.success) return { decision: parsed.data.decision };
  return { decision: 'skip', error: `invalid decision output: ${JSON.stringify(raw) ?? 'none'}` };
}
