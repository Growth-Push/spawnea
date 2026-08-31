import type {
  SessionSignals,
  SessionStatusResult,
  HarnessLifecycleEvent,
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
   * Parses raw string lines into typed lifecycle events (if supported by the harness).
   */
  parseRawEvents?(rawJsonLines: string[]): HarnessLifecycleEvent[];

  /**
   * Evaluates normalized session attention state from signals, events, and non-invasive fallback heuristics.
   */
  evaluateStatus(
    signals: SessionSignals,
    recentEvents?: HarnessLifecycleEvent[],
    options?: HarnessStatusAdapterOptions
  ): SessionStatusResult;
}

