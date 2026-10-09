import type { SessionSignals, SessionStatusResult } from '@spawnea/domain';
import type { HarnessStatusAdapter, HarnessStatusAdapterOptions } from './types.js';
import { GenericStatusAdapter } from './generic-adapter.js';
import { stripAnsi } from '../prompt-detector.js';
import type { PatternRule, RuleCategory } from '../rules/types.js';

const COMPLETION_LINE = /^\s*Worked for\s+\d[\d.smh ]*$/i;

/**
 * Blank viewport rows in the Grok TUI often keep a scrollbar block, so they
 * are not empty. They must not hide the turn-completion line above them.
 */
function isScrollbarRow(line: string): boolean {
  return /^█+$/.test(line.trim());
}

function isBoxChrome(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && /^[╭╮╰╯┌┐└┘─━│├┤┬┴┼]+$/.test(trimmed);
}

function isEmptyComposer(line: string): boolean {
  return /[│|]\s*[❯›>]\s*[│|]\s*$/.test(line.trim());
}

function isModelFooter(line: string): boolean {
  return /Grok\s+\d+(?:\.\d+)?\b/.test(line) && /[╭╮╰╯│─]/.test(line);
}

function isIdleShortcutBar(line: string): boolean {
  return /Shift\+Tab:\s*mode/i.test(line) && /shortcuts/i.test(line);
}

function isReadyChrome(line: string): boolean {
  return (
    isScrollbarRow(line) ||
    isBoxChrome(line) ||
    isEmptyComposer(line) ||
    isModelFooter(line) ||
    isIdleShortcutBar(line)
  );
}

function isWelcomeContent(line: string): boolean {
  const insidePanel = line.includes('│') || line.includes('|');
  const content = line.replace(/[│|]/g, '').trim();
  return /^[\u2800-\u28FF\s]+$/.test(content) ||
    /^[\u2800-\u28FF\s]*(?:Grok Build\s+\d|Grok\s+\d+(?:\.\d+)?\s+is here|Select ['"]Grok)/i.test(content) ||
    (insidePanel && /^(?:New worktree|Resume session|Changelog|Quit)\b/i.test(content)) ||
    /^Update: v/i.test(content);
}

function hasReadyComposer(lines: string[]): boolean {
  return lines.some((line) => isEmptyComposer(line) || isIdleShortcutBar(line) || isModelFooter(line));
}

function isQuestionCardLine(line: string): boolean {
  return (
    /Waiting on answers\b/i.test(line) ||
    /Tab:\s*next answer/i.test(line) ||
    /Enter:\s*submit/i.test(line) ||
    /Type your answer here/i.test(line) ||
    /↑\/↓\s*navigate/i.test(line) ||
    /\(\s*[○●]\s*\)/.test(line) ||
    /^\s*┃/.test(line)
  );
}

function isActiveWork(line: string): boolean {
  if (/Waiting on answers\b/i.test(line)) {
    return false;
  }
  return (
    /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s|$)/.test(line) ||
    /^\s*[◆●▶]\s+\S/.test(line) ||
    /\b(?:Running|Responding|Generating)\b/.test(line) ||
    /esc to interrupt|send a message to interrupt/i.test(line)
  );
}

/**
 * The question card replaces the ready composer at the bottom of the screen.
 * A card that has already scrolled above that composer is no longer current.
 */
function currentQuestionLine(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (isScrollbarRow(line)) {
      continue;
    }
    if (isIdleShortcutBar(line) || isEmptyComposer(line)) {
      return undefined;
    }
    if (/Tab:\s*next answer/i.test(line) || /Waiting on answers\b/i.test(line)) {
      const resumed = lines
        .slice(i + 1)
        .some((later) => !isScrollbarRow(later) && !isQuestionCardLine(later) && !isReadyChrome(later) && isActiveWork(later));
      if (resumed) {
        return undefined;
      }
      const waiting = lines
        .slice(Math.max(0, i - 40), i + 1)
        .reverse()
        .find((earlier) => /Waiting on answers\b/i.test(earlier));
      return (waiting ?? line).trim();
    }
  }
  return undefined;
}

export class GrokStatusAdapter implements HarnessStatusAdapter {
  readonly harnessId = 'grok';
  readonly displayName = 'Grok Status Adapter';
  private readonly generic = new GenericStatusAdapter();

  evaluateStatus(
    signals: SessionSignals,
    options: HarnessStatusAdapterOptions = {}
  ): SessionStatusResult {
    if (
      !signals.hostReachable ||
      !signals.tmuxSessionExists ||
      signals.paneDead ||
      signals.exitCode !== undefined
    ) {
      return this.generic.evaluateStatus(signals, options);
    }

    const customStatus = this.evaluateCustomRules(signals.tailLines || [], options.customRules);
    if (customStatus) {
      return customStatus;
    }

    const grokTail = this.evaluateTail(signals.tailLines || []);
    if (grokTail) {
      return grokTail;
    }

    return this.generic.evaluateStatus(signals, options);
  }

  /**
   * Caller rules keep the confidence and prompt they configure. Built-in Grok
   * states run only when none of those rules match.
   */
  private evaluateCustomRules(
    tailLines: string[],
    customRules: PatternRule[] | undefined
  ): SessionStatusResult | undefined {
    if (!customRules || customRules.length === 0) {
      return undefined;
    }

    const lines = tailLines
      .map((line) => stripAnsi(line).trimEnd())
      .filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return undefined;
    }

    const applicable = customRules.filter((rule) => {
      if (!rule.harness) {
        return true;
      }
      return rule.harness.toLowerCase() === this.harnessId;
    });
    const categories: RuleCategory[] = [
      'confirmation',
      'choice',
      'question',
      'working',
      'error',
      'idle_prompt',
      'shell_prompt',
    ];
    const combined = lines.join('\n');
    const lastLine = lines[lines.length - 1];

    for (const category of categories) {
      for (const rule of applicable) {
        if (rule.category !== category) {
          continue;
        }
        const reg = compileRulePattern(rule.pattern);
        if (!matchesPattern(reg, combined) && !matchesPattern(reg, lastLine)) {
          continue;
        }
        let promptLine = lastLine.trim();
        for (let i = lines.length - 1; i >= 0; i--) {
          if (matchesPattern(reg, lines[i])) {
            promptLine = lines[i].trim();
            break;
          }
        }
        return statusFromCategory(category, rule.confidence ?? 0.85, promptLine);
      }
    }

    return undefined;
  }

  private evaluateTail(tailLines: string[]): SessionStatusResult | undefined {
    const lines = tailLines
      .map((line) => stripAnsi(line).trimEnd())
      .filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return undefined;
    }

    const questionLine = currentQuestionLine(lines);
    if (questionLine) {
      return {
        status: 'needs_input',
        confidence: 0.97,
        source: 'terminal_prompt',
        detectedPrompt: questionLine,
        reason: `Grok is waiting for an answer: ${questionLine}`,
        updatedAt: new Date(),
      };
    }

    if (!hasReadyComposer(lines)) {
      return undefined;
    }

    let lastCompletion = -1;
    for (let i = 0; i < lines.length; i++) {
      if (COMPLETION_LINE.test(lines[i].trim())) {
        lastCompletion = i;
      }
    }

    const afterCompletion = lastCompletion >= 0 ? lines.slice(lastCompletion + 1) : lines;
    const substantive = afterCompletion.filter((line) => !isReadyChrome(line));
    if (substantive.some((line) => isActiveWork(line))) {
      const activeLine = [...substantive].reverse().find((line) => isActiveWork(line)) ?? substantive.at(-1);
      return {
        status: 'working',
        confidence: 0.95,
        source: 'terminal_prompt',
        detectedPrompt: activeLine,
        reason: `Grok turn still active: ${activeLine}`,
        updatedAt: new Date(),
      };
    }

    // The TUI repaints the whole screen while idle, so recent PTY bytes are not
    // evidence of work once the ready composer is the latest content.
    const welcomeScreen = lastCompletion < 0 &&
      substantive.some((line) => /Grok Build\s+\d/i.test(line)) &&
      substantive.every(isWelcomeContent);
    if ((substantive.length === 0 || welcomeScreen) &&
      (lastCompletion >= 0 || afterCompletion.some((line) => isIdleShortcutBar(line) || isEmptyComposer(line)))) {
      const completionLine = lastCompletion >= 0 ? lines[lastCompletion].trim() : undefined;
      return {
        status: 'idle',
        confidence: completionLine ? 0.96 : 0.9,
        source: 'terminal_prompt',
        detectedPrompt: completionLine ?? afterCompletion.find((line) => isIdleShortcutBar(line) || isEmptyComposer(line)),
        reason: completionLine
          ? `Grok turn finished: ${completionLine}`
          : 'Grok ready composer is waiting for input',
        updatedAt: new Date(),
      };
    }

    return undefined;
  }
}

function compileRulePattern(pattern: PatternRule['pattern']): RegExp {
  if (typeof pattern === 'string') {
    return new RegExp(pattern, 'i');
  }
  // Global and sticky flags advance lastIndex, so a later line can miss.
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
}

function matchesPattern(reg: RegExp, value: string): boolean {
  reg.lastIndex = 0;
  return reg.test(value);
}

function statusFromCategory(
  category: RuleCategory,
  confidence: number,
  promptLine: string
): SessionStatusResult {
  if (category === 'confirmation' || category === 'choice' || category === 'question') {
    return {
      status: 'needs_input',
      confidence,
      source: 'terminal_prompt',
      detectedPrompt: promptLine,
      reason: `Terminal prompt requires user input: ${promptLine}`,
      updatedAt: new Date(),
    };
  }
  if (category === 'working') {
    return {
      status: 'working',
      confidence,
      source: 'terminal_prompt',
      detectedPrompt: promptLine,
      reason: `Active work in progress: ${promptLine}`,
      updatedAt: new Date(),
    };
  }
  if (category === 'error') {
    return {
      status: 'error',
      confidence,
      source: 'terminal_prompt',
      detectedPrompt: promptLine,
      reason: `Execution error detected in terminal: ${promptLine}`,
      updatedAt: new Date(),
    };
  }
  return {
    status: 'idle',
    confidence,
    source: 'terminal_prompt',
    detectedPrompt: promptLine,
    reason: `Agent prompt ready/idle: ${promptLine}`,
    updatedAt: new Date(),
  };
}
