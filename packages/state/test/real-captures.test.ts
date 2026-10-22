import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionSignals, SessionStatus } from '@spawnea/domain';
import { StateDetector } from '../src/state-detector.js';
import { STATE_RULE_WINDOW_LINES } from '../src/adapters/rule-based-adapter.js';
import { getFactoryStateRuleSet } from '../src/rules/factory-rules.js';

/**
 * Screens captured from real harness sessions with the same command Spawnea
 * uses (`tmux capture-pane -p -S -50`), with local paths and account names
 * replaced by fictional values.
 */
function capture(name: string): string[] {
  return readFileSync(new URL(`./fixtures/real-captures/${name}.txt`, import.meta.url), 'utf8').split('\n');
}

function signals(tailLines: string[], paneCurrentCommand: string, overrides: Partial<SessionSignals> = {}): SessionSignals {
  return {
    sessionId: 'real-capture',
    hostReachable: true,
    tmuxSessionExists: true,
    paneExists: true,
    paneDead: false,
    paneCurrentCommand,
    isPtyAttached: false,
    tailLines,
    ...overrides,
  };
}

const CASES: Array<[name: string, harness: string, command: string, expected: SessionStatus]> = [
  ['claude-fresh', 'claude', 'claude', 'idle'],
  ['claude-tool-running', 'claude', 'claude', 'working'],
  ['claude-tool-running-late', 'claude', 'claude', 'working'],
  ['claude-thinking', 'claude', 'claude', 'working'],
  ['claude-question-menu', 'claude', 'claude', 'needs_input'],
  ['claude-turn-done', 'claude', 'claude', 'idle'],
  ['claude-turn-done-background-shell', 'claude', 'claude', 'idle'],
  ['claude-api-retry', 'claude', 'claude', 'working'],
  ['codex-trust-dialog', 'codex', 'codex', 'needs_input'],
  ['codex-fresh', 'codex', 'codex', 'idle'],
  ['codex-tool-running', 'codex', 'codex', 'working'],
  ['codex-waiting-background-terminal', 'codex', 'codex', 'working'],
  ['codex-turn-done', 'codex', 'codex', 'idle'],
  ['codex-long-questionnaire', 'codex', 'codex', 'needs_input'],
  ['hermes-setup-menu', 'hermes', 'python3', 'needs_input'],
  ['hermes-fresh', 'hermes', 'python3', 'idle'],
  ['hermes-tool-running', 'hermes', 'python3', 'working'],
  ['hermes-clarify-menu', 'hermes', 'python3', 'needs_input'],
  ['hermes-turn-done', 'hermes', 'python3', 'idle'],
  ['agy-trust-dialog', 'agy', 'agy', 'needs_input'],
  ['agy-fresh', 'agy', 'agy', 'idle'],
  ['agy-generating', 'agy', 'agy', 'working'],
  ['agy-tool-running', 'agy', 'agy', 'working'],
  ['agy-turn-done', 'agy', 'agy', 'idle'],
  ['grok-fresh', 'grok', 'grok', 'idle'],
  ['grok-tool-running', 'grok', 'grok', 'working'],
  ['grok-tool-running-late', 'grok', 'grok', 'working'],
  ['grok-turn-done', 'grok', 'grok', 'idle'],
  ['grok-question-card', 'grok', 'grok', 'needs_input'],
];

describe('real harness captures', () => {
  const detector = new StateDetector();

  it.each(CASES)('%s is %s by a rule within the evaluation window', (name, harness, command, expected) => {
    const result = detector.detectStatus(signals(capture(name), command), harness);
    expect(result.status).toBe(expected);
    // A rule decided it, so the activity fallback is not hiding a miss.
    expect(result.fallback).toBeUndefined();
    expect(result.matchedRule?.file).toBe('factory');

    const adapter = detector.getAdapter(harness);
    const window = adapter.evaluationWindow(capture(name), getFactoryStateRuleSet().rulesFor(harness));
    expect(window.length).toBeLessThanOrEqual(STATE_RULE_WINDOW_LINES);
    expect(window.join('\n')).toContain(result.detectedPrompt);
  });

  it('reports a new Claude session as idle even while an attach redraw is streaming', () => {
    const result = detector.detectStatus(
      signals(capture('claude-fresh'), 'claude', { lastOutputAt: new Date(), recentOutputBytes: 9000 }),
      'claude'
    );
    expect(result.status).toBe('idle');
  });

  it('does not report working only because the harness process is alive', () => {
    const quietUnknownScreen = ['some text the rules do not recognize'];
    for (const [harness, command] of [['claude', 'claude'], ['codex', 'node'], ['hermes', 'python3'], ['agy', 'agy'], ['grok', 'grok']]) {
      const result = detector.detectStatus(signals(quietUnknownScreen, command), harness);
      expect(result).toMatchObject({ status: 'idle', fallback: true, source: 'tmux' });
    }
  });

  it('reports working from the fallback for recent PTY output or a foreground tool', () => {
    const quiet = ['some text the rules do not recognize'];
    expect(detector.detectStatus(signals(quiet, 'claude', { lastOutputAt: new Date() }), 'claude'))
      .toMatchObject({ status: 'working', fallback: true, source: 'pty_activity' });
    expect(detector.detectStatus(signals(quiet, 'pnpm'), 'claude'))
      .toMatchObject({ status: 'working', fallback: true, source: 'process' });
    expect(detector.detectStatus(signals(quiet, 'zsh'), 'claude'))
      .toMatchObject({ status: 'idle', fallback: true });
    expect(detector.detectStatus(signals(quiet, 'my-agent'), 'claude', { harnessCommand: '/opt/bin/my-agent --flag' }))
      .toMatchObject({ status: 'idle', fallback: true });
  });

  it('treats a silent foreground runtime in a shell session as work', () => {
    const quiet = ['developer@workstation:/srv/code/demo$ node scripts/long-task.mjs'];
    for (const [harness, shell] of [['shell', '/usr/bin/zsh'], [undefined, 'bash']] as const) {
      expect(detector.detectStatus(signals(quiet, 'node'), harness, { harnessCommand: shell }))
        .toMatchObject({ status: 'working', fallback: true, source: 'process' });
      expect(detector.detectStatus(signals(quiet, 'python3'), harness, { harnessCommand: shell }))
        .toMatchObject({ status: 'working', fallback: true, source: 'process' });
    }
  });

  it('keeps a shell session at its prompt idle', () => {
    expect(detector.detectStatus(signals(['developer@workstation:/srv/code/demo$'], 'zsh'), 'shell', { harnessCommand: '/usr/bin/zsh' }))
      .toMatchObject({ status: 'idle', matchedRule: { harness: 'generic' } });
    expect(detector.detectStatus(signals(['text the rules do not recognize'], 'zsh'), 'shell', { harnessCommand: '/usr/bin/zsh' }))
      .toMatchObject({ status: 'idle', fallback: true });
  });

  it('still treats node as the harness process for Claude and Codex', () => {
    const quiet = ['text the rules do not recognize'];
    expect(detector.detectStatus(signals(quiet, 'node'), 'claude', { harnessCommand: 'claude' }))
      .toMatchObject({ status: 'idle', fallback: true });
    expect(detector.detectStatus(signals(quiet, 'node'), 'codex', { harnessCommand: '/opt/bin/codex' }))
      .toMatchObject({ status: 'idle', fallback: true });
    expect(detector.detectStatus(signals(quiet, 'pnpm'), 'codex', { harnessCommand: '/opt/bin/codex' }))
      .toMatchObject({ status: 'working', fallback: true });
  });

  it('keeps a real eight-option Codex questionnaire inside the window although its header is not', () => {
    const adapter = detector.getAdapter('codex');
    const window = adapter.evaluationWindow(capture('codex-long-questionnaire'), getFactoryStateRuleSet().rulesFor('codex'));
    expect(window.some((line) => line.includes('Question 1/1'))).toBe(false);
    expect(window.some((line) => /›\s*1\.\s+YAML/.test(line))).toBe(true);
    expect(window.at(-1)).toContain('enter to submit answer');
  });

  it('keeps Claude working while it waits to retry the API after an earlier completed turn', () => {
    const tail = [
      '✻ Baked for 50s · done 11:11 AM',
      ...capture('claude-api-retry'),
    ];
    const result = detector.detectStatus(signals(tail, 'claude'), 'claude');
    expect(result.status).toBe('working');
    expect(result.detectedPrompt).toContain('Waiting for API response');
  });

  it.each([
    '✻ Baked for 11s · done 11:09 AM · 1 shell still running',
    '✻ Brewed for 1m 3s · done 12:16 PM',
  ])('does not treat the completion marker %j as a status spinner', (marker) => {
    const result = detector.detectStatus(signals([
      marker,
      '────────────────────────',
      '❯ ',
      '────────────────────────',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ], 'claude'), 'claude');
    expect(result.status).toBe('idle');
    expect(result.detectedPrompt).toContain('· done');
  });
});
