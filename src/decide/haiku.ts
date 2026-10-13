import { callUsage, type MessagesClient } from '../cost.js';
import {
  DECISIONS,
  type DecisionExample,
  type DecisionModel,
  type DecisionResult,
  type Item,
} from '../types.js';
import { DECISION_RULES, DECISION_TOOL_NAME, itemPrompt, mapDecision } from './decision-model.js';

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

export class HaikuDecisionModel implements DecisionModel {
  readonly model = HAIKU_MODEL;

  constructor(private readonly client: MessagesClient) {}

  async decide(item: Item, examples?: DecisionExample[]): Promise<DecisionResult> {
    const started = performance.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 100,
      system: DECISION_RULES,
      tools: [
        {
          name: DECISION_TOOL_NAME,
          description: 'Record the triage decision for one news item.',
          input_schema: {
            type: 'object',
            properties: { decision: { type: 'string', enum: [...DECISIONS] } },
            required: ['decision'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: DECISION_TOOL_NAME },
      messages: [{ role: 'user', content: itemPrompt(item, examples) }],
    });
    const call = callUsage('decision', this.model, response.usage, performance.now() - started);
    const block = response.content.find((b) => b.type === 'tool_use');
    return { ...mapDecision(block?.input), call };
  }
}
