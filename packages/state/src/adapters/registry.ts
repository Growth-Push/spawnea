import type { HarnessStatusAdapter } from './types.js';
import { GenericStatusAdapter } from './generic-adapter.js';
import { ClaudeStatusAdapter } from './claude-adapter.js';
import { CodexStatusAdapter } from './codex-adapter.js';
import { HermesStatusAdapter } from './hermes-adapter.js';
import { AntigravityStatusAdapter } from './antigravity-adapter.js';
import { GrokStatusAdapter } from './grok-adapter.js';
import { resolveKnownHarnessId } from '../harness-ids.js';

export class HarnessStatusAdapterRegistry {
  private readonly adapters: Map<string, HarnessStatusAdapter> = new Map();
  private readonly defaultAdapter: HarnessStatusAdapter;

  constructor() {
    this.defaultAdapter = new GenericStatusAdapter();
    this.register(this.defaultAdapter);
    this.register(new ClaudeStatusAdapter());
    this.register(new CodexStatusAdapter());
    this.register(new HermesStatusAdapter());
    this.register(new AntigravityStatusAdapter());
    this.register(new GrokStatusAdapter());
  }

  register(adapter: HarnessStatusAdapter): void {
    this.adapters.set(adapter.harnessId.toLowerCase(), adapter);
  }

  getAdapter(harnessId?: string): HarnessStatusAdapter {
    const resolved = resolveKnownHarnessId(harnessId, (id) => this.adapters.has(id));
    return (resolved && this.adapters.get(resolved)) || this.defaultAdapter;
  }

  listAdapters(): HarnessStatusAdapter[] {
    return Array.from(this.adapters.values());
  }
}
