import type { PatternRule, RuleCategory } from './rules/types.js';
import { DEFAULT_PATTERN_RULES } from './rules/default-rules.js';

/**
 * ANSI escape sequence regex matching standard VT100/xterm control codes.
 */
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * Strips ANSI escape sequences and normalizes terminal line content.
 */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

export type PromptKind = RuleCategory | 'none';

export interface PromptDetectionResult {
  isPrompt: boolean;
  kind: PromptKind;
  promptLine?: string;
  matchedRuleId?: string;
  matchedPattern?: string;
  confidence?: number;
}

export interface PromptDetectorOptions {
  harness?: string;
  customRules?: PatternRule[];
  tailLinesCount?: number;
}

const HERMES_MENU = /Hermes(?:\s+Agent)?\s+needs your input|to select,\s*Enter to (?:confirm|lock)|Tab next question/i;
const HERMES_PROGRESS = /\b(?:formulating|pondering|reviewing|searching|executing|synthesizing|generating)\.{2,3}/i;
const HERMES_INTERRUPT = /msg=interrupt|\/steer|\/queue|Ctrl\+C cancel/i;
const HERMES_STOPWATCH = /[|│]\s*⏱\s*\d+/;
const HERMES_QUESTION_PROMPT = /^\s*\?\s*[>❯›][^a-zA-Z0-9]*$/;
const HERMES_IDLE_CHECK = /^\s*⚕[^\n]*[|│]\s*✓\s*\d+(?:ms|[smh])(?:\s|$)/i;

/**
 * A Hermes choice footer stays in the scrollback after the menu closes.
 * A later progress verb, interrupt footer, or completion checkmark is the
 * current turn. The stopwatch painted under an open menu is not.
 */
function statusAfterHermesMenu(lines: string[]): PromptDetectionResult | undefined {
  let footer = -1;
  for (let i = 0; i < lines.length; i++) {
    if (HERMES_MENU.test(lines[i])) {
      footer = i;
    }
  }
  if (footer < 0) {
    return undefined;
  }

  for (let i = lines.length - 1; i > footer; i--) {
    const line = lines[i].trim();
    if (!line || HERMES_QUESTION_PROMPT.test(line)) {
      continue;
    }
    if (HERMES_STOPWATCH.test(line) && !HERMES_INTERRUPT.test(line)) {
      continue;
    }
    if (HERMES_PROGRESS.test(line)) {
      return {
        isPrompt: false,
        kind: 'working',
        promptLine: line,
        matchedRuleId: 'hermes-working-progress-verbs',
        matchedPattern: HERMES_PROGRESS.source,
        confidence: 0.95,
      };
    }
    if (HERMES_INTERRUPT.test(line)) {
      return {
        isPrompt: false,
        kind: 'working',
        promptLine: line,
        matchedRuleId: 'hermes-working-footer',
        matchedPattern: HERMES_INTERRUPT.source,
        confidence: 0.98,
      };
    }
    if (HERMES_IDLE_CHECK.test(line)) {
      return {
        isPrompt: true,
        kind: 'idle_prompt',
        promptLine: line,
        matchedRuleId: 'hermes-idle-completion-checkmark',
        matchedPattern: HERMES_IDLE_CHECK.source,
        confidence: 0.98,
      };
    }
  }

  return undefined;
}

/**
 * Detects interactive prompts, choice menus, questions, idle prompts, or errors in terminal tail lines.
 */
export function detectPromptInTail(
  tailLines: string[],
  options: PromptDetectorOptions = {}
): PromptDetectionResult {
  if (!tailLines || tailLines.length === 0) {
    return { isPrompt: false, kind: 'none' };
  }

  // Clean lines: strip ANSI and trim trailing whitespace
  const cleaned = tailLines.map((l) => stripAnsi(l).trimEnd());
  const nonEmptyLines = cleaned.filter((l) => l.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    return { isPrompt: false, kind: 'none' };
  }

  // Combine up to the last 15 lines so multi-line option menus and questions are fully visible
  const inspectionLinesCount = options.tailLinesCount || 15;
  const recentLines = nonEmptyLines.slice(-inspectionLinesCount);

  // Filter rules by harness if specified (keep rules that match this harness or generic rules)
  const targetHarness = options.harness?.toLowerCase() === 'agy' ? 'antigravity' : options.harness?.toLowerCase();

  // For Codex, if a completion marker ('Worked for ...') is present in the tail,
  // ignore historical prompts that occurred before the completion marker.
  let effectiveTailLines = recentLines;
  if (targetHarness === 'codex') {
    const completionPattern = /(?:^\s*─\s+Worked for\b|Worked for \d+(?:\.\d+)?(?:s|m|h))/i;
    const lastCompIdx = [...recentLines].reverse().findIndex((l) => completionPattern.test(l));
    if (lastCompIdx !== -1) {
      const compIdx = recentLines.length - 1 - lastCompIdx;
      const linesAfter = recentLines.slice(compIdx + 1);
      effectiveTailLines = linesAfter.length > 0 ? linesAfter : [recentLines[compIdx]];
    }
  }

  const lastLine = effectiveTailLines[effectiveTailLines.length - 1];
  const combinedTail = effectiveTailLines.join('\n');

  const rules: PatternRule[] = [
    ...(options.customRules || []),
    ...DEFAULT_PATTERN_RULES,
  ];

  const applicableRules = rules.filter((rule) => {
    if (!rule.harness) return true;
    if (!targetHarness) return true;
    const ruleHarness = rule.harness.toLowerCase();
    return ruleHarness === targetHarness;
  });

  function findPromptLine(rule: PatternRule, category: RuleCategory, reg: RegExp): string {
    let promptLine = lastLine.trim();
    for (let i = effectiveTailLines.length - 1; i >= 0; i--) {
      const line = effectiveTailLines[i].trim();
      if (rule.id === 'codex-questionnaire') {
        if (line.startsWith('Question')) {
          return line;
        }
        continue;
      }
      if (
        reg.test(line) ||
        (category === 'choice' && (
          line.startsWith('Question') ||
          (line.startsWith('>') && !line.startsWith('>_')) ||
          line.startsWith('›') ||
          line.startsWith('❯') ||
          line.startsWith('1.')
        )) ||
        (category === 'question' && (
          line.startsWith('?') ||
          line.endsWith('?') ||
          (rule.id === 'hermes-question-header' && (line.includes('❓') || line.includes('❔')))
        )) ||
        (category === 'confirmation' && (
          line.startsWith('Requesting') ||
          line.startsWith('Do you') ||
          line.startsWith('Accept') ||
          line.startsWith('Allow') ||
          line.includes('?') ||
          /\[[yY]\/[nN]\]|\([yY]\/[nN]\)/i.test(line)
        ))
      ) {
        return line;
      }
    }
    return promptLine;
  }

  // Evaluate interactive prompts first: confirmation -> choice -> question
  const interactiveCategories: RuleCategory[] = ['confirmation', 'choice', 'question'];
  for (const category of interactiveCategories) {
    const categoryRules = applicableRules.filter((r) => r.category === category);
    for (const rule of categoryRules) {
      const reg = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'i') : rule.pattern;
      if (reg.test(combinedTail) || reg.test(lastLine)) {
        if (rule.id === 'hermes-needs-input-menu') {
          const supersededMenu = statusAfterHermesMenu(effectiveTailLines);
          if (supersededMenu) {
            return supersededMenu;
          }
        }
        return {
          isPrompt: true,
          kind: category,
          promptLine: findPromptLine(rule, category, reg),
          matchedRuleId: rule.id,
          matchedPattern: reg.source,
          confidence: rule.confidence ?? 0.85,
        };
      }
    }
  }

  // An agent can report a failed background command and then continue the
  // task. Prefer that later live activity over the historical failure text.
  const toRegex = (pattern: string | RegExp) =>
    typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;

  const errorRulesWithRegex = applicableRules
    .filter((rule) => rule.category === 'error')
    .map((rule) => ({ rule, regex: toRegex(rule.pattern) }));
  const workingRulesWithRegex = applicableRules
    .filter((rule) => rule.category === 'working')
    .map((rule) => ({ rule, regex: toRegex(rule.pattern) }));
  const shellPromptRulesWithRegex = applicableRules
    .filter((rule) => rule.category === 'shell_prompt')
    .map((rule) => ({ rule, regex: toRegex(rule.pattern) }));
  const idlePromptRulesWithRegex = applicableRules
    .filter((rule) => rule.category === 'idle_prompt')
    .map((rule) => ({ rule, regex: toRegex(rule.pattern) }));

  let latestErrorIndex = -1;
  let latestWorkingIndex = -1;
  let latestWorkingRule: PatternRule | null = null;
  let latestShellPromptIndex = -1;
  let latestIdlePromptIndex = -1;
  for (let i = 0; i < effectiveTailLines.length; i++) {
    const line = effectiveTailLines[i];
    if (errorRulesWithRegex.some(({ regex }) => regex.test(line))) {
      latestErrorIndex = i;
    }
    const matchedWorking = workingRulesWithRegex.find(({ regex }) => regex.test(line));
    if (matchedWorking) {
      latestWorkingIndex = i;
      latestWorkingRule = matchedWorking.rule;
    }
    if (shellPromptRulesWithRegex.some(({ regex }) => regex.test(line))) {
      latestShellPromptIndex = i;
    }
    if (idlePromptRulesWithRegex.some(({ regex }) => regex.test(line))) {
      latestIdlePromptIndex = i;
    }
  }

  const activeWorkingFooterPattern =
    /\b(?:esc\s+to\s+(?:interrupt|cancel)|msg=interrupt|Ctrl\+C\s+cancel|auto\s+mode\s+on)\b/i;

  const isSpinnerSupersededByIdle = (rule: PatternRule) => {
    if (rule.id !== 'generic-agent-spinner-status') return false;
    if (latestIdlePromptIndex < 0 || latestWorkingIndex < 0) return false;
    if (latestIdlePromptIndex <= latestWorkingIndex) return false;
    for (let i = latestIdlePromptIndex; i < effectiveTailLines.length; i++) {
      if (activeWorkingFooterPattern.test(effectiveTailLines[i])) {
        return false;
      }
    }
    return true;
  };

  const isWorkingSuperseded =
    (latestErrorIndex >= 0 && latestErrorIndex > latestWorkingIndex) ||
    (latestShellPromptIndex >= 0 && latestShellPromptIndex > latestWorkingIndex);

  const isErrorSuperseded =
    latestShellPromptIndex >= 0 && latestShellPromptIndex > latestErrorIndex;

  if (
    !isWorkingSuperseded &&
    latestErrorIndex >= 0 &&
    latestWorkingIndex > latestErrorIndex &&
    latestWorkingRule &&
    !isSpinnerSupersededByIdle(latestWorkingRule)
  ) {
    return {
      isPrompt: false,
      kind: 'working',
      promptLine: effectiveTailLines[latestWorkingIndex].trim(),
      matchedRuleId: latestWorkingRule.id,
      matchedPattern: toRegex(latestWorkingRule.pattern).source,
      confidence: latestWorkingRule.confidence ?? 0.85,
    };
  }

  // Evaluate remaining non-interactive categories: working -> error -> idle_prompt -> shell_prompt
  const remainingCategories: RuleCategory[] = [
    'working',
    'error',
    'idle_prompt',
    'shell_prompt',
  ];

  for (const category of remainingCategories) {
    if (category === 'working' && isWorkingSuperseded) {
      continue;
    }
    if (category === 'error' && isErrorSuperseded) {
      continue;
    }
    const categoryRules = applicableRules.filter((r) => r.category === category);
    for (const rule of categoryRules) {
      if (category === 'working' && isSpinnerSupersededByIdle(rule)) {
        continue;
      }
      const reg = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'i') : rule.pattern;
      if (reg.test(combinedTail) || reg.test(lastLine)) {
        if (rule.id === 'hermes-needs-input-menu') {
          const supersededMenu = statusAfterHermesMenu(effectiveTailLines);
          if (supersededMenu) {
            return supersededMenu;
          }
        }
        return {
          isPrompt: category !== 'error' && category !== 'working',
          kind: category,
          promptLine: findPromptLine(rule, category, reg),
          matchedRuleId: rule.id,
          matchedPattern: reg.source,
          confidence: rule.confidence ?? 0.85,
        };
      }
    }
  }

  return { isPrompt: false, kind: 'none' };
}
