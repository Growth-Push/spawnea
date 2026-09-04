import type {
  SessionSignals,
  SessionStatusResult,
} from '@spawnea/domain';
import type {
  HarnessStatusAdapter,
  HarnessStatusAdapterOptions,
} from './types.js';
import { detectPromptInTail, stripAnsi } from '../prompt-detector.js';
import { DEFAULT_PATTERN_RULES } from '../rules/default-rules.js';

export class HermesStatusAdapter implements HarnessStatusAdapter {
  readonly harnessId = 'hermes';
  readonly displayName = 'Hermes Agent Adapter';

  evaluateStatus(
    signals: SessionSignals,
    options: HarnessStatusAdapterOptions = {}
  ): SessionStatusResult {
    const now = Date.now();
    const activeOutputWindowMs = options.activeOutputWindowMs || 3000;

    // 1. Host unreachable -> disconnected
    if (!signals.hostReachable) {
      return {
        status: 'disconnected',
        confidence: 1.0,
        source: 'tmux',
        reason: 'Remote host is unreachable',
        updatedAt: new Date(),
      };
    }

    // If host is reachable but tmux session does not exist, session has ended/stopped
    if (!signals.tmuxSessionExists) {
      return {
        status: 'done',
        confidence: 1.0,
        source: 'tmux',
        reason: 'Persistent tmux session has ended or was terminated on host',
        updatedAt: new Date(),
      };
    }

    // 2. Process exit / pane dead
    if (signals.paneDead || signals.exitCode !== undefined) {
      if (signals.exitCode === 0) {
        return {
          status: 'done',
          confidence: 1.0,
          source: 'process_exit',
          reason: 'Process completed with exit code 0',
          updatedAt: new Date(),
        };
      }
      return {
        status: 'error',
        confidence: 1.0,
        source: 'process_exit',
        reason:
          signals.exitCode !== undefined
            ? `Process exited with error code ${signals.exitCode}`
            : 'Pane is dead / terminated unexpectedly',
        updatedAt: new Date(),
      };
    }

    // 3. Terminal tail heuristics (capture-pane inspection) - Primary real-time source
    const tailLines = signals.tailLines || [];
    if (tailLines.length > 0) {
      const promptResult = detectPromptInTail(tailLines, {
        harness: 'hermes',
        customRules: options.customRules,
        tailLinesCount: 20,
      });

      // A. NEEDS_INPUT: Choice selection / questionnaire / prompt
      // If a consultation question header was matched, check whether lines after the question
      // contain a user response, active working/error output, or a completed turn.
      let effectivePromptResult = promptResult;
      const inspectedTailLines = tailLines
        .map((line) => stripAnsi(line).trimEnd())
        .filter((line) => line.trim().length > 0)
        .slice(-20);
      const questionRegex = /(?:^|\n)\s*[❓❔]\s*(?:Q\d+|QN\d+|Pregunta\s*\d+|Question\s*\d+)\s*[-—:]?\s*.+/i;
      // A generic rule (for example, "continue?") can match the user's echoed answer
      // before the consultation-header rule gets a chance to classify the tail.
      if (
        promptResult.matchedRuleId === 'hermes-question-header' ||
        inspectedTailLines.some((line) => questionRegex.test(line))
      ) {
        const reversedQuestionOffset = [...inspectedTailLines].reverse().findIndex((line) => questionRegex.test(line));
        const lastQuestionIndex =
          reversedQuestionOffset === -1 ? -1 : inspectedTailLines.length - 1 - reversedQuestionOffset;

        if (lastQuestionIndex >= 0 && lastQuestionIndex < inspectedTailLines.length - 1) {
          const linesAfterQuestion = inspectedTailLines.slice(lastQuestionIndex + 1);
          const hasSubsequentUserTurn = linesAfterQuestion.some((l) => {
            const trimmed = l.trim();
            return /^(?:User answered:|[a-zA-Z0-9_.\-/]+\s*>\s*[^\s])/i.test(trimmed);
          });

          // Check lines after the question chronologically from newest to oldest
          const applicableRules = [
            ...(options.customRules || []),
            ...DEFAULT_PATTERN_RULES,
          ].filter((r) => !r.harness || r.harness.toLowerCase() === 'hermes');

          let newestMatch: { rule: (typeof applicableRules)[0]; line: string } | undefined;
          for (let i = linesAfterQuestion.length - 1; i >= 0; i--) {
            const line = linesAfterQuestion[i].trim();
            if (!line) continue;
            // A user-submitted turn echo should not be matched as any prompt or rule
            const isUserTurnLine = /^(?:User answered:|[a-zA-Z0-9_.\-/]+\s*>\s*[^\s])/i.test(line);
            if (isUserTurnLine) continue;

            for (const rule of applicableRules) {
              // Ignore the old question header rule itself
              if (rule.id === 'hermes-question-header') continue;
              const reg = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'i') : rule.pattern;
              if (reg.test(line)) {
                newestMatch = { rule, line };
                break;
              }
            }
            if (newestMatch) break;
          }

          if (newestMatch) {
            const cat = newestMatch.rule.category;
            if (cat === 'working' || cat === 'error') {
              effectivePromptResult = {
                isPrompt: false,
                kind: cat,
                promptLine: newestMatch.line,
                matchedRuleId: newestMatch.rule.id,
                confidence: newestMatch.rule.confidence ?? 0.95,
              };
            } else if (cat === 'choice' || cat === 'question' || cat === 'confirmation') {
              effectivePromptResult = {
                isPrompt: true,
                kind: cat,
                promptLine: newestMatch.line,
                matchedRuleId: newestMatch.rule.id,
                confidence: newestMatch.rule.confidence ?? 0.95,
              };
            } else if ((cat === 'idle_prompt' || cat === 'shell_prompt') && hasSubsequentUserTurn) {
              effectivePromptResult = {
                isPrompt: true,
                kind: cat,
                promptLine: newestMatch.line,
                matchedRuleId: newestMatch.rule.id,
                confidence: newestMatch.rule.confidence ?? 0.95,
              };
            } else if (hasSubsequentUserTurn) {
              effectivePromptResult = { isPrompt: false, kind: 'none' };
            }
          } else if (hasSubsequentUserTurn) {
            // The user has responded, but no specific prompt pattern is matched yet (e.g. active streaming output).
            // Clear the stale question to allow PTY activity or quiet fallback to take effect.
            effectivePromptResult = { isPrompt: false, kind: 'none' };
          }
        }
      }

      if (
        effectivePromptResult.kind === 'choice' ||
        effectivePromptResult.kind === 'question' ||
        effectivePromptResult.kind === 'confirmation'
      ) {
        return {
          status: 'needs_input',
          confidence: effectivePromptResult.confidence ?? 0.98,
          source: 'terminal_prompt',
          detectedPrompt: effectivePromptResult.promptLine,
          reason: `Hermes interactive input requested: ${effectivePromptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }

      // B. WORKING: Active progress verbs or interrupt footer bar (msg=interrupt)
      if (effectivePromptResult.kind === 'working') {
        return {
          status: 'working',
          confidence: effectivePromptResult.confidence ?? 0.95,
          source: 'terminal_prompt',
          detectedPrompt: effectivePromptResult.promptLine,
          reason: `Hermes active execution in progress: ${effectivePromptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }

      // C. IDLE: Ready prompt or completed turn metrics checkmark (✓ 4m)
      if (effectivePromptResult.kind === 'idle_prompt' || effectivePromptResult.kind === 'shell_prompt') {
        return {
          status: 'idle',
          confidence: effectivePromptResult.confidence ?? 0.95,
          source: 'terminal_prompt',
          detectedPrompt: effectivePromptResult.promptLine,
          reason: `Hermes turn complete / idle prompt ready: ${effectivePromptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }

      // D. ERROR: Fatal execution error
      if (effectivePromptResult.kind === 'error') {
        return {
          status: 'error',
          confidence: effectivePromptResult.confidence ?? 0.85,
          source: 'terminal_prompt',
          detectedPrompt: effectivePromptResult.promptLine,
          reason: `Execution error detected in Hermes terminal: ${effectivePromptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }
    }

    // 4. Active PTY streaming
    const msSinceOutput = signals.lastOutputAt ? now - signals.lastOutputAt.getTime() : Infinity;
    const isActivelyStreaming =
      signals.lastOutputAt !== undefined && msSinceOutput <= activeOutputWindowMs;

    if (isActivelyStreaming) {
      return {
        status: 'working',
        confidence: 0.75,
        source: 'pty_activity',
        reason: `Active PTY output (${signals.recentOutputBytes || 0} bytes recently)`,
        updatedAt: new Date(),
      };
    }

    // 8. Foreground command / quiet fallback for Hermes agent
    // Since Hermes runs persistently as 'python3' or 'hermes', when PTY is quiet and attached,
    // default state is idle waiting for user input.
    const cmd = (signals.paneCurrentCommand || '').toLowerCase();
    const isShell = cmd === 'bash' || cmd === 'zsh' || cmd === 'sh' || cmd === 'fish' || cmd === 'tmux';

    if (isShell) {
      return {
        status: 'idle',
        confidence: 0.7,
        source: 'tmux',
        reason: `Shell '${signals.paneCurrentCommand}' is active at prompt`,
        updatedAt: new Date(),
      };
    }

    return {
      status: signals.isPtyAttached ? 'idle' : 'disconnected',
      confidence: 0.65,
      source: 'tmux',
      reason: signals.isPtyAttached
        ? 'Hermes session is quiet and waiting for input'
        : 'Hermes session is detached',
      updatedAt: new Date(),
    };
  }
}
