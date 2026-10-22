import type { StateRuleReference } from '@spawnea/domain';
import type { RuleState, StateRuleSet } from './rules/rule-config.js';
import { matchStateRules } from './rules/rule-config.js';
import { getFactoryStateRuleSet } from './rules/factory-rules.js';
import { HarnessStatusAdapterRegistry } from './adapters/registry.js';

export { stripAnsi, cleanTailLines, codexSignalLines } from './terminal-lines.js';

export type PromptKind = RuleState | 'none';

export interface PromptDetectionResult {
  /** True for states that wait on the user: needs_input and idle. */
  isPrompt: boolean;
  kind: PromptKind;
  promptLine?: string;
  matchedRule?: StateRuleReference;
  matchedPattern?: string;
}

export interface PromptDetectorOptions {
  harness?: string;
  /** Shared compiled rules; defaults to the factory rules. */
  rules?: StateRuleSet;
}

const registry = new HarnessStatusAdapterRegistry();

/**
 * Evaluates the harness's state rules over terminal tail lines, after the
 * same preparation step and window the status detector uses. Connection,
 * process, and activity signals are not considered.
 */
export function detectPromptInTail(
  tailLines: string[],
  options: PromptDetectorOptions = {}
): PromptDetectionResult {
  const ruleSet = options.rules ?? getFactoryStateRuleSet();
  const adapter = registry.getAdapter(options.harness);
  const rules = ruleSet.rulesFor(ruleSet.resolveHarness(options.harness) ?? adapter.harnessId);
  const window = adapter.evaluationWindow(tailLines ?? [], rules);
  const match = matchStateRules(rules, window);
  if (!match) {
    return { isPrompt: false, kind: 'none' };
  }
  return {
    isPrompt: match.rule.state === 'needs_input' || match.rule.state === 'idle',
    kind: match.rule.state,
    promptLine: match.line,
    matchedRule: match.rule.ref,
    matchedPattern: match.pattern.source,
  };
}
