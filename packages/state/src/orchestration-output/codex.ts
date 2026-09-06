import { GenericHarnessOutputAdapter } from './generic.js';
import type { OmittedOutputBlock } from './types.js';

export class CodexHarnessOutputAdapter extends GenericHarnessOutputAdapter {
  override readonly id = 'codex';

  protected override classify(line: string): Omit<OmittedOutputBlock, 'adapter' | 'lineCount'> | undefined {
    const value = line.trim();
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/u.test(value)) return { rule: 'spinner', category: 'progress' };
    if (/^(?:Worked for \d+(?:\.\d+)?s|Thinking\.\.\.|Exploring\.\.\.)$/i.test(value)) return { rule: 'activity-status', category: 'progress' };
    return undefined;
  }
}
