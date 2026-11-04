import type { SessionHistoryQuery, SessionHistoryResult } from '@spawnea/domain';

export interface HarnessHistoryContext {
  sessionId: string;
  harness: string;
  worktreePath?: string;
  isLocal: boolean;
  agentSessionId?: string;
  panePid?: number;
  resolvedTranscriptPath?: string;
  tailLines?: string[];
  homeDir?: string;
}

export interface HarnessHistoryReader {
  readonly harnessId: string;
  canRead(context: HarnessHistoryContext): boolean;
  readHistory(
    context: HarnessHistoryContext,
    query?: SessionHistoryQuery
  ): Promise<SessionHistoryResult | null>;
}
