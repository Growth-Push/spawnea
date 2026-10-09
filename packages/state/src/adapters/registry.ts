import type { HarnessStatusAdapter } from './types.js';
import { GenericStatusAdapter } from './generic-adapter.js';
import { CodexStatusAdapter } from './codex-adapter.js';
import { HermesStatusAdapter } from './hermes-adapter.js';
import { AntigravityStatusAdapter } from './antigravity-adapter.js';
import { GrokStatusAdapter } from './grok-adapter.js';

export class HarnessStatusAdapterRegistry {
  private readonly adapters: Map<string, HarnessStatusAdapter> = new Map();
  private readonly defaultAdapter: HarnessStatusAdapter;
  private readonly aliases = new Map<string, string>([
    ['codex-cli', 'codex'],
    ['hermes-python', 'hermes'],
    ['agy', 'antigravity'],
    ['gemini-cli', 'antigravity'],
    ['xai', 'grok'],
  ]);

  constructor() {
    this.defaultAdapter = new GenericStatusAdapter();
    this.register(this.defaultAdapter);
    this.register(new CodexStatusAdapter());
    this.register(new HermesStatusAdapter());
    this.register(new AntigravityStatusAdapter());
    this.register(new GrokStatusAdapter());
  }

  register(adapter: HarnessStatusAdapter): void {
    this.adapters.set(adapter.harnessId.toLowerCase(), adapter);
  }

  getAdapter(harnessId?: string): HarnessStatusAdapter {
    if (!harnessId) {
      return this.defaultAdapter;
    }

    const normalized = harnessId.toLowerCase().trim();
    const exact = this.adapters.get(normalized) ?? this.adapters.get(this.aliases.get(normalized) ?? '');
    if (exact) {
      return exact;
    }

    const command = normalized.split(/[\\/]/).pop() ?? '';
    return this.adapters.get(command)
      ?? this.adapters.get(this.aliases.get(command) ?? '')
      ?? this.defaultAdapter;
  }

  listAdapters(): HarnessStatusAdapter[] {
    return Array.from(this.adapters.values());
  }
}
