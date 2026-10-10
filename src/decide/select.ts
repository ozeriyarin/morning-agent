import type { MessagesClient } from '../cost.js';
import type { DecisionModel } from '../types.js';
import { FakeDecisionModel } from './fake.js';
import { HaikuDecisionModel } from './haiku.js';
import { JevDecisionModel } from './jev.js';

export const DECIDERS = ['fake', 'haiku', 'jev'] as const;
export type Decider = (typeof DECIDERS)[number];

export const JEV_NO_KEY_WARNING = 'jev: no key, using haiku';

export interface DeciderOptions {
  flag?: Decider;
  configured?: Decider;
  client: MessagesClient | null;
  openRouterKey: string | null;
  fetchFn: typeof fetch;
}

// Flag beats config beats haiku; without an Anthropic client (dry run) every choice is the fake.
export function selectDecisionModel(options: DeciderOptions): {
  model: DecisionModel;
  warnings: string[];
} {
  const { flag, configured, client, openRouterKey, fetchFn } = options;
  const choice = flag ?? configured ?? 'haiku';
  if (choice === 'fake' || !client) return { model: new FakeDecisionModel(), warnings: [] };
  if (choice === 'jev' && openRouterKey)
    return { model: new JevDecisionModel(openRouterKey, fetchFn), warnings: [] };
  const warnings = choice === 'jev' ? [JEV_NO_KEY_WARNING] : [];
  return { model: new HaikuDecisionModel(client), warnings };
}
