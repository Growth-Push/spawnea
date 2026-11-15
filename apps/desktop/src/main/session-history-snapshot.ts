import type { Repositories } from '@spawnea/db';
import { MAX_SNAPSHOT_HISTORY_ITEMS, type Logger, type SessionHistoryItem } from '@spawnea/domain';
import { ScreenHistoryReader } from '@spawnea/state';

const sharedScreenReader = new ScreenHistoryReader();
const MAX_SNAPSHOT_SCREEN_PAGES = 20;
const MAX_SNAPSHOT_FOLLOWUP_PAGE_ITEMS = 200;
const MAX_COLLECTED_SNAPSHOT_ITEMS = 500;

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
    if (lines.length > 0) {
      const readerContext = {
        sessionId: options.sessionId,
        harness: options.harness ?? 'shell',
        worktreePath: '',
        isLocal: false,
        tailLines: lines,
        captureSuccess: true,
      };
      let page = await sharedScreenReader.readHistory(readerContext, {
        limit: MAX_SNAPSHOT_HISTORY_ITEMS,
        mode: 'recent_exchanges',
        recentExchanges: MAX_SNAPSHOT_HISTORY_ITEMS,
      });
      items = [...page.items];

      // Drain subsequent bounded pages so multi-page screen captures retain the newest blocks
      const seenCursors = new Set<string>();
      let pagesRead = 1;
      while (
        pagesRead < MAX_SNAPSHOT_SCREEN_PAGES &&
        page.hasMore &&
        page.cursor &&
        !seenCursors.has(page.cursor) &&
        !page.cursorExpired &&
        (!page.cursorStatus || page.cursorStatus === 'valid' || page.cursorStatus === 'initial')
      ) {
        seenCursors.add(page.cursor);
        pagesRead += 1;
        const nextPage = await sharedScreenReader.readHistory(readerContext, {
          cursor: page.cursor,
          limit: MAX_SNAPSHOT_FOLLOWUP_PAGE_ITEMS,
          mode: 'forward',
        });
        if (
          nextPage.cursorExpired ||
          (nextPage.cursorStatus && nextPage.cursorStatus !== 'valid' && nextPage.cursorStatus !== 'eof') ||
          nextPage.items.length === 0
        ) {
          break;
        }
        items.push(...nextPage.items);
        if (items.length > MAX_COLLECTED_SNAPSHOT_ITEMS) {
          items = items.slice(-(MAX_SNAPSHOT_HISTORY_ITEMS * 4));
        }
        if (nextPage.cursor && nextPage.cursor === page.cursor) {
          break;
        }
        page = nextPage;
      }
    }

    await historyRepo.upsertSnapshot({
      sessionId: options.sessionId,
      output,
      items,
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
