import type { Repositories } from '@spawnea/db';
import { MAX_SNAPSHOT_HISTORY_ITEMS, type Logger, type SessionHistoryItem } from '@spawnea/domain';
import { ScreenHistoryReader } from '@spawnea/state';

const sharedScreenReader = new ScreenHistoryReader();

export interface PersistSnapshotOptions {
  repositories: Repositories;
  logger: Logger;
  sessionId: string;
  harness?: string;
  tailLines?: readonly string[];
  rawOutput?: string;
  captureSuccess: boolean;
  capturedAt?: number;
}

/**
 * Persists a bounded latest screen snapshot and parsed screen history items for a session.
 * Never overwrites a prior retained snapshot when capture failed or produced no visible content.
 */
export async function persistSessionScreenSnapshot(options: PersistSnapshotOptions): Promise<void> {
  const historyRepo = options.repositories.sessionHistory;
  if (!historyRepo || !options.captureSuccess) {
    return;
  }

  const lines = options.tailLines ? [...options.tailLines] : (options.rawOutput ?? '').split('\n');
  const output = options.rawOutput !== undefined ? options.rawOutput : lines.join('\n');
  if (output.trim().length === 0) {
    return;
  }

  try {
    let items: SessionHistoryItem[] = [];
    let historyTruncated = false;
    if (lines.length > 0) {
      const latest = await sharedScreenReader.readLatestItems(
        {
          sessionId: options.sessionId,
          harness: options.harness ?? 'shell',
          worktreePath: '',
          isLocal: false,
          tailLines: lines,
          captureSuccess: true,
        },
        MAX_SNAPSHOT_HISTORY_ITEMS,
      );
      items = latest.items;
      historyTruncated = latest.truncated;
    }

    await historyRepo.upsertSnapshot({
      sessionId: options.sessionId,
      output,
      items,
      historyTruncated,
      source: 'screen',
      capturedAt: options.capturedAt ?? Date.now(),
    });
  } catch (error) {
    options.logger.warn('Failed to persist session output snapshot', {
      sessionId: options.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
