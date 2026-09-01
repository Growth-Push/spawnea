import type {
  SessionSignals,
  SessionStatusResult,
} from '@spawnea/domain';
import type { PatternRule } from '../rules/types.js';

export interface HarnessStatusAdapterOptions {
  activeOutputWindowMs?: number;
  customRules?: PatternRule[];
}

export interface HarnessStatusAdapter {
  readonly harnessId: string;
  readonly displayName: string;

  /**
   * Evaluates normalized session attention state from observable runtime signals and terminal output.
   */
  evaluateStatus(
    signals: SessionSignals,
    options?: HarnessStatusAdapterOptions
  ): SessionStatusResult;
}
