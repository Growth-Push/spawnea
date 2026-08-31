import type {
  SessionSignals,
  SessionStatusResult,
  HarnessLifecycleEvent,
} from '@spawnea/domain';
import type {
  HarnessStatusAdapter,
  HarnessStatusAdapterOptions,
} from './types.js';
import { detectPromptInTail, stripAnsi } from '../prompt-detector.js';

export class AntigravityStatusAdapter implements HarnessStatusAdapter {
  readonly harnessId = 'antigravity';
  readonly displayName = 'Antigravity CLI Adapter';

  parseRawEvents(rawJsonLines: string[]): HarnessLifecycleEvent[] {
    const events: HarnessLifecycleEvent[] = [];
    for (const line of rawJsonLines) {
      if (!line || !line.trim()) continue;
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed && typeof parsed === 'object') {
          let summary: string | undefined = undefined;
          if (parsed.rawPayload && typeof parsed.rawPayload === 'string') {
            try {
              const payloadObj = JSON.parse(parsed.rawPayload);
              summary = payloadObj['last-assistant-message'] || payloadObj.summary;
            } catch {
              // Ignore payload parse errors
            }
          }

          events.push({
            sessionId: parsed.sessionId || '',
            harness: 'antigravity',
            eventType: parsed.eventType || 'turn_complete',
            timestamp: parsed.timestamp || new Date().toISOString(),
            rawPayload: parsed.rawPayload || parsed.payload,
            summary,
          });
        }
      } catch {
        // Ignore invalid line
      }
    }
    return events;
  }

  evaluateStatus(
    signals: SessionSignals,
    recentEvents: HarnessLifecycleEvent[],
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

    // 3. Check native events (highest confidence when present)
    const latestEvent = recentEvents.length > 0 ? recentEvents[recentEvents.length - 1] : undefined;
    if (latestEvent) {
      const type = latestEvent.eventType.toLowerCase();
      if (
        type === 'turn_complete' ||
        type === 'agent-turn-complete' ||
        type === 'sessionstart' ||
        type === 'session_start' ||
        type === 'idle'
      ) {
        return {
          status: 'idle',
          confidence: 0.98,
          source: 'native_hook',
          reason: `Antigravity lifecycle hook reported turn completion${
            latestEvent.summary ? `: "${latestEvent.summary.substring(0, 60)}..."` : ''
          }`,
          lastEvent: latestEvent,
          updatedAt: new Date(),
        };
      }

      if (
        type === 'userpromptsubmit' ||
        type === 'user_prompt_submit' ||
        type === 'tool_start' ||
        type === 'turn_start' ||
        type === 'working'
      ) {
        return {
          status: 'working',
          confidence: 0.95,
          source: 'native_hook',
          reason: `Antigravity lifecycle hook reported active execution (${latestEvent.eventType})`,
          lastEvent: latestEvent,
          updatedAt: new Date(),
        };
      }

      if (type === 'permission_requested' || type === 'choice_required' || type === 'question') {
        return {
          status: 'needs_input',
          confidence: 0.98,
          source: 'native_hook',
          reason: 'Antigravity lifecycle hook reported user interaction required',
          lastEvent: latestEvent,
          updatedAt: new Date(),
        };
      }
    }

    // 4. Check tmux option marker if passed directly via signals
    if (signals.tmuxLastEvent && signals.tmuxLastEvent.startsWith('turn_complete')) {
      return {
        status: 'idle',
        confidence: 0.95,
        source: 'native_hook',
        reason: `Antigravity tmux option marker reported turn completion`,
        updatedAt: new Date(),
      };
    }

    // 5. Explicit harness status (if passed)
    if (signals.harnessStatus) {
      const hStatus = signals.harnessStatus.toLowerCase();
      if (hStatus === 'working' || hStatus === 'busy') {
        return {
          status: 'working',
          confidence: 0.95,
          source: 'harness_hook',
          reason: 'Explicit harness status reported working',
          updatedAt: new Date(),
        };
      }
      if (hStatus === 'needs_input' || hStatus === 'waiting' || hStatus === 'prompt') {
        return {
          status: 'needs_input',
          confidence: 0.95,
          source: 'harness_hook',
          reason: 'Explicit harness status reported waiting for input',
          updatedAt: new Date(),
        };
      }
      if (hStatus === 'idle') {
        return {
          status: 'idle',
          confidence: 0.95,
          source: 'harness_hook',
          reason: 'Explicit harness status reported idle',
          updatedAt: new Date(),
        };
      }
    }

    // 6. Terminal tail heuristics (capture-pane inspection)
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
