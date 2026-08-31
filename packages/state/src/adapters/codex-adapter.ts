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

export class CodexStatusAdapter implements HarnessStatusAdapter {
  readonly harnessId = 'codex';
  readonly displayName = 'OpenAI Codex Adapter';

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
            harness: 'codex',
            eventType: parsed.eventType || 'agent-turn-complete',
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

    // 3. Explicit harness status (if passed)
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

    // 4. Terminal tail heuristics (capture-pane inspection) - Primary real-time source
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

      // A. NEEDS_INPUT: Interactive user prompt (e.g. [y/N], option choice, confirmation)
      const hasBracketConfirm = /\[[yY]\/[nN]\]|\([yY]\/[nN]\)|\[yes\/no\]|\(yes\/no\)/i.test(combinedTail);
      const hasProceedConfirm = /(?:do you want to (?:continue|proceed|run|execute|apply)|proceed\?|confirm\?)/i.test(combinedTail);
      const hasOptionConfirm = /(?:Please confirm one option|Which should I proceed with|Choose one of the following)/i.test(combinedTail);
      const hasBulletOption = /-\s+[A-Z]:\s+[^\n]+\n\s*-\s+[A-Z]:/i.test(combinedTail);

      if (
        hasBracketConfirm ||
        hasProceedConfirm ||
        hasOptionConfirm ||
        hasBulletOption ||
        promptResult.kind === 'confirmation' ||
        promptResult.kind === 'choice' ||
        promptResult.kind === 'question'
      ) {
        let promptLine = promptResult.promptLine || nonEmptyLines[nonEmptyLines.length - 1];
        if (!promptResult.promptLine) {
          for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
            const l = nonEmptyLines[i].trim();
            if (/\[[yY]\/[nN]\]|proceed|confirm|option/i.test(l) || l.startsWith('-')) {
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

      // B. WORKING: Active working indicator, 'esc to interrupt', Braille spinner, or active progress
      // Matches:
      // - • Working (1m 02s • esc to interrupt)
      // - Working (30s)
      // - esc to interrupt
      // - • Thinking, • Searching, • Running
      // - Braille spinner ([\u2800-\u28FF])
      // - Progress verbs (generating, reading file, etc.)
      const hasWorkingStatus = /(?:^|\n)\s*[•*·-]?\s*Working\b[^\n]*/i.test(combinedTail);
      const hasBrailleSpinner = /[\u2800-\u28FF]/.test(combinedTail);
      const hasActiveProgressBullets = /(?:^|\n)\s*•\s*(?:Working|Thinking|Searching|Running|Executing)\b[^\n]*/i.test(combinedTail);
      const hasCodexIdlePrompt = /[>›]?\s*Ask Codex to do anything/i.test(combinedTail);
      const activeStatusPattern = /^\s*•\s*[^\n]*\besc\s+to\s+interrupt\b/i;
      const completionPattern = /^\s*─\s+Worked for\b.*─+\s*$/i;
      const lastActiveStatusIndex = [...recentLines].reverse().findIndex((line) => activeStatusPattern.test(line));
      const lastCompletionIndex = [...recentLines].reverse().findIndex((line) => completionPattern.test(line));
      const activeStatusIndex = lastActiveStatusIndex === -1 ? -1 : recentLines.length - 1 - lastActiveStatusIndex;
      const completionIndex = lastCompletionIndex === -1 ? -1 : recentLines.length - 1 - lastCompletionIndex;
      const hasRecentCompletion = completionIndex >= 0 && completionIndex > activeStatusIndex;
      const hasInterruptFooter = activeStatusIndex >= 0 && !hasRecentCompletion;

      // Codex keeps the ready prompt visible while showing the transcript from
      // the previous turn. A historical "Working" line must not keep the
      // session marked as working after Codex has returned to the input bar.
      // The interrupt footer/spinner are the stronger indicators that the
      // current turn is still active.
      const hasActiveWorkingStatus =
        !hasRecentCompletion &&
        (hasInterruptFooter ||
          hasBrailleSpinner ||
          ((!hasCodexIdlePrompt) && (hasWorkingStatus || hasActiveProgressBullets)));
      const idlePromptLine = [...nonEmptyLines].reverse().find((line) => /[>›]?\s*Ask Codex to do anything/i.test(line));

      if (
        hasActiveWorkingStatus ||
        hasInterruptFooter ||
        hasBrailleSpinner ||
        (hasActiveProgressBullets && !hasCodexIdlePrompt) ||
        (promptResult.kind === 'working' && !hasCodexIdlePrompt)
      ) {
        let promptLine = promptResult.promptLine || 'Working...';
        if (!promptResult.promptLine || promptResult.kind !== 'working') {
          for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
            const l = nonEmptyLines[i].trim();
            if (/Working\b|esc to interrupt|Thinking\b|Running\b|Searching\b/i.test(l) || /[\u2800-\u28FF]/.test(l)) {
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

    // 5. Check native events (fallback when tailLines is empty or not conclusive)
    const latestEvent = recentEvents.length > 0 ? recentEvents[recentEvents.length - 1] : undefined;
    if (latestEvent) {
      const type = latestEvent.eventType.toLowerCase();
      if (
        type === 'agent-turn-complete' ||
        type === 'turn_complete' ||
        type === 'sessionstart' ||
        type === 'session_start'
      ) {
        return {
          status: 'idle',
          confidence: 0.98,
          source: 'native_hook',
          reason: `Codex native notify hook reported turn completion${
            latestEvent.summary ? `: "${latestEvent.summary.substring(0, 60)}..."` : ''
          }`,
          lastEvent: latestEvent,
          updatedAt: new Date(),
        };
      }

      if (
        type === 'userpromptsubmit' ||
        type === 'user_prompt_submit' ||
        type === 'pretooluse' ||
        type === 'posttooluse' ||
        type === 'tool_start'
      ) {
        return {
          status: 'working',
          confidence: 0.95,
          source: 'native_hook',
          reason: `Codex native hook reported active execution (${latestEvent.eventType})`,
          lastEvent: latestEvent,
          updatedAt: new Date(),
        };
      }
    }

    // 6. Check tmux option marker if passed directly via signals
    if (signals.tmuxLastEvent && signals.tmuxLastEvent.startsWith('turn_complete')) {
      return {
        status: 'idle',
        confidence: 0.95,
        source: 'native_hook',
        reason: `Codex tmux option marker reported turn completion`,
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

    if (cmd && !isShell) {
      return {
        status: 'working',
        confidence: 0.65,
        source: 'process',
        reason: `Codex process '${signals.paneCurrentCommand}' is executing`,
        updatedAt: new Date(),
      };
    }

    return {
      status: signals.isPtyAttached ? 'idle' : 'disconnected',
      confidence: 0.5,
      source: 'tmux',
      reason: signals.isPtyAttached ? 'Session is attached and quiet' : 'Session is detached',
      updatedAt: new Date(),
    };
  }
}
