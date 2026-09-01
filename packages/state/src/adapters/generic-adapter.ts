import type {
  SessionSignals,
  SessionStatusResult,
} from '@spawnea/domain';
import type {
  HarnessStatusAdapter,
  HarnessStatusAdapterOptions,
} from './types.js';
import { detectPromptInTail } from '../prompt-detector.js';

export class GenericStatusAdapter implements HarnessStatusAdapter {
  readonly harnessId = 'generic';
  readonly displayName = 'Generic / Shell Adapter';

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

    // 3. Terminal tail snapshot heuristics (tmux capture-pane) - Primary real-time source
    const tailLines = signals.tailLines || [];
    if (tailLines.length > 0) {
      const promptResult = detectPromptInTail(tailLines, {
        harness: signals.paneCurrentCommand,
        customRules: options.customRules,
        tailLinesCount: 20,
      });

      if (
        promptResult.kind === 'confirmation' ||
        promptResult.kind === 'choice' ||
        promptResult.kind === 'question'
      ) {
        return {
          status: 'needs_input',
          confidence: promptResult.confidence ?? 0.9,
          source: 'terminal_prompt',
          detectedPrompt: promptResult.promptLine,
          reason: `Terminal prompt requires user input: ${promptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }

      if (promptResult.kind === 'working') {
        return {
          status: signals.isPtyAttached ? 'working' : 'disconnected',
          confidence: promptResult.confidence ?? 0.9,
          source: 'terminal_prompt',
          detectedPrompt: promptResult.promptLine,
          reason: `Active work in progress: ${promptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }

      if (promptResult.kind === 'idle_prompt' || promptResult.kind === 'shell_prompt') {
        return {
          status: signals.isPtyAttached ? 'idle' : 'disconnected',
          confidence: promptResult.confidence ?? 0.9,
          source: 'terminal_prompt',
          detectedPrompt: promptResult.promptLine,
          reason: `Agent prompt ready/idle: ${promptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }

      if (promptResult.kind === 'error') {
        return {
          status: 'error',
          confidence: promptResult.confidence ?? 0.85,
          source: 'terminal_prompt',
          detectedPrompt: promptResult.promptLine,
          reason: `Execution error detected in terminal: ${promptResult.promptLine}`,
          updatedAt: new Date(),
        };
      }
    }

    // 5. PTY Activity streaming
    const msSinceOutput = signals.lastOutputAt ? now - signals.lastOutputAt.getTime() : Infinity;
    const isActivelyStreaming =
      signals.lastOutputAt !== undefined && msSinceOutput <= activeOutputWindowMs;

    if (isActivelyStreaming && signals.isPtyAttached) {
      return {
        status: 'working',
        confidence: 0.75,
        source: 'pty_activity',
        reason: `Active PTY output (${signals.recentOutputBytes || 0} bytes recently)`,
        updatedAt: new Date(),
      };
    }

    // 7. Foreground command / process liveness
    const cmd = (signals.paneCurrentCommand || '').toLowerCase();
    const isShell = cmd === 'bash' || cmd === 'zsh' || cmd === 'sh' || cmd === 'fish' || cmd === 'tmux';

    if (isShell) {
      return {
        status: signals.isPtyAttached ? 'idle' : 'disconnected',
        confidence: 0.7,
        source: 'tmux',
        reason: `Shell '${signals.paneCurrentCommand}' is active at prompt`,
        updatedAt: new Date(),
      };
    }

    if (cmd && !isShell) {
      return {
        status: signals.isPtyAttached ? 'working' : 'disconnected',
        confidence: 0.65,
        source: 'process',
        reason: `Agent command '${signals.paneCurrentCommand}' is actively executing`,
        updatedAt: new Date(),
      };
    }

    // 8. Fallback for unattached / quiet existing session
    return {
      status: signals.isPtyAttached ? 'idle' : 'disconnected',
      confidence: 0.5,
      source: 'tmux',
      reason: signals.isPtyAttached ? 'Session is attached and quiet' : 'Session is detached',
      updatedAt: new Date(),
    };
  }
}
