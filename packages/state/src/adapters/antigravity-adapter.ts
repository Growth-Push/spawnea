import type {
  SessionSignals,
  SessionStatusResult,
} from '@spawnea/domain';
import type {
  HarnessStatusAdapter,
  HarnessStatusAdapterOptions,
} from './types.js';
import { detectPromptInTail, stripAnsi } from '../prompt-detector.js';

export class AntigravityStatusAdapter implements HarnessStatusAdapter {
  readonly harnessId = 'antigravity';
  readonly displayName = 'Antigravity CLI Adapter';

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

    // 3. Terminal tail heuristics (capture-pane inspection)
    const tailLines = signals.tailLines || [];
    if (tailLines.length > 0) {
      const cleaned = tailLines.map((l) => stripAnsi(l).trimEnd());
      const nonEmptyLines = cleaned.filter((l) => l.trim().length > 0);
      const combinedTail = nonEmptyLines.slice(-20).join('\n');

      // A. NEEDS_INPUT: Questionnaire menus, tool/edit permissions, choices, questions
      const hasQuestionHeader = /Question \d+\/\d+:/i.test(combinedTail);
      const hasPermissionPrompt = /(?:Requesting permission for:|Do you want to proceed\?|Accept this (?:file )?edit\?)[\s\S]*?>\s*1\.\s+Yes/i.test(combinedTail);
      const hasQuestionnaireMenu = /Question \d+\/\d+:[^\n]*\n[\s\S]*?(?:Navigate|Select|Skip)/i.test(combinedTail);
      const hasNavigationFooter = /(?:↑\/↓|[\u2191\u2193/]+)\s*Navigate/i.test(combinedTail);
      const hasNumberedChoice = />\s*1\.\s+[^\n]+\n\s*2\.\s+/i.test(combinedTail);
      const hasQuestionLine = /(?:^\s*\?\s+[A-Z0-9].+\?\s*$|Accept this (?:file )?edit\?)/im.test(combinedTail);

      if (
        hasQuestionHeader ||
        hasPermissionPrompt ||
        hasQuestionnaireMenu ||
        hasNavigationFooter ||
        hasNumberedChoice ||
        hasQuestionLine
      ) {
        // Find representative question line
        let promptLine = nonEmptyLines[nonEmptyLines.length - 1];
        for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
          const l = nonEmptyLines[i].trim();
          if (
            l.startsWith('Question') ||
            l.startsWith('?') ||
            l.startsWith('Requesting permission') ||
            l.startsWith('Do you want to proceed') ||
            l.startsWith('Accept this')
          ) {
            promptLine = l;
            break;
          }
        }

        return {
          status: 'needs_input',
          confidence: 0.98,
          source: 'terminal_prompt',
          detectedPrompt: promptLine,
          reason: `Antigravity interactive input requested: ${promptLine}`,
          updatedAt: new Date(),
        };
      }

      // B. WORKING: Exclusively active rotating Braille spinner (⣷, ⣯, ⣟, ⡿, ⢿, ⣻, ⣽, ⣾, ⠋, ⠙, ⠹, ⠸, ⠼, etc.)
      // Matches Unicode Braille patterns (U+2800 to U+28FF)
      const hasBrailleSpinner = /[\u2800-\u28FF]/.test(combinedTail);

      if (hasBrailleSpinner) {
        // Find representative active spinner line
        let promptLine = 'Analyzing / executing...';
        for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
          const l = nonEmptyLines[i].trim();
          if (/[\u2800-\u28FF]/.test(l)) {
            promptLine = l;
            break;
          }
        }

        return {
          status: 'working',
          confidence: 0.98,
          source: 'terminal_prompt',
          detectedPrompt: promptLine,
          reason: `Antigravity active work in progress: ${promptLine}`,
          updatedAt: new Date(),
        };
      }

      // C. ERROR: Fatal execution error
      const promptResult = detectPromptInTail(tailLines, {
        harness: 'antigravity',
        customRules: options.customRules,
        tailLinesCount: 20,
      });

      if (promptResult.kind === 'error') {
        return {
          status: 'error',
          confidence: promptResult.confidence ?? 0.85,
          source: 'terminal_prompt',
          detectedPrompt: promptResult.promptLine,
          reason: `Execution error detected in Antigravity terminal: ${promptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }

      // D. IDLE: If not asking input and no active working characters, Antigravity is IDLE!
      let idlePromptLine = promptResult.promptLine || nonEmptyLines[nonEmptyLines.length - 1];
      return {
        status: 'idle',
        confidence: 0.95,
        source: 'terminal_prompt',
        detectedPrompt: idlePromptLine,
        reason: `Antigravity session is idle and ready: ${idlePromptLine}`,
        updatedAt: new Date(),
      };
    }

    // 7. Active PTY streaming
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

    // 8. Foreground command / quiet fallback for Antigravity
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
        ? 'Antigravity session is quiet and waiting for input'
        : 'Antigravity session is detached',
      updatedAt: new Date(),
    };
  }
}
