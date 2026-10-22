import { describe, expect, it } from 'vitest';
import type { SessionSignals } from '@spawnea/domain';
import { ClaudeStatusAdapter } from '../src/adapters/claude-adapter.js';
import { GrokStatusAdapter } from '../src/adapters/grok-adapter.js';
import type { RuleBasedStatusAdapter } from '../src/adapters/rule-based-adapter.js';
import { getFactoryStateRules, matchStateRules } from '../src/rules/index.js';

// Terminal output is untrusted. These inputs made the previous patterns
// backtrack polynomially: seconds each at these sizes, and four times longer
// for every doubling. Linear patterns finish in milliseconds. Each line ends
// in a visible character so trimming and box-chrome checks do not skip the
// pattern under test.
const LONG = 50_000;
const TIME_LIMIT_MS = 500;

function signals(tailLines: string[]): SessionSignals {
  return {
    sessionId: 'pathological',
    hostReachable: true,
    tmuxSessionExists: true,
    paneExists: true,
    paneDead: false,
    isPtyAttached: false,
    tailLines,
  };
}

function elapsedMs(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

const adapterCases: Array<[string, RuleBasedStatusAdapter, string]> = [
  ['Claude completion marker with a long whitespace run', new ClaudeStatusAdapter(), `✻\ta${' '.repeat(LONG)}!`],
  ['Grok line repeating the shortcut-bar mode hint', new GrokStatusAdapter(), 'shift+tab:mode'.repeat(LONG / 2)],
  ['Grok line repeating a box glyph', new GrokStatusAdapter(), `${'─'.repeat(LONG)}x`],
  ['Grok line with a long tab run before text', new GrokStatusAdapter(), `${'\t'.repeat(LONG)}x`],
];

describe('pathological terminal lines', () => {
  it.each(adapterCases)('%s finishes quickly', (_name, adapter, line) => {
    expect(elapsedMs(() => adapter.evaluateStatus(signals([line])))).toBeLessThan(TIME_LIMIT_MS);
  });

  it.each([
    ['claude', `✻\ta${' '.repeat(LONG)}`],
    ['grok', 'shift+tab:mode'.repeat(LONG / 2)],
  ])('factory %s rules finish quickly on the reported input', (harness, line) => {
    const rules = getFactoryStateRules().get(harness) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    expect(elapsedMs(() => matchStateRules(rules, [line]))).toBeLessThan(TIME_LIMIT_MS);
  });

  it('still recognizes the ready screens the rewritten patterns cover', () => {
    const claude = new ClaudeStatusAdapter().evaluateStatus(signals([
      '✻ Brewed  for 1m 5s · done',
      '────────',
      '❯',
      '────────',
    ]));
    expect(claude).toMatchObject({ status: 'idle', matchedRule: { file: 'factory', harness: 'claude' } });

    const grok = new GrokStatusAdapter().evaluateStatus(signals([
      '  Shift+Tab:mode  │  Ctrl+x:shortcuts   █',
    ]));
    expect(grok).toMatchObject({ status: 'idle', matchedRule: { file: 'factory', harness: 'grok' } });
  });
});
