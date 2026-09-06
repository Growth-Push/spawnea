import { describe, expect, it } from 'vitest';
import { HarnessLaunchRegistry } from './harness-launch-registry.js';

describe('HarnessLaunchRegistry', () => {
  const registry = new HarnessLaunchRegistry();

  it.each([
    ['codex', 'codex', '-m'],
    ['claude', 'claude', '--model'],
    ['hermes', 'hermes', '-m'],
    ['agy', 'agy', '--model'],
  ])('maps %s model selection without duplicating configured flags', (harness, command, flag) => {
    expect(registry.withModel(command, harness, [flag, 'old', '--verbose'], 'new')).toEqual([
      '--verbose', flag, 'new',
    ]);
  });

  it('preserves configured arguments when no model is requested', () => {
    expect(registry.withModel('unknown', 'unknown', ['--flag'], undefined)).toEqual(['--flag']);
  });

  it('rejects model selection for an unsupported harness', () => {
    expect(() => registry.withModel('opencode', 'opencode', [], 'model')).toThrow(
      "Harness 'opencode' does not support explicit model selection"
    );
  });
});
