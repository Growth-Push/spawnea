import { GenericHarnessOutputAdapter } from './generic.js';
import type { OmittedOutputBlock } from './types.js';

export class AntigravityHarnessOutputAdapter extends GenericHarnessOutputAdapter {
  override readonly id = 'antigravity';

  protected override classify(line: string): Omit<OmittedOutputBlock, 'adapter' | 'lineCount'> | undefined {
    const value = line.trim();
    const progressPrefixes = ['reading ', 'searching ', 'running '];
    const lowerValue = value.toLowerCase();
    if (progressPrefixes.some((prefix) => lowerValue.startsWith(prefix)) && value.endsWith('...')) {
      return { rule: 'tool-progress', category: 'tool_activity' };
    }
    return undefined;
  }
}
