import type {
  SessionSignals,
  SessionStatusResult,
} from '@spawnea/domain';
import type { CompiledStateRule, StateRuleSet } from '../rules/rule-config.js';

export interface HarnessStatusAdapterOptions {
  activeOutputWindowMs?: number;
  /** Shared compiled rules; defaults to the factory rules. */
  rules?: StateRuleSet;
  /** Rule list to evaluate; defaults to the adapter's harness id. */
  ruleHarness?: string;
  /** Configured agent command, so its process is not mistaken for a tool. */
  harnessCommand?: string;
}

export interface LinePreparationContext {
  /** Ordered rules that will evaluate the window. */
  rules: readonly CompiledStateRule[];
}

export interface HarnessStatusAdapter {
  readonly harnessId: string;
  readonly displayName: string;

  /** Builds the window of terminal lines that state rules evaluate. */
  evaluationWindow(tailLines: readonly string[], rules: readonly CompiledStateRule[]): string[];

  /**
   * Evaluates normalized session attention state from observable runtime signals and terminal output.
   */
  evaluateStatus(
    signals: SessionSignals,
    options?: HarnessStatusAdapterOptions
  ): SessionStatusResult;
}
