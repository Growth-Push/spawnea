import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  createLogger,
  MAX_AGGREGATE_HISTORY_PAYLOAD_BYTES,
  MAX_PERSISTED_TURN_OUTPUT_BYTES,
  MAX_PERSISTED_TURN_PROMPT_BYTES,
  MAX_PERSISTED_TURNS_GLOBAL,
  MAX_PERSISTED_TURNS_PER_SESSION,
  MAX_SNAPSHOT_HISTORY_ITEMS,
  MAX_SNAPSHOT_OUTPUT_BYTES,
  MAX_TURN_REQUESTS_PER_SESSION,
  SESSION_HISTORY_RETENTION_MS,
  truncateUtf8Head,
  truncateUtf8Tail,
  utf8ByteLength,
  type Logger,
  type PersistedControlTurn,
  type PersistedControlTurnStatus,
  type PersistedSessionSnapshot,
  type PersistedTurnRequestRecord,
  type SaveControlTurnInput,
  type SaveSessionSnapshotInput,
  type SaveTurnRequestInput,
  type SessionHistoryItem,
  type SessionHistoryRepository,
  type SessionHistoryRetentionPruneResult,
  type SessionHistorySource,
  type TurnRequestDeliveryStatus,
} from '@spawnea/domain';
import { getSqliteClient, type DbClient } from '../connection.js';
import { ensurePrivateSqliteStorageForClient } from '../storage-privacy.js';

export interface SessionHistoryRetentionLimits {
  retentionMs: number;
  maxTurnsPerSession: number;
  maxTurnsGlobal: number;
  maxSnapshotBytes: number;
  maxSnapshotItems: number;
  maxTurnOutputBytes: number;
  maxTurnPromptBytes: number;
  maxRequestsPerSession: number;
  maxAggregatePayloadBytes: number;
}

export const DEFAULT_SESSION_HISTORY_LIMITS: SessionHistoryRetentionLimits = {
  retentionMs: SESSION_HISTORY_RETENTION_MS,
  maxTurnsPerSession: MAX_PERSISTED_TURNS_PER_SESSION,
  maxTurnsGlobal: MAX_PERSISTED_TURNS_GLOBAL,
  maxSnapshotBytes: MAX_SNAPSHOT_OUTPUT_BYTES,
  maxSnapshotItems: MAX_SNAPSHOT_HISTORY_ITEMS,
  maxTurnOutputBytes: MAX_PERSISTED_TURN_OUTPUT_BYTES,
  maxTurnPromptBytes: MAX_PERSISTED_TURN_PROMPT_BYTES,
  maxRequestsPerSession: MAX_TURN_REQUESTS_PER_SESSION,
  maxAggregatePayloadBytes: MAX_AGGREGATE_HISTORY_PAYLOAD_BYTES,
};

export interface SqliteSessionHistoryRepositoryOptions {
  logger?: Logger;
  limits?: Partial<SessionHistoryRetentionLimits>;
}

interface RawSnapshotRow {
  session_id: string;
  output: string;
  truncated: number;
  snapshot_generation: string;
  version: number;
  source: string;
  history_items_json: string;
  history_truncated: number;
  payload_bytes: number;
  captured_at: number;
  updated_at: number;
}

interface RawTurnRow {
  id: string;
  session_id: string;
  harness: string;
  prompt: string;
  output: string;
  output_generation: number;
  base_offset: number;
  version: number;
  status: string;
  observed_working: number;
  output_changes: number;
  prompt_delimiter_pairs: number;
  submission_uncertain: number;
  interrupted: number;
  truncated: number;
  payload_bytes: number;
  created_at: number;
  changed_at: number;
}

interface RawTurnRequestRow {
  session_id: string;
  client_request_id: string;
  turn_id: string;
  fingerprint_hash: string;
  delivered: number;
  delivery_method: string;
  delivery_status: string;
  accepted_at: number;
  payload_bytes: number;
}

interface PruneProtectTarget {
  snapshotSessionId?: string;
  turnId?: string;
  turnSessionId?: string;
  requestSessionId?: string;
  requestClientId?: string;
}

type DbTx = Parameters<Parameters<DbClient['transaction']>[0]>[0];

function boundSnapshotItems(
  inputItems: readonly SessionHistoryItem[] | undefined,
  maxItems: number,
  maxBytes: number,
): { items: SessionHistoryItem[]; historyTruncated: boolean } {
  if (!inputItems || inputItems.length === 0) {
    return { items: [], historyTruncated: false };
  }

  let historyTruncated = inputItems.length > maxItems;
  let items: SessionHistoryItem[] = inputItems.slice(-maxItems).map((item) => {
    const trimmed = truncateUtf8Head(item.text, Math.max(256, Math.floor(maxBytes / 2)));
    if (trimmed.truncated) historyTruncated = true;
    return {
      ...item,
      text: trimmed.text,
      ...(trimmed.truncated || item.textTruncated ? { textTruncated: true } : {}),
    };
  });

  while (items.length > 1 && utf8ByteLength(JSON.stringify(items)) > maxBytes) {
    items = items.slice(1);
    historyTruncated = true;
  }

  if (items.length === 1 && utf8ByteLength(JSON.stringify(items)) > maxBytes) {
    const only = items[0]!;
    const overhead = utf8ByteLength(JSON.stringify([{ ...only, text: '', textTruncated: true }]));
    const allowedTextBytes = Math.max(0, maxBytes - overhead);
    const trimmed = truncateUtf8Head(only.text, allowedTextBytes);
    items = [{ ...only, text: trimmed.text, textTruncated: trimmed.truncated || only.textTruncated }];
    historyTruncated = true;
  }

  return { items, historyTruncated };
}

function withoutPayloadBytes<T extends object>(row: T): Omit<T, 'payloadBytes'> {
  if (!('payloadBytes' in row)) {
    return row as Omit<T, 'payloadBytes'>;
  }
  const { payloadBytes: _ignored, ...rest } = row as T & { payloadBytes?: unknown };
  return rest as Omit<T, 'payloadBytes'>;
}

function serializeTurnPayloadBytes(row: Omit<PersistedControlTurn, 'payloadBytes'>): number {
  return utf8ByteLength(JSON.stringify(withoutPayloadBytes(row)));
}

function serializeSnapshotPayloadBytes(
  row: Omit<PersistedSessionSnapshot, 'payloadBytes'>,
): number {
  return utf8ByteLength(JSON.stringify(withoutPayloadBytes(row)));
}

function serializeRequestPayloadBytes(
  row: Omit<PersistedTurnRequestRecord, 'payloadBytes'>,
): number {
  return utf8ByteLength(JSON.stringify(withoutPayloadBytes(row)));
}

export class SqliteSessionHistoryRepository implements SessionHistoryRepository {
  private readonly logger: Logger;
  private readonly limits: SessionHistoryRetentionLimits;

  constructor(
    private readonly db: DbClient,
    options: SqliteSessionHistoryRepositoryOptions = {},
  ) {
    this.logger = options.logger ?? createLogger('db:session-history');
    this.limits = { ...DEFAULT_SESSION_HISTORY_LIMITS, ...options.limits };
  }

  private ensurePrivateStorage(): void {
    const sqlite = getSqliteClient(this.db);
    if (!sqlite) {
      throw new Error('Cannot verify SQLite storage privacy: missing SQLite connection');
    }
    ensurePrivateSqliteStorageForClient(sqlite);
  }

  async upsertSnapshot(input: SaveSessionSnapshotInput): Promise<PersistedSessionSnapshot> {
    const nowMs = input.updatedAt ?? input.capturedAt ?? Date.now();
    const capturedAt = input.capturedAt ?? nowMs;
    const source: SessionHistorySource = input.source ?? 'screen';
    const boundedOutput = truncateUtf8Tail(input.output, this.limits.maxSnapshotBytes);
    const { items, historyTruncated } = boundSnapshotItems(
      input.items,
      this.limits.maxSnapshotItems,
      this.limits.maxSnapshotBytes,
    );
    const itemsJson = JSON.stringify(items);

    try {
      this.ensurePrivateStorage();
      const persisted = this.db.transaction((tx) => {
        const existing = tx.get<RawSnapshotRow>(sql`
          SELECT * FROM session_output_snapshots WHERE session_id = ${input.sessionId}
        `);

        const contentChanged =
          !existing ||
          existing.output !== boundedOutput.text ||
          Boolean(existing.truncated) !== boundedOutput.truncated ||
          existing.source !== source ||
          existing.history_items_json !== itemsJson ||
          Boolean(existing.history_truncated) !== historyTruncated;

        const snapshotGeneration = existing?.snapshot_generation || randomUUID();
        const version = existing ? (contentChanged ? existing.version + 1 : existing.version) : 1;
        const effectiveUpdatedAt = contentChanged ? nowMs : existing.updated_at;
        const baseSnapshot = {
          sessionId: input.sessionId,
          output: boundedOutput.text,
          truncated: boundedOutput.truncated,
          snapshotGeneration,
          version,
          source,
          items,
          historyTruncated,
          capturedAt,
          updatedAt: effectiveUpdatedAt,
        };
        const payloadBytes = serializeSnapshotPayloadBytes(baseSnapshot);

        tx.run(sql`
          INSERT INTO session_output_snapshots (
            session_id, output, truncated, snapshot_generation, version, source, history_items_json,
            history_truncated, payload_bytes, captured_at, updated_at
          ) VALUES (
            ${input.sessionId}, ${boundedOutput.text}, ${boundedOutput.truncated ? 1 : 0},
            ${snapshotGeneration}, ${version}, ${source}, ${itemsJson}, ${historyTruncated ? 1 : 0},
            ${payloadBytes}, ${capturedAt}, ${effectiveUpdatedAt}
          )
          ON CONFLICT(session_id) DO UPDATE SET
            output = excluded.output,
            truncated = excluded.truncated,
            snapshot_generation = excluded.snapshot_generation,
            version = excluded.version,
            source = excluded.source,
            history_items_json = excluded.history_items_json,
            history_truncated = excluded.history_truncated,
            payload_bytes = excluded.payload_bytes,
            captured_at = excluded.captured_at,
            updated_at = excluded.updated_at
        `);

        this.pruneLocked(tx, nowMs, { snapshotSessionId: input.sessionId });
        return { ...baseSnapshot, payloadBytes };
      });
      this.ensurePrivateStorage();
      return persisted;
    } catch (error) {
      this.logger.error('Failed to persist session output snapshot', error, { sessionId: input.sessionId });
      throw error;
    }
  }

  async findSnapshotBySessionId(
    sessionId: string,
    nowMs = Date.now(),
  ): Promise<PersistedSessionSnapshot | null> {
    const row = this.db.get<RawSnapshotRow>(sql`
      SELECT * FROM session_output_snapshots WHERE session_id = ${sessionId}
    `);
    if (!row) return null;
    if (row.captured_at < nowMs - this.limits.retentionMs) {
      this.db.run(sql`DELETE FROM session_output_snapshots WHERE session_id = ${sessionId}`);
      return null;
    }
    return this.mapSnapshotRow(row);
  }

  async saveTurn(input: SaveControlTurnInput): Promise<PersistedControlTurn> {
    const nowMs = input.changedAt ?? Date.now();
    const createdAt = input.createdAt ?? nowMs;
    const boundedPrompt = truncateUtf8Head(input.prompt, this.limits.maxTurnPromptBytes);
    const boundedOutput = truncateUtf8Tail(input.output, this.limits.maxTurnOutputBytes);
    const baseOffset = input.baseOffset + boundedOutput.droppedBytes;
    const truncated = Boolean(input.truncated) || boundedOutput.truncated || boundedPrompt.truncated;
    const interrupted = Boolean(input.interrupted) || input.status === 'interrupted';

    const baseTurn: Omit<PersistedControlTurn, 'payloadBytes'> = {
      id: input.id,
      sessionId: input.sessionId,
      harness: input.harness,
      prompt: boundedPrompt.text,
      output: boundedOutput.text,
      outputGeneration: input.outputGeneration,
      baseOffset,
      version: input.version,
      status: input.status,
      observedWorking: input.observedWorking,
      outputChanges: input.outputChanges,
      promptDelimiterPairs: input.promptDelimiterPairs,
      submissionUncertain: Boolean(input.submissionUncertain),
      interrupted,
      truncated,
      createdAt,
      changedAt: nowMs,
    };
    const payloadBytes = serializeTurnPayloadBytes(baseTurn);

    try {
      this.ensurePrivateStorage();
      const persisted = this.db.transaction((tx) => {
        tx.run(sql`
          INSERT INTO session_turns (
            id, session_id, harness, prompt, output, output_generation, base_offset,
            version, status, observed_working, output_changes, prompt_delimiter_pairs,
            submission_uncertain, interrupted, truncated, payload_bytes, created_at, changed_at
          ) VALUES (
            ${baseTurn.id}, ${baseTurn.sessionId}, ${baseTurn.harness}, ${baseTurn.prompt},
            ${baseTurn.output}, ${baseTurn.outputGeneration}, ${baseTurn.baseOffset},
            ${baseTurn.version}, ${baseTurn.status}, ${baseTurn.observedWorking ? 1 : 0},
            ${baseTurn.outputChanges}, ${baseTurn.promptDelimiterPairs},
            ${baseTurn.submissionUncertain ? 1 : 0}, ${baseTurn.interrupted ? 1 : 0},
            ${baseTurn.truncated ? 1 : 0}, ${payloadBytes}, ${baseTurn.createdAt}, ${baseTurn.changedAt}
          )
          ON CONFLICT(id) DO UPDATE SET
            output = excluded.output,
            output_generation = excluded.output_generation,
            base_offset = excluded.base_offset,
            version = excluded.version,
            status = excluded.status,
            observed_working = excluded.observed_working,
            output_changes = excluded.output_changes,
            prompt_delimiter_pairs = excluded.prompt_delimiter_pairs,
            submission_uncertain = excluded.submission_uncertain,
            interrupted = excluded.interrupted,
            truncated = excluded.truncated,
            payload_bytes = excluded.payload_bytes,
            changed_at = excluded.changed_at
        `);

        this.pruneLocked(tx, nowMs, {
          turnId: baseTurn.id,
          turnSessionId: baseTurn.sessionId,
        });
        return { ...baseTurn, payloadBytes };
      });
      this.ensurePrivateStorage();
      return persisted;
    } catch (error) {
      this.logger.error('Failed to persist control turn', error, {
        turnId: input.id,
        sessionId: input.sessionId,
      });
      throw error;
    }
  }

  async findTurnById(turnId: string, nowMs = Date.now()): Promise<PersistedControlTurn | null> {
    const row = this.db.get<RawTurnRow>(sql`
      SELECT * FROM session_turns WHERE id = ${turnId}
    `);
    if (!row) return null;
    if (row.changed_at < nowMs - this.limits.retentionMs) {
      this.db.run(sql`DELETE FROM session_turns WHERE id = ${turnId}`);
      return null;
    }
    return this.mapTurnRow(row);
  }

  async findTurnsBySessionId(
    sessionId: string,
    limit = this.limits.maxTurnsPerSession,
    nowMs = Date.now(),
  ): Promise<PersistedControlTurn[]> {
    const cutoff = nowMs - this.limits.retentionMs;
    const rows = this.db.all<RawTurnRow>(sql`
      SELECT * FROM session_turns
      WHERE session_id = ${sessionId} AND changed_at >= ${cutoff}
      ORDER BY changed_at DESC, created_at DESC, rowid DESC
      LIMIT ${Math.max(1, limit)}
    `);
    return rows.map((row) => this.mapTurnRow(row));
  }

  async markActiveTurnsInterrupted(nowMs = Date.now()): Promise<number> {
    try {
      this.ensurePrivateStorage();
      const updatedCount = this.db.transaction((tx) => {
        this.pruneLocked(tx, nowMs);
        const activeRows = tx.all<RawTurnRow>(sql`
          SELECT * FROM session_turns
          WHERE status IN ('working', 'needs_input', 'unknown')
        `);
        if (activeRows.length === 0) return 0;

        for (const row of activeRows) {
          const mapped = withoutPayloadBytes(this.mapTurnRow(row));
          const updated: Omit<PersistedControlTurn, 'payloadBytes'> = {
            ...mapped,
            status: 'interrupted',
            interrupted: true,
            outputGeneration: mapped.outputGeneration + 1,
            version: mapped.version + 1,
            changedAt: nowMs,
          };
          const payloadBytes = serializeTurnPayloadBytes(updated);
          tx.run(sql`
            UPDATE session_turns
            SET status = 'interrupted',
                interrupted = 1,
                output_generation = ${updated.outputGeneration},
                version = ${updated.version},
                changed_at = ${nowMs},
                payload_bytes = ${payloadBytes}
            WHERE id = ${row.id}
          `);
        }

        this.pruneLocked(tx, nowMs);
        return activeRows.length;
      });
      this.ensurePrivateStorage();
      return updatedCount;
    } catch (error) {
      this.logger.error('Failed to mark active persisted turns as interrupted on startup', error);
      throw error;
    }
  }

  async saveTurnRequest(input: SaveTurnRequestInput): Promise<PersistedTurnRequestRecord> {
    const acceptedAt = input.acceptedAt ?? Date.now();
    const clientRequestId = input.clientRequestId;
    const baseRecord: Omit<PersistedTurnRequestRecord, 'payloadBytes'> = {
      sessionId: input.sessionId,
      clientRequestId,
      turnId: input.turnId,
      fingerprintHash: input.fingerprintHash,
      delivered: input.delivered,
      deliveryMethod: input.deliveryMethod,
      deliveryStatus: input.deliveryStatus,
      acceptedAt,
    };
    const payloadBytes = serializeRequestPayloadBytes(baseRecord);

    try {
      this.ensurePrivateStorage();
      const persisted = this.db.transaction((tx) => {
        tx.run(sql`
          INSERT INTO session_turn_requests (
            session_id, client_request_id, turn_id, fingerprint_hash, delivered,
            delivery_method, delivery_status, accepted_at, payload_bytes
          ) VALUES (
            ${baseRecord.sessionId}, ${baseRecord.clientRequestId}, ${baseRecord.turnId},
            ${baseRecord.fingerprintHash}, ${baseRecord.delivered ? 1 : 0},
            ${baseRecord.deliveryMethod}, ${baseRecord.deliveryStatus}, ${baseRecord.acceptedAt},
            ${payloadBytes}
          )
          ON CONFLICT(session_id, client_request_id) DO UPDATE SET
            turn_id = excluded.turn_id,
            fingerprint_hash = excluded.fingerprint_hash,
            delivered = excluded.delivered,
            delivery_method = excluded.delivery_method,
            delivery_status = excluded.delivery_status,
            accepted_at = excluded.accepted_at,
            payload_bytes = excluded.payload_bytes
        `);

        this.pruneLocked(tx, acceptedAt, {
          turnId: baseRecord.turnId,
          turnSessionId: baseRecord.sessionId,
          requestSessionId: baseRecord.sessionId,
          requestClientId: baseRecord.clientRequestId,
        });
        return { ...baseRecord, payloadBytes };
      });
      this.ensurePrivateStorage();
      return persisted;
    } catch (error) {
      this.logger.error('Failed to persist turn request metadata', error, {
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
      throw error;
    }
  }

  async findTurnRequest(
    sessionId: string,
    clientRequestId: string,
    nowMs = Date.now(),
  ): Promise<PersistedTurnRequestRecord | null> {
    const row = this.db.get<RawTurnRequestRow>(sql`
      SELECT * FROM session_turn_requests
      WHERE session_id = ${sessionId} AND client_request_id = ${clientRequestId}
    `);
    if (!row) return null;
    if (row.accepted_at < nowMs - this.limits.retentionMs) {
      this.db.run(sql`
        DELETE FROM session_turn_requests
        WHERE session_id = ${sessionId} AND client_request_id = ${clientRequestId}
      `);
      return null;
    }
    return this.mapRequestRow(row);
  }

  async findTurnRequestsByTurnId(
    turnId: string,
    nowMs = Date.now(),
  ): Promise<PersistedTurnRequestRecord[]> {
    const cutoff = nowMs - this.limits.retentionMs;
    const rows = this.db.all<RawTurnRequestRow>(sql`
      SELECT * FROM session_turn_requests
      WHERE turn_id = ${turnId} AND accepted_at >= ${cutoff}
      ORDER BY accepted_at ASC, rowid ASC
    `);
    return rows.map((row) => this.mapRequestRow(row));
  }

  async pruneExpiredAndExcess(nowMs = Date.now()): Promise<SessionHistoryRetentionPruneResult> {
    try {
      this.ensurePrivateStorage();
      const result = this.db.transaction((tx) => this.pruneLocked(tx, nowMs));
      this.ensurePrivateStorage();
      return result;
    } catch (error) {
      this.logger.error('Failed to prune session history retention bounds', error);
      throw error;
    }
  }

  async getTotalPayloadBytes(): Promise<number> {
    return this.readTotalPayloadBytes(this.db);
  }

  private readTotalPayloadBytes(executor: Pick<DbClient, 'get'>): number {
    const row = executor.get<{ total: number }>(sql`
      SELECT (
        COALESCE((SELECT SUM(payload_bytes) FROM session_output_snapshots), 0) +
        COALESCE((SELECT SUM(payload_bytes) FROM session_turns), 0) +
        COALESCE((SELECT SUM(payload_bytes) FROM session_turn_requests), 0)
      ) AS total
    `);
    return row?.total ?? 0;
  }

  private pruneLocked(
    tx: DbTx,
    nowMs: number,
    protect: PruneProtectTarget = {},
  ): SessionHistoryRetentionPruneResult {
    const cutoff = nowMs - this.limits.retentionMs;
    let deletedSnapshots = 0;
    let deletedTurns = 0;
    let deletedRequests = 0;

    // 1. Age-based expiration (7 days since last successful observation)
    deletedSnapshots += tx.run(sql`
      DELETE FROM session_output_snapshots WHERE captured_at < ${cutoff}
    `).changes;
    deletedRequests += tx.run(sql`
      DELETE FROM session_turn_requests WHERE accepted_at < ${cutoff}
    `).changes;
    deletedTurns += tx.run(sql`
      DELETE FROM session_turns WHERE changed_at < ${cutoff}
    `).changes;

    // 2. Per-session turn cap (200 turns/session)
    const sessionOverflows = tx.all<{ session_id: string }>(sql`
      SELECT session_id FROM session_turns
      GROUP BY session_id
      HAVING COUNT(*) > ${this.limits.maxTurnsPerSession}
    `);
    for (const overflow of sessionOverflows) {
      deletedTurns += tx.run(sql`
        DELETE FROM session_turns
        WHERE session_id = ${overflow.session_id}
          AND id NOT IN (
            SELECT id FROM session_turns
            WHERE session_id = ${overflow.session_id}
            ORDER BY changed_at DESC, created_at DESC, rowid DESC
            LIMIT ${this.limits.maxTurnsPerSession}
          )
      `).changes;
    }

    // 3. Global turn cap (1000 turns globally)
    const turnCountRow = tx.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM session_turns`);
    const excessGlobalTurns = (turnCountRow?.count ?? 0) - this.limits.maxTurnsGlobal;
    if (excessGlobalTurns > 0) {
      deletedTurns += tx.run(sql`
        DELETE FROM session_turns
        WHERE id IN (
          SELECT id FROM session_turns
          ORDER BY changed_at ASC, created_at ASC, rowid ASC
          LIMIT ${excessGlobalTurns}
        )
      `).changes;
    }

    // 4. Per-session request metadata cap (50 requests/session)
    const reqOverflows = tx.all<{ session_id: string }>(sql`
      SELECT session_id FROM session_turn_requests
      GROUP BY session_id
      HAVING COUNT(*) > ${this.limits.maxRequestsPerSession}
    `);
    for (const overflow of reqOverflows) {
      deletedRequests += tx.run(sql`
        DELETE FROM session_turn_requests
        WHERE session_id = ${overflow.session_id}
          AND rowid NOT IN (
            SELECT rowid FROM session_turn_requests
            WHERE session_id = ${overflow.session_id}
            ORDER BY accepted_at DESC, rowid DESC
            LIMIT ${this.limits.maxRequestsPerSession}
          )
      `).changes;
    }

    // 5. Global aggregate serialized payload cap (32 MiB)
    let totalPayloadBytes = this.readTotalPayloadBytes(tx);
    while (totalPayloadBytes > this.limits.maxAggregatePayloadBytes) {
      const oldestTurn = tx.get<{ id: string }>(sql`
        SELECT id FROM session_turns
        WHERE ${protect.turnId ? sql`id != ${protect.turnId}` : sql`1=1`}
        ORDER BY changed_at ASC, created_at ASC, rowid ASC
        LIMIT 1
      `);
      if (oldestTurn) {
        const res = tx.run(sql`DELETE FROM session_turns WHERE id = ${oldestTurn.id}`);
        deletedTurns += res.changes;
        totalPayloadBytes = this.readTotalPayloadBytes(tx);
        continue;
      }

      const oldestRequest = tx.get<{ session_id: string; client_request_id: string }>(sql`
        SELECT session_id, client_request_id FROM session_turn_requests
        WHERE ${
          protect.requestSessionId && protect.requestClientId
            ? sql`NOT (session_id = ${protect.requestSessionId} AND client_request_id = ${protect.requestClientId})`
            : sql`1=1`
        }
        ORDER BY accepted_at ASC, rowid ASC
        LIMIT 1
      `);
      if (oldestRequest) {
        const res = tx.run(sql`
          DELETE FROM session_turn_requests
          WHERE session_id = ${oldestRequest.session_id}
            AND client_request_id = ${oldestRequest.client_request_id}
        `);
        deletedRequests += res.changes;
        totalPayloadBytes = this.readTotalPayloadBytes(tx);
        continue;
      }

      const oldestSnapshot = tx.get<{ session_id: string }>(sql`
        SELECT session_id FROM session_output_snapshots
        WHERE ${protect.snapshotSessionId ? sql`session_id != ${protect.snapshotSessionId}` : sql`1=1`}
        ORDER BY captured_at ASC, rowid ASC
        LIMIT 1
      `);
      if (oldestSnapshot) {
        const res = tx.run(sql`
          DELETE FROM session_output_snapshots WHERE session_id = ${oldestSnapshot.session_id}
        `);
        deletedSnapshots += res.changes;
        totalPayloadBytes = this.readTotalPayloadBytes(tx);
        continue;
      }

      break;
    }

    return {
      deletedSnapshots,
      deletedTurns,
      deletedRequests,
      totalPayloadBytes,
    };
  }

  private mapSnapshotRow(row: RawSnapshotRow): PersistedSessionSnapshot {
    let items: SessionHistoryItem[] = [];
    let historyTruncated = Boolean(row.history_truncated);
    try {
      const parsed = JSON.parse(row.history_items_json);
      if (Array.isArray(parsed)) {
        items = parsed as SessionHistoryItem[];
      }
    } catch {
      this.logger.warn('Corrupted persisted history items JSON encountered; falling back to empty items', {
        sessionId: row.session_id,
      });
      historyTruncated = true;
    }
    return {
      sessionId: row.session_id,
      output: row.output,
      truncated: Boolean(row.truncated),
      snapshotGeneration: row.snapshot_generation,
      version: row.version,
      source: row.source === 'transcript' ? 'transcript' : 'screen',
      items,
      historyTruncated,
      payloadBytes: row.payload_bytes,
      capturedAt: row.captured_at,
      updatedAt: row.updated_at,
    };
  }

  private mapTurnRow(row: RawTurnRow): PersistedControlTurn {
    return {
      id: row.id,
      sessionId: row.session_id,
      harness: row.harness,
      prompt: row.prompt,
      output: row.output,
      outputGeneration: row.output_generation,
      baseOffset: row.base_offset,
      version: row.version,
      status: row.status as PersistedControlTurnStatus,
      observedWorking: Boolean(row.observed_working),
      outputChanges: row.output_changes,
      promptDelimiterPairs: row.prompt_delimiter_pairs,
      submissionUncertain: Boolean(row.submission_uncertain),
      interrupted: Boolean(row.interrupted),
      truncated: Boolean(row.truncated),
      payloadBytes: row.payload_bytes,
      createdAt: row.created_at,
      changedAt: row.changed_at,
    };
  }

  private mapRequestRow(row: RawTurnRequestRow): PersistedTurnRequestRecord {
    return {
      sessionId: row.session_id,
      clientRequestId: row.client_request_id,
      turnId: row.turn_id,
      fingerprintHash: row.fingerprint_hash,
      delivered: Boolean(row.delivered),
      deliveryMethod: row.delivery_method === 'pty' ? 'pty' : 'tmux',
      deliveryStatus: row.delivery_status as TurnRequestDeliveryStatus,
      acceptedAt: row.accepted_at,
      payloadBytes: row.payload_bytes,
    };
  }
}
