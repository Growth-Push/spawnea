import { describe, it, expect } from 'vitest';
import { HarnessStatusAdapterRegistry } from '../src/adapters/registry.js';
import { CodexStatusAdapter } from '../src/adapters/codex-adapter.js';
import { HermesStatusAdapter } from '../src/adapters/hermes-adapter.js';
import { AntigravityStatusAdapter } from '../src/adapters/antigravity-adapter.js';
import { GenericStatusAdapter } from '../src/adapters/generic-adapter.js';
import { GrokStatusAdapter } from '../src/adapters/grok-adapter.js';

describe('HarnessStatusAdapterRegistry', () => {
  const registry = new HarnessStatusAdapterRegistry();

  it('resolves CodexStatusAdapter for codex harness', () => {
    const adapter = registry.getAdapter('codex');
    expect(adapter).toBeInstanceOf(CodexStatusAdapter);
    expect(adapter.harnessId).toBe('codex');
  });

  it('resolves CodexStatusAdapter for aliases', () => {
    const adapter = registry.getAdapter('codex-cli');
    expect(adapter).toBeInstanceOf(CodexStatusAdapter);
  });

  it('resolves HermesStatusAdapter for hermes harness and aliases', () => {
    const adapter1 = registry.getAdapter('hermes');
    expect(adapter1).toBeInstanceOf(HermesStatusAdapter);
    expect(adapter1.harnessId).toBe('hermes');

    const adapter2 = registry.getAdapter('hermes-python');
    expect(adapter2).toBeInstanceOf(HermesStatusAdapter);
  });

  it('resolves AntigravityStatusAdapter for the canonical ID and explicit aliases', () => {
    const adapter1 = registry.getAdapter('antigravity');
    expect(adapter1).toBeInstanceOf(AntigravityStatusAdapter);
    expect(adapter1.harnessId).toBe('antigravity');

    const adapter2 = registry.getAdapter('agy');
    expect(adapter2).toBeInstanceOf(AntigravityStatusAdapter);
    expect(adapter2.harnessId).toBe('antigravity');

    const adapter3 = registry.getAdapter('gemini-cli');
    expect(adapter3).toBeInstanceOf(AntigravityStatusAdapter);
    expect(adapter3.harnessId).toBe('antigravity');
  });

  it('resolves GrokStatusAdapter for the grok harness', () => {
    const adapter = registry.getAdapter('grok');
    expect(adapter).toBeInstanceOf(GrokStatusAdapter);
    expect(adapter.harnessId).toBe('grok');
    expect(registry.getAdapter('/usr/local/bin/grok')).toBeInstanceOf(GrokStatusAdapter);
    expect(registry.getAdapter('xai')).toBeInstanceOf(GrokStatusAdapter);
  });

  it('preserves an exact registered ID containing a slash', () => {
    const scopedRegistry = new HarnessStatusAdapterRegistry();
    const grok = new GrokStatusAdapter();
    const custom = {
      harnessId: 'vendor/grok',
      displayName: 'Vendor Grok',
      evaluateStatus: grok.evaluateStatus.bind(grok),
    };
    scopedRegistry.register(custom);
    expect(scopedRegistry.getAdapter('vendor/grok')).toBe(custom);
    expect(scopedRegistry.getAdapter('/usr/local/bin/grok')).toBeInstanceOf(GrokStatusAdapter);
  });

  it('resolves GenericStatusAdapter for unknown or undefined harnesses', () => {
    const adapter1 = registry.getAdapter('unknown-harness');
    expect(adapter1).toBeInstanceOf(GenericStatusAdapter);

    const adapter2 = registry.getAdapter(undefined);
    expect(adapter2).toBeInstanceOf(GenericStatusAdapter);
  });
});
