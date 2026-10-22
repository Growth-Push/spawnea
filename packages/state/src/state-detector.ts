import type {
  SessionSignals,
  SessionStatusResult,
} from '@spawnea/domain';
import type { StateRuleSet } from './rules/rule-config.js';
import { getFactoryStateRuleSet } from './rules/factory-rules.js';
import { HarnessStatusAdapterRegistry } from './adapters/registry.js';
import type { HarnessStatusAdapter } from './adapters/types.js';

export interface StateDetectorOptions {
  activeOutputWindowMs?: number;
  /**
   * Compiled rules loaded once at startup and shared by every detector.
   * Defaults to the factory rules.
   */
  rules?: StateRuleSet;
  registry?: HarnessStatusAdapterRegistry;
}

export interface DetectStatusOptions {
  /** Configured agent command, so its process is not mistaken for a tool. */
  harnessCommand?: string;
}

export class StateDetector {
  private readonly activeOutputWindowMs: number;
  private readonly registry: HarnessStatusAdapterRegistry;
  readonly rules: StateRuleSet;

  constructor(options: StateDetectorOptions = {}) {
    this.activeOutputWindowMs = options.activeOutputWindowMs || 3000;
    this.rules = options.rules ?? getFactoryStateRuleSet();
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
    options: DetectStatusOptions = {}
  ): SessionStatusResult {
    const name = harnessName || signals.paneCurrentCommand;
    const adapter = this.registry.getAdapter(name);

    return adapter.evaluateStatus(signals, {
      activeOutputWindowMs: this.activeOutputWindowMs,
      rules: this.rules,
      // A harness only the user file defines keeps its own rules.
      ruleHarness: this.rules.resolveHarness(name) ?? adapter.harnessId,
      harnessCommand: options.harnessCommand,
    });
  }
}
