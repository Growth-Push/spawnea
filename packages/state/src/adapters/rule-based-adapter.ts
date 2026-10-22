import type { SessionSignals, SessionStatusResult } from '@spawnea/domain';
import { SHELL_COMMANDS } from '@spawnea/domain';
import type { CompiledStateRule, StateRuleMatch, StateRuleSet } from '../rules/rule-config.js';
import { GENERIC_HARNESS, matchStateRules, ruleMatchesLine } from '../rules/rule-config.js';
import { getFactoryStateRuleSet } from '../rules/factory-rules.js';
import { HARNESS_ALIASES } from '../harness-ids.js';
import { cleanTailLines } from '../terminal-lines.js';
import type { HarnessStatusAdapter, HarnessStatusAdapterOptions, LinePreparationContext } from './types.js';

/**
 * Number of non-blank lines, after the harness preparation step, that state
 * rules evaluate. Starting value under evaluation; see docs/state-rules.md.
 */
export const STATE_RULE_WINDOW_LINES = 10;

/** PTY output newer than this counts as activity in the fallback. */
export const DEFAULT_ACTIVE_OUTPUT_WINDOW_MS = 3000;

/** Interpreters that commonly host a harness process. */
const HARNESS_RUNTIME_COMMANDS = new Set(['node', 'python', 'python3', 'bun', 'deno']);
/** Some native installs name the process after its version, such as 2.1.4. */
const VERSION_PROCESS_NAME = /^\d+(?:\.\d+)+$/;

function isShellCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized === 'tmux' || SHELL_COMMANDS.has(normalized);
}

function commandBasename(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0] ?? '';
  return (firstToken.split(/[\\/]/).pop() ?? '').toLowerCase();
}

/** Short, stable digest of the evaluated window. The text itself is never exposed. */
export function windowFingerprint(lines: readonly string[]): string {
  let hash = 0x811c9dc5;
  const text = lines.join('\n');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${lines.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Connection and process states. These never use rules.
 */
export function connectionStatus(signals: SessionSignals): SessionStatusResult | undefined {
  if (!signals.hostReachable) {
    return { status: 'disconnected', confidence: 1.0, source: 'tmux', reason: 'Remote host is unreachable', updatedAt: new Date() };
  }
  if (!signals.tmuxSessionExists) {
    return {
      status: 'done',
      confidence: 1.0,
      source: 'tmux',
      reason: 'Persistent tmux session has ended or was terminated on host',
      updatedAt: new Date(),
    };
  }
  if (signals.paneDead || signals.exitCode !== undefined) {
    if (signals.exitCode === 0) {
      return { status: 'done', confidence: 1.0, source: 'process_exit', reason: 'Process completed with exit code 0', updatedAt: new Date() };
    }
    return {
      status: 'error',
      confidence: 1.0,
      source: 'process_exit',
      reason: signals.exitCode !== undefined
        ? `Process exited with error code ${signals.exitCode}`
        : 'Pane is dead / terminated unexpectedly',
      updatedAt: new Date(),
    };
  }
  return undefined;
}

/**
 * An error line followed by a line that matches a rule for another state is
 * historical. Otherwise the error is the newest evidence and older lines are
 * dropped.
 */
export function trimSupersededErrors(lines: string[], rules: readonly CompiledStateRule[]): string[] {
  const errorRules = rules.filter((rule) => rule.state === 'error');
  if (errorRules.length === 0) {
    return lines;
  }
  let errorIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (errorRules.some((rule) => ruleMatchesLine(rule, lines[i]))) {
      errorIndex = i;
    }
  }
  if (errorIndex < 0) {
    return lines;
  }
  const otherRules = rules.filter((rule) => rule.state !== 'error');
  const later = lines.slice(errorIndex + 1);
  return later.some((line) => otherRules.some((rule) => ruleMatchesLine(rule, line)))
    ? later
    : lines.slice(errorIndex);
}

/**
 * Decision order shared by every harness:
 * 1. connection and process state;
 * 2. the harness's ordered state rules over the evaluated window;
 * 3. fallback: recent PTY output or a foreground command other than the
 *    harness means working; otherwise idle.
 */
export abstract class RuleBasedStatusAdapter implements HarnessStatusAdapter {
  abstract readonly harnessId: string;
  abstract readonly displayName: string;

  /** Whether newer state evidence makes an earlier error line historical. */
  protected readonly trimsSupersededErrors: boolean = true;

  /**
   * Harness-specific context step. Returns the lines that can carry the
   * current status, oldest first. The default keeps every line.
   */
  prepareLines(lines: string[], _context: LinePreparationContext): string[] {
    return lines;
  }

  /** Builds the evaluated window from raw terminal tail lines. */
  evaluationWindow(tailLines: readonly string[], rules: readonly CompiledStateRule[]): string[] {
    const lines = cleanTailLines(tailLines);
    if (lines.length === 0) {
      return [];
    }
    const window = this.prepareLines(lines, { rules }).slice(-STATE_RULE_WINDOW_LINES);
    return this.trimsSupersededErrors ? trimSupersededErrors(window, rules) : window;
  }

  /** Reported prompt and reason for a rule match. */
  protected describeMatch(match: StateRuleMatch): { detectedPrompt: string; reason: string } {
    const { ref, state } = match.rule;
    return {
      detectedPrompt: match.line,
      reason: `${this.displayName}: ${state} by ${ref.file} rule ${ref.harness} #${ref.position}: ${match.line}`,
    };
  }

  evaluateStatus(signals: SessionSignals, options: HarnessStatusAdapterOptions = {}): SessionStatusResult {
    const connection = connectionStatus(signals);
    if (connection) {
      return connection;
    }

    const ruleSet: StateRuleSet = options.rules ?? getFactoryStateRuleSet();
    const ruleHarness = options.ruleHarness ?? this.harnessId;
    const rules = ruleSet.rulesFor(ruleHarness);
    const window = this.evaluationWindow(signals.tailLines ?? [], rules);
    const fingerprint = window.length > 0 ? windowFingerprint(window) : undefined;

    const match = matchStateRules(rules, window);
    if (match) {
      return {
        status: match.rule.state,
        confidence: 0.9,
        source: 'terminal_prompt',
        ...this.describeMatch(match),
        updatedAt: new Date(),
        matchedRule: match.rule.ref,
        windowFingerprint: fingerprint,
      };
    }

    return this.fallbackStatus(signals, options, ruleHarness, fingerprint);
  }

  private fallbackStatus(
    signals: SessionSignals,
    options: HarnessStatusAdapterOptions,
    ruleHarness: string,
    fingerprint: string | undefined
  ): SessionStatusResult {
    const activeOutputWindowMs = options.activeOutputWindowMs || DEFAULT_ACTIVE_OUTPUT_WINDOW_MS;
    const base = { fallback: true, windowFingerprint: fingerprint, updatedAt: new Date() };
    const msSinceOutput = signals.lastOutputAt ? Date.now() - signals.lastOutputAt.getTime() : Infinity;
    if (msSinceOutput <= activeOutputWindowMs) {
      return {
        ...base,
        status: 'working',
        confidence: 0.75,
        source: 'pty_activity',
        reason: `No state rule matched; active PTY output (${signals.recentOutputBytes || 0} bytes recently)`,
      };
    }

    const command = signals.paneCurrentCommand?.trim();
    if (command && !isShellCommand(command) && !this.isHarnessProcess(command, ruleHarness, options.harnessCommand)) {
      return {
        ...base,
        status: 'working',
        confidence: 0.65,
        source: 'process',
        reason: `No state rule matched; foreground command '${command}' is not the harness`,
      };
    }

    return {
      ...base,
      status: 'idle',
      confidence: 0.5,
      source: 'tmux',
      reason: 'No state rule matched and the terminal is quiet',
    };
  }

  /** True when the foreground command is the harness itself rather than a tool it started. */
  protected isHarnessProcess(command: string, ruleHarness: string, harnessCommand?: string): boolean {
    const name = commandBasename(command);
    const harnessIds = new Set([this.harnessId, ruleHarness].filter((id) => id !== GENERIC_HARNESS));
    const configured = harnessCommand ? commandBasename(harnessCommand) : undefined;
    if ((harnessIds.size === 0 && !configured) || (configured && isShellCommand(configured))) {
      // A shell session has no harness process: any non-shell command is work,
      // including node or python. Runtimes count as the harness only for agents.
      return false;
    }
    if (configured && name === configured) {
      return true;
    }
    if (harnessIds.has(name) || harnessIds.has(HARNESS_ALIASES.get(name) ?? '')) {
      return true;
    }
    return HARNESS_RUNTIME_COMMANDS.has(name) || VERSION_PROCESS_NAME.test(name);
  }
}
