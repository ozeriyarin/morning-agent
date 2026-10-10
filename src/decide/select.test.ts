import { describe, expect, it } from 'vitest';
import { fakeClient } from '../testing/fake-client.js';
import { FakeDecisionModel } from './fake.js';
import { HaikuDecisionModel } from './haiku.js';
import { JevDecisionModel } from './jev.js';
import { JEV_NO_KEY_WARNING, selectDecisionModel, type DeciderOptions } from './select.js';

const KEY = 'sk-or-v1-synthetic-test-key';
const client = fakeClient([]);
const fetchFn: typeof fetch = async () => {
  throw new Error('no network in tests');
};
const base: DeciderOptions = { client, openRouterKey: null, fetchFn };

describe('selectDecisionModel', () => {
  it.each([
    ['flag jev without the key', { flag: 'jev' }, HaikuDecisionModel, [JEV_NO_KEY_WARNING]],
    ['flag jev with the key', { flag: 'jev', openRouterKey: KEY }, JevDecisionModel, []],
    [
      'config jev with the key, no flag',
      { configured: 'jev', openRouterKey: KEY },
      JevDecisionModel,
      [],
    ],
    ['config jev without the key', { configured: 'jev' }, HaikuDecisionModel, [JEV_NO_KEY_WARNING]],
    [
      'flag haiku over config jev',
      { flag: 'haiku', configured: 'jev', openRouterKey: KEY },
      HaikuDecisionModel,
      [],
    ],
    ['nothing set', { openRouterKey: KEY }, HaikuDecisionModel, []],
    ['flag fake', { flag: 'fake', openRouterKey: KEY }, FakeDecisionModel, []],
    ['dry run (no Anthropic client)', { flag: 'jev', client: null }, FakeDecisionModel, []],
  ] as const)(
    'v4 criterion 5: "Selection: `--decider jev` without `OPENROUTER_API_KEY` falls back to Haiku and records the warning; with the key it uses Jev; `config.decisionModel` is honoured when no flag is given; default is Haiku." (%s)',
    (_, over, expected, warnings) => {
      const selected = selectDecisionModel({ ...base, ...over });
      expect(selected.model).toBeInstanceOf(expected);
      expect(selected.warnings).toEqual(warnings);
    },
  );
});
