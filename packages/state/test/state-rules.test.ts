import { describe, expect, it } from 'vitest';
import type { SessionSignals } from '@spawnea/domain';
import {
  formatStateRulesError,
  matchStateRules,
  mergeStateRules,
  parseStateRules,
  StateRulesConfigError,
} from '../src/rules/rule-config.js';
import { FACTORY_STATE_RULES_YAML, getFactoryStateRules } from '../src/rules/factory-rules.js';
import { loadStateRules } from '../src/rules/load-state-rules.js';
import { StateDetector } from '../src/state-detector.js';

function userRules(yaml: string) {
  return loadStateRules({ userFilePath: '/fictional/user-data/state-rules.yaml', readFile: () => yaml });
}

function parseError(yaml: string) {
  try {
    parseStateRules(yaml, 'state-rules.yaml', 'user');
  } catch (error) {
    expect(error).toBeInstanceOf(StateRulesConfigError);
    return (error as StateRulesConfigError).detail;
  }
  throw new Error('Expected the rules to be rejected');
}

function signals(tailLines: string[], overrides: Partial<SessionSignals> = {}): SessionSignals {
  return {
    sessionId: 'rules',
    hostReachable: true,
    tmuxSessionExists: true,
    paneExists: true,
    paneDead: false,
    isPtyAttached: false,
    tailLines,
    ...overrides,
  };
}

describe('factory state rules', () => {
  it('parse and cover every built-in harness', () => {
    const rules = parseStateRules(FACTORY_STATE_RULES_YAML, 'factory', 'factory');
    expect([...rules.keys()].sort()).toEqual(['antigravity', 'claude', 'codex', 'generic', 'grok', 'hermes']);
    expect(getFactoryStateRules().get('claude')?.every((rule) => rule.ref.file === 'factory')).toBe(true);
  });

  it('number reused generic rules by their position in each harness', () => {
    const claude = getFactoryStateRules().get('claude') ?? [];
    expect(claude.map((rule) => rule.ref.position)).toEqual(claude.map((_, index) => index + 1));
    expect(claude.every((rule) => rule.ref.harness === 'claude')).toBe(true);
  });
});

describe('state rule evaluation order', () => {
  it('lets the first matching rule win within one file', () => {
    const rules = parseStateRules(`
harnesses:
  generic:
    rules:
      - state: error
        patterns: ['build']
      - state: working
        patterns: ['build started']
`, 'state-rules.yaml', 'user').get('generic') ?? [];
    expect(matchStateRules(rules, ['build started'])?.rule.state).toBe('error');
    expect(matchStateRules(rules.slice().reverse(), ['build started'])?.rule.state).toBe('working');
  });

  it('evaluates user rules before factory rules for the same harness', () => {
    const { ruleSet, status } = userRules(`
harnesses:
  codex:
    rules:
      - state: working
        patterns: ['Ask Codex to do anything']
`);
    expect(status.source).toBe('merged');
    const result = new StateDetector({ rules: ruleSet }).detectStatus(signals(['› Ask Codex to do anything']), 'codex');
    expect(result).toMatchObject({ status: 'working', matchedRule: { file: 'user', harness: 'codex', position: 1 } });
    // Factory positions are unchanged by the user rules placed before them.
    const factory = new StateDetector().detectStatus(signals(['› Ask Codex to do anything']), 'codex');
    expect(ruleSet.rulesFor('codex')[1].ref).toEqual({ ...factory.matchedRule, file: 'factory', position: 1 });
  });

  it('falls through to factory rules when no user rule matches', () => {
    const { ruleSet } = userRules("harnesses:\n  codex:\n    rules:\n      - state: error\n        patterns: ['never shown']\n");
    const result = new StateDetector({ rules: ruleSet }).detectStatus(signals(['› Ask Codex to do anything']), 'codex');
    expect(result).toMatchObject({ status: 'idle', matchedRule: { file: 'factory', harness: 'codex' } });
  });

  it('adds a harness that only the user file defines', () => {
    const { ruleSet } = userRules("harnesses:\n  aider:\n    rules:\n      - state: idle\n        patterns: ['^aider>']\n");
    expect(mergeStateRules(getFactoryStateRules(), new Map()).has('aider')).toBe(false);
    const result = new StateDetector({ rules: ruleSet }).detectStatus(signals(['aider> ']), 'aider');
    expect(result).toMatchObject({ status: 'idle', matchedRule: { file: 'user', harness: 'aider', position: 1 } });
  });

  it('resolves harness aliases in user files', () => {
    const { ruleSet } = userRules("harnesses:\n  agy:\n    rules:\n      - state: needs_input\n        patterns: ['Custom review gate']\n");
    const result = new StateDetector({ rules: ruleSet }).detectStatus(signals(['Custom review gate']), 'agy');
    expect(result.matchedRule).toEqual({ file: 'user', harness: 'antigravity', position: 1 });
  });

  it('supports extension keys and YAML aliases for shared rules', () => {
    const rules = parseStateRules(`
x-shared:
  gate: &gate
    state: needs_input
    patterns: ['approval gate']
harnesses:
  claude:
    rules: [*gate]
  codex:
    rules: [*gate]
`, 'state-rules.yaml', 'user');
    expect(rules.get('codex')?.[0].ref).toEqual({ file: 'user', harness: 'codex', position: 1 });
  });
});

describe('state rule validation', () => {
  it('reports YAML syntax errors with their line', () => {
    expect(parseError('harnesses:\n  claude:\n    rules: [\n')).toMatchObject({ file: 'state-rules.yaml', line: expect.any(Number) });
  });

  it.each([
    ['an unknown top-level key', 'harness:\n  claude: {}\n', { message: expect.stringContaining('Unknown top-level key "harness"') }],
    ['an unsupported version', 'version: 2\nharnesses: {}\n', { message: expect.stringContaining('version') }],
    ['a harness without rules', 'harnesses:\n  claude:\n    rules: []\n', { harness: 'claude', message: expect.stringContaining('non-empty') }],
    ['an unknown harness key', 'harnesses:\n  claude:\n    rule: []\n', { harness: 'claude' }],
    ['an unknown state', "harnesses:\n  claude:\n    rules:\n      - state: idle\n        patterns: ['a']\n      - state: busy\n        patterns: ['b']\n", { harness: 'claude', position: 2, line: 6 }],
    ['an unknown rule key', "harnesses:\n  claude:\n    rules:\n      - state: idle\n        pattern: ['a']\n", { harness: 'claude', position: 1 }],
    ['empty patterns', 'harnesses:\n  claude:\n    rules:\n      - state: idle\n        patterns: []\n', { harness: 'claude', position: 1 }],
    ['an invalid regular expression', "harnesses:\n  hermes:\n    rules:\n      - state: idle\n        patterns: ['ok', '(unclosed']\n", { harness: 'hermes', position: 1, message: expect.stringContaining('Pattern 2') }],
    ['a harness defined twice through an alias', "harnesses:\n  agy:\n    rules:\n      - state: idle\n        patterns: ['a']\n  antigravity:\n    rules:\n      - state: idle\n        patterns: ['b']\n", { harness: 'antigravity' }],
  ])('rejects %s', (_label, yaml, expected) => {
    expect(parseError(yaml)).toMatchObject(expected);
  });

  it('formats the file, harness, rule position, and line', () => {
    expect(formatStateRulesError({ file: 'state-rules.yaml', harness: 'claude', position: 2, line: 6, message: 'Bad state' }))
      .toBe('state-rules.yaml, harness "claude", rule 2, line 6: Bad state');
  });

  it('ignores an invalid user file completely and keeps the factory rules', () => {
    const { ruleSet, status } = userRules("harnesses:\n  codex:\n    rules:\n      - state: working\n        patterns: ['Ask Codex']\n      - state: nope\n        patterns: ['x']\n");
    expect(status).toMatchObject({ source: 'user_invalid', error: { harness: 'codex', position: 2 } });
    expect(ruleSet.configSource).toBe('user_invalid');
    const result = new StateDetector({ rules: ruleSet }).detectStatus(signals(['› Ask Codex to do anything']), 'codex');
    expect(result).toMatchObject({ status: 'idle', matchedRule: { file: 'factory' } });
  });

  it('uses only the factory rules when the user file is missing', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const { status, ruleSet } = loadStateRules({ userFilePath: '/fictional/state-rules.yaml', readFile: () => { throw missing; } });
    expect(status).toEqual({ source: 'factory', userFilePath: '/fictional/state-rules.yaml' });
    expect(ruleSet.configSource).toBe('factory');
  });
});
