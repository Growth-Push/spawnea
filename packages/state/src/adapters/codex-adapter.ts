import type {
  SessionSignals,
  SessionStatusResult,
} from '@spawnea/domain';
import type {
  HarnessStatusAdapter,
  HarnessStatusAdapterOptions,
} from './types.js';
import { detectPromptInTail, stripAnsi } from '../prompt-detector.js';

export class CodexStatusAdapter implements HarnessStatusAdapter {
  readonly harnessId = 'codex';
  readonly displayName = 'OpenAI Codex Adapter';

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
      const cleaned = tailLines.map((l) => stripAnsi(l).trimEnd());
      const nonEmptyLines = cleaned.filter((l) => l.trim().length > 0);
      const recentLines = nonEmptyLines.slice(-20);
      const combinedTail = recentLines.join('\n');

      const promptResult = detectPromptInTail(tailLines, {
        harness: 'codex',
        customRules: options.customRules,
        tailLinesCount: 20,
      });

      // A. NEEDS_INPUT: Interactive user prompt (e.g. [y/N], option choice, confirmation, tool approval, questionnaire)
      const hasBracketConfirm = /\[[yY]\/[nN]\]|\([yY]\/[nN]\)|\[yes\/no\]|\(yes\/no\)/i.test(combinedTail);
      const hasProceedConfirm = /(?:do you want to (?:continue|proceed|run|execute|apply)|proceed\?|confirm\?)/i.test(combinedTail);
      const hasOptionConfirm = /(?:Please confirm one option|Which should I proceed with|Choose one of the following)/i.test(combinedTail);
      const hasBulletOption = /-\s+[A-Z]:\s+[^\n]+\n\s*-\s+[A-Z]:/i.test(combinedTail);
      const hasToolApproval = /(?:Allow\s*\/\s*Deny|\[A\]llow\s*\/\s*\[D\]eny|❯\s*(?:Allow|Deny)|\bAllow\b[\s\S]*?\bDeny\b|tool\s+approval|approval\s+required|requesting\s+permission|permission\s+request)/i.test(combinedTail);
      const hasPlanConfirm = /(?:approve|confirm|proceed\s+with|accept|apply)\s+(?:the\s+|this\s+)?plan\b/i.test(combinedTail);
      const hasArrowMenu = /(?:^|\n)\s*❯\s+[^\n]+/i.test(combinedTail) && /(?:↑\/↓|arrow\s+keys?|enter\s+to\s+(?:select|confirm|submit)|to\s+navigate|\bAllow\b|\bDeny\b|\d+\.\s+)/i.test(combinedTail);
      const hasQuestionnaire = /Question\s+\d+\s*(?:\/|of)\s*\d+/i.test(combinedTail);

      if (
        hasBracketConfirm ||
        hasProceedConfirm ||
        hasOptionConfirm ||
        hasBulletOption ||
        hasToolApproval ||
        hasPlanConfirm ||
        hasArrowMenu ||
        hasQuestionnaire ||
        promptResult.kind === 'confirmation' ||
        promptResult.kind === 'choice' ||
        promptResult.kind === 'question'
      ) {
        let promptLine = promptResult.promptLine || nonEmptyLines[nonEmptyLines.length - 1];
        if (!promptResult.promptLine) {
          for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
            const l = nonEmptyLines[i].trim();
            if (/\[[yY]\/[nN]\]|proceed|confirm|option|Allow|Deny|plan|Question/i.test(l) || l.startsWith('-') || l.startsWith('❯')) {
              promptLine = l;
              break;
            }
          }
        }
        return {
          status: 'needs_input',
          confidence: promptResult.confidence ?? 0.95,
          source: 'terminal_prompt',
          detectedPrompt: promptLine,
          reason: `Codex terminal prompt requires user input: ${promptLine}`,
          updatedAt: new Date(),
        };
      }

      // B. WORKING: Active working indicator, 'esc to interrupt', Braille spinner, reasoning, or active progress
      // Matches:
      // - • Working (1m 02s • esc to interrupt)
      // - Working (30s)
      // - esc to interrupt / ctrl+c to cancel
      // - • Thinking, • Searching, • Running, • Reasoning, • Exploring, • Reading
      // - Braille / CLI spinners (⠋, ⠙, ⠹, etc. or [\u2800-\u28FF])
      // - Active reasoning headers (┌ Reasoning, Thinking..., etc.)
      const hasWorkingStatus = /(?:^|\n)\s*[•*·-]?\s*Working\b[^\n]*/i.test(combinedTail);
      const hasBrailleSpinner = /(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|[\u2800-\u28FF])/.test(combinedTail);
      const hasActiveProgressBullets = /(?:^|\n)\s*•\s*(?:Working|Thinking|Reasoning|Searching|Running|Executing|Exploring|Reading)\b[^\n]*/i.test(combinedTail);
      const hasReasoningHeader = /(?:^|\n)\s*(?:[┌╭•*·-]\s*|\b)(?:Reasoning|Thinking)\b[^\n]*/i.test(combinedTail);
      const hasCodexIdlePrompt =
        /(?:^[>›❯]\s*(?:Ask (?:Codex|anything)|Type|Send|What would you like|$)|Ask Codex to do anything)/im.test(combinedTail);
      const activeStatusPattern = /^\s*•\s*[^\n]*\besc\s+to\s+interrupt\b/i;
      const completionPattern = /(?:^\s*─\s+Worked for\b|Worked for \d+(?:\.\d+)?(?:s|m|h))/i;
      const lastActiveStatusIndex = [...recentLines].reverse().findIndex((line) => activeStatusPattern.test(line));
      const lastCompletionIndex = [...recentLines].reverse().findIndex((line) => completionPattern.test(line));
      const activeStatusIndex = lastActiveStatusIndex === -1 ? -1 : recentLines.length - 1 - lastActiveStatusIndex;
      const completionIndex = lastCompletionIndex === -1 ? -1 : recentLines.length - 1 - lastCompletionIndex;
      const hasRecentCompletion = completionIndex >= 0 && completionIndex > activeStatusIndex;
      const hasInterruptFooter = activeStatusIndex >= 0 && !hasRecentCompletion;

      // Codex keeps the ready prompt visible while showing the transcript from
      // the previous turn. A historical "Working" or "Reasoning" line must not keep the
      // session marked as working after Codex has returned to the input bar.
      // The interrupt footer/spinner are the stronger indicators that the
      // current turn is still active.
      const hasActiveWorkingStatus =
        !hasRecentCompletion &&
        (hasInterruptFooter ||
          hasBrailleSpinner ||
          ((!hasCodexIdlePrompt) && (hasWorkingStatus || hasActiveProgressBullets || hasReasoningHeader)));
      const idlePromptLine = [...nonEmptyLines].reverse().find((line) =>
        /(?:^[>›❯]\s*(?:Ask (?:Codex|anything)|Type|Send|What would you like|$)|Ask Codex to do anything)/i.test(line)
      );

      if (
        hasActiveWorkingStatus ||
        hasInterruptFooter ||
        hasBrailleSpinner ||
        ((hasActiveProgressBullets || hasReasoningHeader) && !hasCodexIdlePrompt) ||
        (promptResult.kind === 'working' && !hasCodexIdlePrompt)
      ) {
        let promptLine = promptResult.promptLine || 'Working...';
        if (!promptResult.promptLine || promptResult.kind !== 'working') {
          for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
            const l = nonEmptyLines[i].trim();
            if (
              /Working\b|esc to interrupt|ctrl\+c|Thinking\b|Reasoning\b|Running\b|Searching\b/i.test(l) ||
              /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|[\u2800-\u28FF]/.test(l)
            ) {
              promptLine = l;
              break;
            }
          }
        }
        return {
          status: 'working',
          confidence: 0.98,
          source: 'terminal_prompt',
          detectedPrompt: promptLine,
          reason: `Codex active work in progress: ${promptLine}`,
          updatedAt: new Date(),
        };
      }

      // C. IDLE: Ready prompt (e.g. › Ask Codex to do anything) when NOT working
      if (
        ((hasCodexIdlePrompt || hasRecentCompletion) && !hasActiveWorkingStatus) ||
        promptResult.kind === 'idle_prompt' ||
        promptResult.kind === 'shell_prompt'
      ) {
        return {
          status: 'idle',
          confidence: promptResult.confidence ?? 0.92,
          source: 'terminal_prompt',
          detectedPrompt: idlePromptLine || promptResult.promptLine,
          reason: `Codex ready prompt active: ${idlePromptLine || promptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }

      // D. ERROR: Fatal execution error
      if (promptResult.kind === 'error') {
        return {
          status: 'error',
          confidence: promptResult.confidence ?? 0.85,
          source: 'terminal_prompt',
          detectedPrompt: promptResult.promptLine,
          reason: `Execution error detected in Codex terminal: ${promptResult.promptLine}`,
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

    // 8. Foreground command fallback
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

    const isHarness = cmd === 'codex' || cmd === 'codex-cli' || cmd === 'node';
    if (cmd && !isShell && !isHarness) {
      return {
        status: 'working',
        confidence: 0.65,
        source: 'process',
        reason: `Subcommand '${signals.paneCurrentCommand}' is executing`,
        updatedAt: new Date(),
      };
    }

    return {
      status: 'idle',
      confidence: 0.5,
      source: 'tmux',
      reason: 'Codex session is quiet and waiting for input',
      updatedAt: new Date(),
    };
  }
}
