import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import type { Node } from 'yaml';
import type {
  SessionStatus,
  StateRuleFile,
  StateRuleReference,
  StateRulesConfigSource,
  StateRulesError,
} from '@spawnea/domain';
import { canonicalHarnessId, resolveKnownHarnessId } from '../harness-ids.js';

/** States a rule can report. Connection and process states are decided before rules run. */
export const RULE_STATES = ['working', 'needs_input', 'idle', 'error'] as const;
export type RuleState = (typeof RULE_STATES)[number] & SessionStatus;

/** Harness whose rules apply to sessions without a harness of their own. */
export const GENERIC_HARNESS = 'generic';

/**
 * Patterns are JavaScript regular expressions compiled case-insensitive and
 * multiline: `^` and `$` match at every line of the window.
 */
export const RULE_PATTERN_FLAGS = 'im';

export interface CompiledStateRule {
  state: RuleState;
  patterns: RegExp[];
  ref: StateRuleReference;
}

export type CompiledStateRules = ReadonlyMap<string, readonly CompiledStateRule[]>;

export interface StateRuleMatch {
  rule: CompiledStateRule;
  pattern: RegExp;
  /** The window line that best represents the match. */
  line: string;
}

export class StateRulesConfigError extends Error {
  constructor(readonly detail: StateRulesError) {
    super(formatStateRulesError(detail));
    this.name = 'StateRulesConfigError';
  }
}

export function formatStateRulesError(error: StateRulesError): string {
  const location = [
    error.file,
    error.harness ? `harness "${error.harness}"` : undefined,
    error.position !== undefined ? `rule ${error.position}` : undefined,
    error.line !== undefined ? `line ${error.line}` : undefined,
  ].filter(Boolean).join(', ');
  return `${location}: ${error.message}`;
}

const TOP_LEVEL_KEYS = new Set(['version', 'harnesses']);
const HARNESS_KEYS = new Set(['rules']);
const RULE_KEYS = new Set(['state', 'patterns']);

function isExtensionKey(key: string): boolean {
  return key.startsWith('x-');
}

/**
 * Parses, validates, and compiles a state-rules YAML document.
 * Throws StateRulesConfigError with the file, harness, and rule position of
 * the first problem found.
 */
export function parseStateRules(text: string, fileName: string, file: StateRuleFile): CompiledStateRules {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true });
  const fail = (message: string, extra: Partial<StateRulesError> = {}, node?: unknown): never => {
    const range = (node as Node | undefined)?.range;
    const line = extra.line ?? (range ? lineCounter.linePos(range[0]).line : undefined);
    const { line: _ignored, ...location } = extra;
    throw new StateRulesConfigError({ file: fileName, message, ...location, ...(line !== undefined ? { line } : {}) });
  };

  if (doc.errors.length > 0) {
    const error = doc.errors[0];
    fail(`Invalid YAML: ${error.message.split('\n')[0]}`, { line: error.linePos?.[0]?.line });
  }

  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 1000 });
  } catch (error) {
    fail(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(data)) {
    fail('Expected a mapping with a "harnesses" key', {}, doc.contents);
  }
  const root = data as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL_KEYS.has(key) && !isExtensionKey(key)) {
      fail(`Unknown top-level key "${key}"`, {}, doc.getIn([key], true) ?? doc.contents);
    }
  }
  if (root.version !== undefined && root.version !== 1) {
    fail('Unsupported "version"; expected 1', {}, doc.getIn(['version'], true));
  }
  if (!isPlainObject(root.harnesses)) {
    fail('"harnesses" must be a mapping of harness names to rule lists', {}, doc.getIn(['harnesses'], true) ?? doc.contents);
  }

  const compiled = new Map<string, CompiledStateRule[]>();
  for (const [rawHarness, harnessValue] of Object.entries(root.harnesses as Record<string, unknown>)) {
    const harness = canonicalHarnessId(rawHarness);
    const harnessNode = doc.getIn(['harnesses', rawHarness], true);
    if (!harness) {
      fail('Harness names must not be empty', {}, harnessNode);
    }
    if (compiled.has(harness)) {
      fail(`Harness "${rawHarness}" is defined more than once`, { harness }, harnessNode);
    }
    if (!isPlainObject(harnessValue)) {
      fail('Expected a mapping with a "rules" list', { harness }, harnessNode);
    }
    const harnessObject = harnessValue as Record<string, unknown>;
    for (const key of Object.keys(harnessObject)) {
      if (!HARNESS_KEYS.has(key)) {
        fail(`Unknown key "${key}"; expected "rules"`, { harness }, harnessNode);
      }
    }
    const rules = harnessObject.rules;
    if (!Array.isArray(rules) || rules.length === 0) {
      fail('"rules" must be a non-empty list', { harness }, doc.getIn(['harnesses', rawHarness, 'rules'], true) ?? harnessNode);
    }

    const compiledRules: CompiledStateRule[] = [];
    (rules as unknown[]).forEach((rule, index) => {
      const position = index + 1;
      const ruleNode = resolveNode(doc, doc.getIn(['harnesses', rawHarness, 'rules', index], true));
      const at = { harness, position };
      if (!isPlainObject(rule)) {
        fail('Each rule must be a mapping with "state" and "patterns"', at, ruleNode);
      }
      const ruleObject = rule as Record<string, unknown>;
      for (const key of Object.keys(ruleObject)) {
        if (!RULE_KEYS.has(key)) {
          fail(`Unknown rule key "${key}"; expected "state" and "patterns"`, at, ruleNode);
        }
      }
      const state = ruleObject.state;
      if (typeof state !== 'string' || !(RULE_STATES as readonly string[]).includes(state)) {
        fail(`"state" must be one of ${RULE_STATES.join(', ')}`, at, ruleNode);
      }
      const patterns = ruleObject.patterns;
      if (!Array.isArray(patterns) || patterns.length === 0) {
        fail('"patterns" must be a non-empty list of regular expressions', at, ruleNode);
      }
      const regexes = (patterns as unknown[]).map((pattern, patternIndex) => {
        if (typeof pattern !== 'string' || pattern.length === 0) {
          return fail(`Pattern ${patternIndex + 1} must be a non-empty string`, at, ruleNode);
        }
        try {
          return new RegExp(pattern, RULE_PATTERN_FLAGS);
        } catch (error) {
          return fail(
            `Pattern ${patternIndex + 1} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
            at,
            ruleNode
          );
        }
      });
      compiledRules.push({ state: state as RuleState, patterns: regexes, ref: { file, harness, position } });
    });
    compiled.set(harness, compiledRules);
  }
  return compiled;
}

function resolveNode(doc: ReturnType<typeof parseDocument>, node: unknown): unknown {
  // Rules shared through YAML aliases report the location of the anchored rule.
  if (node && typeof (node as { resolve?: unknown }).resolve === 'function' && !isMap(node) && !isSeq(node) && !isScalar(node)) {
    return (node as { resolve: (d: unknown) => unknown }).resolve(doc) ?? node;
  }
  return node;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Combines user rules with factory rules. For each harness the user's rules
 * are evaluated before the factory's; a harness only the user defines is added.
 */
export function mergeStateRules(factory: CompiledStateRules, user: CompiledStateRules): CompiledStateRules {
  const merged = new Map<string, CompiledStateRule[]>();
  for (const [harness, rules] of factory) {
    merged.set(harness, [...(user.get(harness) ?? []), ...rules]);
  }
  for (const [harness, rules] of user) {
    if (!merged.has(harness)) {
      merged.set(harness, [...rules]);
    }
  }
  return merged;
}

/**
 * Evaluates rules in order against the window. The first rule with a pattern
 * that matches the window text wins.
 */
export function matchStateRules(rules: readonly CompiledStateRule[], windowLines: readonly string[]): StateRuleMatch | undefined {
  if (windowLines.length === 0) {
    return undefined;
  }
  const text = windowLines.join('\n');
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match) {
        return { rule, pattern, line: representativeLine(pattern, windowLines, text, match.index) };
      }
    }
  }
  return undefined;
}

/** True when a single line matches any pattern of the rule. */
export function ruleMatchesLine(rule: CompiledStateRule, line: string): boolean {
  return rule.patterns.some((pattern) => pattern.test(line));
}

function representativeLine(pattern: RegExp, lines: readonly string[], text: string, index: number): string {
  // Prefer the newest line that matches on its own; a multi-line pattern
  // reports the line where its match starts.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pattern.test(lines[i])) {
      return lines[i].trim();
    }
  }
  const first = text.slice(0, index).split('\n').length - 1;
  const last = first + (text.slice(index).match(pattern)?.[0] ?? '').split('\n').length - 1;
  // A multi-line match reports the line where it starts, unless that is a
  // prompt line above a menu; then the newest numbered selector is clearer.
  if (PROMPT_GLYPH_LINE.test(lines[first] ?? '') && !SELECTOR_LINE.test(lines[first] ?? '')) {
    for (let i = Math.min(last, lines.length - 1); i > first; i--) {
      if (SELECTOR_LINE.test(lines[i])) {
        return lines[i].trim();
      }
    }
  }
  return (lines[first] ?? lines[lines.length - 1]).trim();
}

const PROMPT_GLYPH_LINE = /^\s*[›❯>]/;
const SELECTOR_LINE = /^\s*[›❯>]\s*\d+\./;

/**
 * Compiled rules shared by every detector for one application run.
 */
export class StateRuleSet {
  constructor(
    private readonly rules: CompiledStateRules,
    readonly configSource: StateRulesConfigSource,
    readonly userError?: StateRulesError
  ) {}

  hasHarness(harness: string): boolean {
    return this.rules.has(harness);
  }

  /** Resolves the rule list key for a harness name or command, if rules exist for it. */
  resolveHarness(name: string | undefined): string | undefined {
    return resolveKnownHarnessId(name, (id) => this.rules.has(id));
  }

  /** Ordered rules for a harness; unknown harnesses use the generic rules. */
  rulesFor(harness: string | undefined): readonly CompiledStateRule[] {
    const key = harness ? canonicalHarnessId(harness) : GENERIC_HARNESS;
    return this.rules.get(key) ?? this.rules.get(GENERIC_HARNESS) ?? [];
  }

  harnesses(): string[] {
    return Array.from(this.rules.keys());
  }
}
