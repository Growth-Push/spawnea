import { describe, expect, it } from 'vitest';
import { HarnessLaunchRegistry } from './harness-launch-registry.js';

describe('HarnessLaunchRegistry', () => {
  const registry = new HarnessLaunchRegistry();
  it.each(['codex.exe', 'C:\\tools\\hermes.cmd', '/opt/claude.bat'])('recognizes a configured executable suffix: %s', (command) => {
    expect(registry.promptInput(command, undefined, 'Review')).toBe('\x1b[200~Review\x1b[201~');
  });
  it.each(['agy', 'antigravity'])('replaces both model aliases for %s', (harness) => {
    expect(registry.withModel(harness, harness, ['-m', 'old', '--model=older', '--verbose'], 'new'))
      .toEqual(['--verbose', '--model', 'new']);
  });
  it('brackets multiline prompt text for known editors without including the submitting Enter', () => {
    expect(registry.promptInput('codex', undefined, 'one\ntwo')).toBe('\x1b[200~one\ntwo\x1b[201~');
    expect(registry.promptInput('shell', undefined, 'echo ok\n')).toBe('echo ok');
  });

  it('replaces long and equals-form model flags', () => {
    expect(registry.withModel('codex', 'codex', ['--model=old', '-m', 'other', '--verbose'], 'new'))
      .toEqual(['--verbose', '-m', 'new']);
    expect(registry.withModel('hermes', 'hermes', ['--model', 'old'], 'new')).toEqual(['-m', 'new']);
  });

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
