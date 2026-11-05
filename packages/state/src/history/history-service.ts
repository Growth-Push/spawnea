import * as path from 'node:path';
import type { SessionHistoryQuery, SessionHistoryResult } from '@spawnea/domain';
import { canonicalHarnessId } from '../harness-ids.js';
import { ClaudeHistoryReader } from './claude-history-reader.js';
import { CodexHistoryReader } from './codex-history-reader.js';
import { ScreenHistoryReader } from './screen-history-reader.js';
import type { HarnessHistoryContext, HarnessHistoryReader } from './types.js';

export interface SessionHistoryServiceOptions {
  claudeReader?: HarnessHistoryReader;
  codexReader?: HarnessHistoryReader;
  screenReader?: ScreenHistoryReader;
}

/**
 * Unified Session History Service implementing the hybrid model:
 * Reads local Claude and Codex history from agent transcript files,
 * with terminal screen parsing as a robust fallback and live state source.
 */
export class SessionHistoryService {
  private readonly readers = new Map<string, HarnessHistoryReader>();
  private readonly screenReader: ScreenHistoryReader;
  private readonly resolvedPaths = new Map<string, string>();

  constructor(options?: SessionHistoryServiceOptions) {
    const claude = options?.claudeReader || new ClaudeHistoryReader();
    const codex = options?.codexReader || new CodexHistoryReader();
    this.screenReader = options?.screenReader || new ScreenHistoryReader();

    this.readers.set('claude', claude);
    this.readers.set('codex', codex);
  }

  setResolvedTranscriptPath(sessionId: string, transcriptPath: string): void {
    this.resolvedPaths.set(sessionId, transcriptPath);
  }

  getResolvedTranscriptPath(sessionId: string): string | undefined {
    return this.resolvedPaths.get(sessionId);
  }

  clearSession(sessionId: string): void {
    this.resolvedPaths.delete(sessionId);
  }

  async getHistory(
    context: HarnessHistoryContext,
    query?: SessionHistoryQuery
  ): Promise<SessionHistoryResult> {
    let cachedPath = this.resolvedPaths.get(context.sessionId);
    if (cachedPath && context.agentSessionId) {
      const harnessBasename =
        context.harness.trim().split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '') ||
        context.harness;
      const canonical = canonicalHarnessId(harnessBasename);
      const cachedBase = path.basename(cachedPath, '.jsonl');

      let isValid = true;
      if (canonical === 'claude') {
        isValid = cachedBase === context.agentSessionId;
      } else if (canonical === 'codex') {
        isValid =
          cachedBase === context.agentSessionId ||
          cachedBase.endsWith(context.agentSessionId) ||
          cachedBase.includes(context.agentSessionId);
      }
      if (!isValid) {
        this.resolvedPaths.delete(context.sessionId);
        cachedPath = undefined;
      }
    }

    const effectiveContext: HarnessHistoryContext = {
      ...context,
      resolvedTranscriptPath: context.resolvedTranscriptPath || cachedPath,
    };

    if (effectiveContext.isLocal) {
      const harnessBasename =
        effectiveContext.harness.trim().split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '') ||
        effectiveContext.harness;
      const canonicalHarness = canonicalHarnessId(harnessBasename);
      const reader = this.readers.get(canonicalHarness);

      if (reader && reader.canRead(effectiveContext)) {
        try {
          const result = await reader.readHistory(effectiveContext, query);
          if (result !== null) {
            if (result.transcriptPath) {
              this.resolvedPaths.set(effectiveContext.sessionId, result.transcriptPath);
            }
            return result;
          }
        } catch {
          // Missing, unreadable, truncated or rotated file: gracefully fall back to screen
        }
      }
    }

    // Fall back to terminal screen parser
    return this.screenReader.readHistory(effectiveContext, query);
  }
}
