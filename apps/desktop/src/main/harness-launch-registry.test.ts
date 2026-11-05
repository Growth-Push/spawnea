import { describe, expect, it } from 'vitest';
import { HarnessLaunchRegistry } from './harness-launch-registry.js';

describe('HarnessLaunchRegistry', () => {
  const registry = new HarnessLaunchRegistry();
  it.each(['codex.exe', 'C:\\tools\\hermes.cmd', '/opt/claude.bat'])('recognizes a configured executable suffix: %s', (command) => {
    expect(registry.promptInput(command, undefined, 'Review')).toBe('\x1b[200~Review\x1b[201~');
  });
  it.each(['agy', 'antigravity'])('replaces both model aliases for %s', (harness) => {
    expect(registry.withModel(harness, harness, ['-m', 'old', '--model=older', '--verbose'], 'new', true))
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
    expect(registry.withModel(command, harness, [flag, 'old', '--verbose'], 'new', harness === 'agy')).toEqual([
      '--verbose', flag, 'new',
    ]);
  });

  it('preserves configured arguments when no model is requested', () => {
    expect(registry.withModel('unknown', 'unknown', ['--flag'], undefined)).toEqual(['--flag']);
  });

  it.each([
    ['hermes-review', '/opt/agents/hermes', '-m'],
    ['codex-review', 'codex', '-m'],
    ['claude-review', 'C:\\tools\\claude.exe', '--model'],
  ])('resolves the native model option for configured profile %s', (profile, command, flag) => {
    const args = ['--profile', 'example-profile', '--model=previous-model', '--verbose'];
    expect(registry.withModel(command, profile, args, 'Literal.v1:Org/Model_ID'))
      .toEqual(['--profile', 'example-profile', '--verbose', flag, 'Literal.v1:Org/Model_ID']);
    expect(registry.withModel(command, profile, args, undefined)).toEqual(args);
  });

  it('keeps unsupported root executables restricted even with a supported profile key', () => {
    expect(() => registry.withModel('agy', 'codex', [], 'model')).toThrow(
      "Harness 'agy' does not support explicit model selection"
    );
    expect(registry.withModel('agy', 'codex', [], 'model', true)).toEqual(['--model', 'model']);
  });

  it('rejects model selection for an unsupported harness', () => {
    expect(() => registry.withModel('opencode', 'opencode', [], 'model')).toThrow(
      "Harness 'opencode' does not support explicit model selection"
    );
  });

  it.each(['codex', 'claude', 'hermes'])('does not infer root capability from profile key %s', (profile) => {
    expect(() => registry.withModel('example-wrapper', profile, [], 'model')).toThrow(
      "Harness 'example-wrapper' does not support explicit model selection"
    );
    expect(registry.withModel('example-wrapper', profile, [], 'model', true))
      .toEqual([profile === 'claude' ? '--model' : '-m', 'model']);
  });

  it('rejects extended harness model overrides for roots but preserves child adapter behavior', () => {
    expect(() => registry.withModel('antigravity', 'antigravity', [], 'model')).toThrow(
      "Harness 'antigravity' does not support explicit model selection"
    );
    expect(registry.withModel('antigravity', 'antigravity', ['--verbose'], 'model', true))
      .toEqual(['--verbose', '--model', 'model']);
  });

  it.each([' model', 'model ', 'mo del', ''])('rejects a non-literal model identifier: %j', (model) => {
    expect(() => registry.withModel('codex', 'codex', [], model)).toThrow();
  });

  describe('withSessionId', () => {
    it('appends --session-id for claude when not already present', () => {
      expect(registry.withSessionId('claude', 'claude', ['--verbose'], '11111111-1111-1111-1111-111111111111'))
        .toEqual(['--verbose', '--session-id', '11111111-1111-1111-1111-111111111111']);
      expect(registry.withSessionId('claude-code', 'claude-code', [], '22222222-2222-2222-2222-222222222222'))
        .toEqual(['--session-id', '22222222-2222-2222-2222-222222222222']);
    });

    it('preserves existing --session-id and does not duplicate', () => {
      expect(registry.withSessionId('claude', 'claude', ['--session-id', 'existing-uuid'], 'new-uuid'))
        .toEqual(['--session-id', 'existing-uuid']);
      expect(registry.withSessionId('claude', 'claude', ['--session-id=inline-uuid'], 'new-uuid'))
        .toEqual(['--session-id=inline-uuid']);
    });

    it('ignores non-claude harnesses', () => {
      expect(registry.withSessionId('codex', 'codex', ['-m', 'o1'], 'some-uuid'))
        .toEqual(['-m', 'o1']);
      expect(registry.withSessionId('bash', 'shell', [], 'some-uuid'))
        .toEqual([]);
      expect(registry.withSessionId('bash', 'claude', ['-l'], '11111111-1111-1111-1111-111111111111'))
        .toEqual(['-l']);
      expect(registry.withSessionId('my-wrapper', 'claude', ['--verbose'], '11111111-1111-1111-1111-111111111111'))
        .toEqual(['--verbose']);
    });

    it('does not append --session-id for --continue or --resume without --fork-session', () => {
      expect(registry.withSessionId('claude', 'claude', ['--continue'], 'new-uuid'))
        .toEqual(['--continue']);
      expect(registry.withSessionId('claude', 'claude', ['-c'], 'new-uuid'))
        .toEqual(['-c']);
      expect(registry.withSessionId('claude', 'claude', ['--resume', 'session-123'], 'new-uuid'))
        .toEqual(['--resume', 'session-123']);
      expect(registry.withSessionId('claude', 'claude', ['-r', 'session-123'], 'new-uuid'))
        .toEqual(['-r', 'session-123']);
      expect(registry.withSessionId('claude', 'claude', ['-rsession-123'], 'new-uuid'))
        .toEqual(['-rsession-123']);
      expect(registry.withSessionId('claude', 'claude', ['--resume=session-123'], 'new-uuid'))
        .toEqual(['--resume=session-123']);
      expect(registry.withSessionId('claude', 'claude', ['--resume', 'session-123', '--fork-session'], 'new-uuid'))
        .toEqual(['--resume', 'session-123', '--fork-session', '--session-id', 'new-uuid']);
    });

    it('inserts --session-id before the end-of-options separator --', () => {
      expect(registry.withSessionId('claude', 'claude', ['--', 'Review this repository'], 'new-uuid'))
        .toEqual(['--session-id', 'new-uuid', '--', 'Review this repository']);
      expect(registry.withSessionId('claude', 'claude', ['-p', 'agent', '--', '--continue'], 'new-uuid'))
        .toEqual(['-p', 'agent', '--session-id', 'new-uuid', '--', '--continue']);
    });
  });
});
