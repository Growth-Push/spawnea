import type {
  SessionSignals,
  SessionStatusResult,
  HarnessLifecycleEvent,
} from '@spawnea/domain';
import type { PatternRule } from './rules/types.js';
import { HarnessStatusAdapterRegistry } from './adapters/registry.js';
import type { HarnessStatusAdapter } from './adapters/types.js';

export interface StateDetectorOptions {
  activeOutputWindowMs?: number;
  customRules?: PatternRule[];
  registry?: HarnessStatusAdapterRegistry;
}

export class StateDetector {
  private readonly activeOutputWindowMs: number;
  private readonly customRules?: PatternRule[];
  private readonly registry: HarnessStatusAdapterRegistry;

  constructor(options: StateDetectorOptions = {}) {
    this.activeOutputWindowMs = options.activeOutputWindowMs || 3000;
    this.customRules = options.customRules;
    this.registry = options.registry || new HarnessStatusAdapterRegistry();
  }

  /**
   * Resolves the appropriate status adapter for a given harness identifier.
   */
  getAdapter(harnessName?: string): HarnessStatusAdapter {
    return this.registry.getAdapter(harnessName);
  }

  /**
   * Evaluates multi-source observable signals to determine normalized session attention status.
   */
  detectStatus(
    signals: SessionSignals,
    harnessName?: string,
    recentEvents: HarnessLifecycleEvent[] = []
  ): SessionStatusResult {
    const events = signals.events || recentEvents;
    const adapter = this.registry.getAdapter(harnessName || signals.paneCurrentCommand);

    return adapter.evaluateStatus(signals, events, {
      activeOutputWindowMs: this.activeOutputWindowMs,
      customRules: this.customRules,
    });
  }
}
