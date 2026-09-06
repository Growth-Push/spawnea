import { GenericHarnessOutputAdapter } from './generic.js';
import type { OmittedOutputBlock } from './types.js';

export class AntigravityHarnessOutputAdapter extends GenericHarnessOutputAdapter {
  override readonly id = 'antigravity';

  protected override classify(line: string): Omit<OmittedOutputBlock, 'adapter' | 'lineCount'> | undefined {
    const value = line.trim();
    if (/^(?:Reading|Searching|Running)\s+.+\.{3}$/i.test(value)) return { rule: 'tool-progress', category: 'tool_activity' };
    return undefined;
  }
}
