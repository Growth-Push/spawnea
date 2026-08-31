import type { HarnessStatusAdapter } from './types.js';
import { GenericStatusAdapter } from './generic-adapter.js';
import { CodexStatusAdapter } from './codex-adapter.js';
import { HermesStatusAdapter } from './hermes-adapter.js';
import { AntigravityStatusAdapter } from './antigravity-adapter.js';

export class HarnessStatusAdapterRegistry {
  private readonly adapters: Map<string, HarnessStatusAdapter> = new Map();
  private readonly defaultAdapter: HarnessStatusAdapter;
  private readonly aliases = new Map<string, string>([
    ['codex-cli', 'codex'],
    ['hermes-python', 'hermes'],
    ['agy', 'antigravity'],
    ['gemini-cli', 'antigravity'],
  ]);

  constructor() {
    this.defaultAdapter = new GenericStatusAdapter();
    this.register(this.defaultAdapter);
    this.register(new CodexStatusAdapter());
    this.register(new HermesStatusAdapter());
    this.register(new AntigravityStatusAdapter());
  }

  register(adapter: HarnessStatusAdapter): void {
    this.adapters.set(adapter.harnessId.toLowerCase(), adapter);
  }

  getAdapter(harnessId?: string): HarnessStatusAdapter {
    if (!harnessId) {
      return this.defaultAdapter;
    }

    const normalized = harnessId.toLowerCase().trim();
    if (this.adapters.has(normalized)) {
      return this.adapters.get(normalized)!;
    }

    const canonicalId = this.aliases.get(normalized);
    if (canonicalId) {
      return this.adapters.get(canonicalId) || this.defaultAdapter;
    }

    return this.defaultAdapter;
  }

  listAdapters(): HarnessStatusAdapter[] {
    return Array.from(this.adapters.values());
  }
}
