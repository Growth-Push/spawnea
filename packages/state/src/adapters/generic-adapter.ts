import { ruleMatchesLine } from '../rules/rule-config.js';
import { RuleBasedStatusAdapter } from './rule-based-adapter.js';
import type { LinePreparationContext } from './types.js';

export class GenericStatusAdapter extends RuleBasedStatusAdapter {
  readonly harnessId = 'generic';
  readonly displayName = 'Generic / Shell Adapter';
  protected readonly trimsSupersededErrors = false;

  /**
   * A shell prompt or an error ends the output of the previous command, so
   * evaluation starts at the newest such line.
   */
  prepareLines(lines: string[], { rules }: LinePreparationContext): string[] {
    const boundaryRules = rules.filter((rule) => rule.state === 'idle' || rule.state === 'error');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (boundaryRules.some((rule) => ruleMatchesLine(rule, lines[i]))) {
        return lines.slice(i);
      }
    }
    return lines;
  }
}
