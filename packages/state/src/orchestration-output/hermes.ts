import { GenericHarnessOutputAdapter } from './generic.js';
import type { OmittedOutputBlock } from './types.js';

export class HermesHarnessOutputAdapter extends GenericHarnessOutputAdapter {
  override readonly id = 'hermes';

  protected override classify(line: string): Omit<OmittedOutputBlock, 'adapter' | 'lineCount'> | undefined {
    const value = line.trim();
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/u.test(value)) return { rule: 'spinner', category: 'progress' };
    if (/^(?:Tokens|Context|Elapsed):\s+/i.test(value)) return { rule: 'metrics', category: 'chrome' };
    return undefined;
  }
}
