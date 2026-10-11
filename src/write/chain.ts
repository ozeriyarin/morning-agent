import type {
  CallUsage,
  Section,
  Writer,
  WriterInput,
  WriterName,
  WrittenBrief,
} from '../types.js';
import { TemplateWriter } from './template.js';
import { validateBrief, WriterError } from './writer.js';

export interface ChainResult {
  brief: WrittenBrief;
  writer: WriterName;
  attempts: number;
  calls: CallUsage[];
  failures: { model: string; error: unknown }[];
  omitted: Section[];
}

// Summary: tries each rung in order; the first output that validates wins.
// Details: the template always closes the chain, so the run always has a brief to send.
export class ChainWriter implements Writer {
  readonly name: WriterName;
  private readonly rungs: Writer[];

  constructor(writers: Writer[]) {
    this.rungs = writers.at(-1)?.name === 'template' ? writers : [...writers, new TemplateWriter()];
    this.name = this.rungs[0]?.name ?? 'template';
  }

  async write(input: WriterInput): Promise<ChainResult> {
    const calls: CallUsage[] = [];
    const failures: ChainResult['failures'] = [];
    const omitted = new Set<Section>();
    for (const [i, rung] of this.rungs.entries()) {
      const model = rung.model ?? rung.name;
      try {
        const { brief, call } = await rung.write(input);
        if (call) calls.push(call);
        const checked = validateBrief(brief);
        if (checked.ok) {
          const writer = rung.name;
          const kept = writer === 'template' ? [...omitted] : [];
          return { brief: checked.brief, writer, attempts: i + 1, calls, failures, omitted: kept };
        }
        checked.missing.forEach((section) => omitted.add(section));
        failures.push({ model, error: new Error(`output failed validation: ${checked.error}`) });
      } catch (error) {
        if (error instanceof WriterError && error.call) calls.push(error.call);
        failures.push({ model, error });
      }
    }
    throw new WriterError('the template writer produced an invalid brief');
  }
}
