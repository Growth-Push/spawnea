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
  const lastLine = recentLines[recentLines.length - 1];
  const combinedTail = recentLines.join('\n');

  const rules: PatternRule[] = [
    ...(options.customRules || []),
    ...DEFAULT_PATTERN_RULES,
  ];

  // Filter rules by harness if specified (keep rules that match this harness or generic rules)
  const targetHarness = options.harness?.toLowerCase() === 'agy' ? 'antigravity' : options.harness?.toLowerCase();
  const applicableRules = rules.filter((rule) => {
    if (!rule.harness) return true;
    if (!targetHarness) return true;
    const ruleHarness = rule.harness.toLowerCase();
    return ruleHarness === targetHarness;
  });

  // Evaluate in priority order: confirmation -> choice -> question -> working -> error -> idle_prompt -> shell_prompt
  const categoriesInPriority: RuleCategory[] = [
    'confirmation',
    'choice',
    'question',
    'working',
    'error',
    'idle_prompt',
    'shell_prompt',
  ];

  for (const category of categoriesInPriority) {
    const categoryRules = applicableRules.filter((r) => r.category === category);
    for (const rule of categoryRules) {
      const reg = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'i') : rule.pattern;
      if (reg.test(combinedTail) || reg.test(lastLine)) {
        // Find best representative prompt line
        let promptLine = lastLine.trim();
        for (let i = recentLines.length - 1; i >= 0; i--) {
          const line = recentLines[i].trim();
          if (
            reg.test(line) ||
            (category === 'choice' && (line.startsWith('Question') || line.startsWith('>') || line.startsWith('1.'))) ||
            (category === 'question' && (line.startsWith('?') || line.endsWith('?'))) ||
            (category === 'confirmation' && (
              line.startsWith('Requesting') ||
              line.startsWith('Do you') ||
              line.startsWith('Accept') ||
              line.startsWith('Allow') ||
              line.includes('?') ||
              /\[[yY]\/[nN]\]|\([yY]\/[nN]\)/i.test(line)
            ))
          ) {
            promptLine = line;
            break;
          }
        }

        return {
          isPrompt: category !== 'error' && category !== 'working',
          kind: category,
          promptLine,
          matchedRuleId: rule.id,
          matchedPattern: reg.source,
          confidence: rule.confidence ?? 0.85,
        };
      }
    }
  }

  return { isPrompt: false, kind: 'none' };
}
