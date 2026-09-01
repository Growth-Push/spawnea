import type {
  SessionSignals,
  SessionStatusResult,
} from '@spawnea/domain';
import type {
  HarnessStatusAdapter,
  HarnessStatusAdapterOptions,
} from './types.js';
import { detectPromptInTail } from '../prompt-detector.js';

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
      if (
        promptResult.kind === 'choice' ||
        promptResult.kind === 'question' ||
        promptResult.kind === 'confirmation'
      ) {
        return {
          status: 'needs_input',
          confidence: promptResult.confidence ?? 0.98,
          source: 'terminal_prompt',
          detectedPrompt: promptResult.promptLine,
          reason: `Hermes interactive input requested: ${promptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }

      // B. WORKING: Active progress verbs or interrupt footer bar (msg=interrupt)
      if (promptResult.kind === 'working') {
        return {
          status: 'working',
          confidence: promptResult.confidence ?? 0.95,
          source: 'terminal_prompt',
          detectedPrompt: promptResult.promptLine,
          reason: `Hermes active execution in progress: ${promptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }

      // C. IDLE: Ready prompt or completed turn metrics checkmark (✓ 4m)
      if (promptResult.kind === 'idle_prompt' || promptResult.kind === 'shell_prompt') {
        return {
          status: 'idle',
          confidence: promptResult.confidence ?? 0.95,
          source: 'terminal_prompt',
          detectedPrompt: promptResult.promptLine,
          reason: `Hermes turn complete / idle prompt ready: ${promptResult.promptLine}`,
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
          reason: `Execution error detected in Hermes terminal: ${promptResult.promptLine}`,
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
