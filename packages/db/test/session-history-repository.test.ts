import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utf8ByteLength, type SessionHistoryItem } from '@spawnea/domain';
import {
  createDatabase,
  createRepositories,
  SqliteSessionHistoryRepository,
  type DatabaseConnection,
  type Repositories,
} from '../src/index.js';

function makeItems(count: number): SessionHistoryItem[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `item-${idx}`,
    source: 'screen',
    role: idx % 2 === 0 ? 'user' : 'agent',
    text: `Message ${idx}`,
  }));
}

describe('SqliteSessionHistoryRepository', () => {
  let conn: DatabaseConnection;
  let repos: Repositories;

  beforeEach(async () => {
    conn = createDatabase({ path: ':memory:' });
    repos = createRepositories(conn.db);
    await repos.servers.save({
      id: 'srv-1',
      name: 'Local Server',
      host: 'localhost',
      sshPort: 22,
      enabled: true,
    });
    await repos.projects.save({
      id: 'proj-1',
      serverId: 'srv-1',
      name: 'Demo Project',
      rootPath: '/tmp/demo-project',
    });
    await repos.agents.save({
      id: 'agent-1',
      name: 'Shell Fixture',
      harness: 'shell',
      command: 'sh',
    });
    for (const id of ['sess-1', 'sess-2']) {
      await repos.sessions.save({
        id,
        name: `Session ${id}`,
        serverId: 'srv-1',
        projectId: 'proj-1',
        agentId: 'agent-1',
        task: 'Test persistence',
        worktreePath: '/tmp/demo-project',
        branch: 'main',
        status: 'idle',
        tmuxSessionName: `spawnea-${id}`,
      });
    }
  });

  afterEach(() => {
    conn.close();
  });

  it('replaces snapshots per session without duplicating screen items and enforces byte/item caps', async () => {
    const repo = new SqliteSessionHistoryRepository(conn.db, {
      limits: { maxSnapshotBytes: 64, maxSnapshotItems: 3 },
    });

    const first = await repo.upsertSnapshot({
      sessionId: 'sess-1',
      output: '🚀'.repeat(20), // 80 UTF-8 bytes -> tail-truncated <= 64 bytes on boundary
      items: makeItems(5),
      capturedAt: 1_000,
    });
    expect(first.version).toBe(1);
    expect(first.truncated).toBe(true);
    expect(first.output.includes('\uFFFD')).toBe(false);
    expect(utf8ByteLength(first.output)).toBeLessThanOrEqual(64);
    expect(first.historyTruncated).toBe(true);
    expect(first.items.length).toBeLessThanOrEqual(3);
    expect(first.items.at(-1)?.id).toBe('item-4');

    const itemCapRepo = new SqliteSessionHistoryRepository(conn.db, {
      limits: { maxSnapshotBytes: 512, maxSnapshotItems: 3 },
    });
    const itemBounded = await itemCapRepo.upsertSnapshot({
      sessionId: 'sess-2',
      output: 'short',
      items: makeItems(5),
      capturedAt: 1_500,
    });
    expect(itemBounded.historyTruncated).toBe(true);
    expect(itemBounded.items.map((item) => item.id)).toEqual(['item-2', 'item-3', 'item-4']);

    // Same content does not bump version or updatedAt
    const unchanged = await itemCapRepo.upsertSnapshot({
      sessionId: 'sess-2',
      output: 'short',
      items: makeItems(5),
      capturedAt: 2_000,
    });
    expect(unchanged.version).toBe(1);
    expect(unchanged.updatedAt).toBe(itemBounded.updatedAt);

    // Changed content bumps version and replaces the single row
    const changed = await itemCapRepo.upsertSnapshot({
      sessionId: 'sess-2',
      output: 'updated screen',
      items: makeItems(2),
      capturedAt: 3_000,
    });
    expect(changed.version).toBe(2);
    expect(changed.items).toHaveLength(2);
    const countRow = conn.sqlite
      .prepare('SELECT count(*) AS count FROM session_output_snapshots WHERE session_id = ?')
      .get('sess-2') as { count: number };
    expect(countRow.count).toBe(1);
  });

  it('truncates turn output safely, adjusts baseOffset, and marks active turns interrupted', async () => {
    const repo = new SqliteSessionHistoryRepository(conn.db, {
      limits: { maxTurnOutputBytes: 10 },
    });

    const active = await repo.saveTurn({
      id: 'turn-active',
      sessionId: 'sess-1',
      harness: 'shell',
      prompt: 'run job',
      output: 'abc🚀123456',
      outputGeneration: 1,
      baseOffset: 0,
      version: 2,
      status: 'working',
      observedWorking: true,
      outputChanges: 3,
      promptDelimiterPairs: 1,
      createdAt: 10_000,
      changedAt: 11_000,
    });
    expect(active.truncated).toBe(true);
    expect(active.output.includes('\uFFFD')).toBe(false);
    expect(utf8ByteLength(active.output)).toBeLessThanOrEqual(10);
    expect(active.baseOffset).toBeGreaterThan(0);

    await repo.saveTurn({
      id: 'turn-done',
      sessionId: 'sess-1',
      harness: 'shell',
      prompt: 'finished job',
      output: 'ok',
      outputGeneration: 1,
      baseOffset: 0,
      version: 1,
      status: 'completed',
      observedWorking: true,
      outputChanges: 1,
      promptDelimiterPairs: 1,
      createdAt: 12_000,
      changedAt: 13_000,
    });

    const interruptedCount = await repo.markActiveTurnsInterrupted(20_000);
    expect(interruptedCount).toBe(1);

    const restoredActive = await repo.findTurnById('turn-active', 20_000);
    expect(restoredActive?.status).toBe('interrupted');
    expect(restoredActive?.interrupted).toBe(true);
    expect(restoredActive?.outputGeneration).toBe(2);
    expect(restoredActive?.version).toBe(3);

    const restoredDone = await repo.findTurnById('turn-done', 20_000);
    expect(restoredDone?.status).toBe('completed');
    expect(restoredDone?.interrupted).toBe(false);
  });

  it('enforces 7-day TTL, per-session turn cap, global turn cap, request cap, and aggregate payload budget', async () => {
    const repo = new SqliteSessionHistoryRepository(conn.db, {
      limits: {
        retentionMs: 1_000,
        maxTurnsPerSession: 2,
        maxTurnsGlobal: 3,
        maxRequestsPerSession: 2,
      },
    });

    // Save 3 turns on sess-1 -> oldest is evicted by per-session cap (2)
    for (let i = 1; i <= 3; i++) {
      await repo.saveTurn({
        id: `t1-${i}`,
        sessionId: 'sess-1',
        harness: 'shell',
        prompt: `p${i}`,
        output: `out-${i}`,
        outputGeneration: 1,
        baseOffset: 0,
        version: 1,
        status: 'completed',
        observedWorking: true,
        outputChanges: 1,
        promptDelimiterPairs: 1,
        createdAt: 10_000 + i,
        changedAt: 10_000 + i,
      });
    }
    expect((await repo.findTurnsBySessionId('sess-1', 10, 10_100)).map((t) => t.id)).toEqual(['t1-3', 't1-2']);

    // Save 2 turns on sess-2 -> global cap (3) evicts oldest remaining (t1-2)
    for (let i = 1; i <= 2; i++) {
      await repo.saveTurn({
        id: `t2-${i}`,
        sessionId: 'sess-2',
        harness: 'shell',
        prompt: `q${i}`,
        output: `out-${i}`,
        outputGeneration: 1,
        baseOffset: 0,
        version: 1,
        status: 'completed',
        observedWorking: true,
        outputChanges: 1,
        promptDelimiterPairs: 1,
        createdAt: 10_010 + i,
        changedAt: 10_010 + i,
      });
    }
    expect(await repo.findTurnById('t1-2', 10_100)).toBeNull();
    expect(await repo.findTurnById('t1-3', 10_100)).not.toBeNull();

    // Per-session request cap (2)
    for (let i = 1; i <= 3; i++) {
      await repo.saveTurnRequest({
        sessionId: 'sess-1',
        clientRequestId: `req-${i}`,
        turnId: 't1-3',
        fingerprintHash: createHash('sha256').update(`fp-${i}`).digest('hex'),
        delivered: true,
        deliveryMethod: 'tmux',
        deliveryStatus: 'delivered',
        acceptedAt: 10_020 + i,
      });
    }
    expect(await repo.findTurnRequest('sess-1', 'req-1', 10_100)).toBeNull();
    expect(await repo.findTurnRequest('sess-1', 'req-3', 10_100)).not.toBeNull();

    // Expired by TTL
    expect(await repo.findTurnById('t1-3', 20_000)).toBeNull();

    // Aggregate payload byte budget eviction
    const byteRepo = new SqliteSessionHistoryRepository(conn.db, {
      limits: {
        maxAggregatePayloadBytes: 900,
      },
    });
    await byteRepo.saveTurn({
      id: 'big-1',
      sessionId: 'sess-1',
      harness: 'shell',
      prompt: 'p1',
      output: 'x'.repeat(350),
      outputGeneration: 1,
      baseOffset: 0,
      version: 1,
      status: 'completed',
      observedWorking: true,
      outputChanges: 1,
      promptDelimiterPairs: 1,
      createdAt: 30_000,
      changedAt: 30_000,
    });
    await byteRepo.saveTurn({
      id: 'big-2',
      sessionId: 'sess-1',
      harness: 'shell',
      prompt: 'p2',
      output: 'y'.repeat(350),
      outputGeneration: 1,
      baseOffset: 0,
      version: 1,
      status: 'completed',
      observedWorking: true,
      outputChanges: 1,
      promptDelimiterPairs: 1,
      createdAt: 31_000,
      changedAt: 31_000,
    });
    expect(await byteRepo.getTotalPayloadBytes()).toBeLessThanOrEqual(900);
    expect(await byteRepo.findTurnById('big-1', 31_100)).toBeNull();
    expect(await byteRepo.findTurnById('big-2', 31_100)).not.toBeNull();
  });

  it('cascades deletes when a session is deleted', async () => {
    const repo = new SqliteSessionHistoryRepository(conn.db);
    await repo.upsertSnapshot({ sessionId: 'sess-1', output: 'hello', items: makeItems(1) });
    await repo.saveTurn({
      id: 'turn-cascade',
      sessionId: 'sess-1',
      harness: 'shell',
      prompt: 'hi',
      output: 'there',
      outputGeneration: 1,
      baseOffset: 0,
      version: 1,
      status: 'completed',
      observedWorking: true,
      outputChanges: 1,
      promptDelimiterPairs: 1,
    });
    await repo.saveTurnRequest({
      sessionId: 'sess-1',
      clientRequestId: 'req-cascade',
      turnId: 'turn-cascade',
      fingerprintHash: createHash('sha256').update('fp').digest('hex'),
      delivered: true,
      deliveryMethod: 'pty',
      deliveryStatus: 'delivered',
    });

    await repos.sessions.delete('sess-1');
    expect(await repo.findSnapshotBySessionId('sess-1')).toBeNull();
    expect(await repo.findTurnById('turn-cascade')).toBeNull();
    expect(await repo.findTurnRequest('sess-1', 'req-cascade')).toBeNull();
  });

  it('preserves multi-byte clientRequestId values verbatim without 128-byte collision', async () => {
    const repo = new SqliteSessionHistoryRepository(conn.db);
    await repo.saveTurn({
      id: 'turn-unicode-req',
      sessionId: 'sess-1',
      harness: 'shell',
      prompt: 'unicode test',
      output: 'ok',
      outputGeneration: 1,
      baseOffset: 0,
      version: 1,
      status: 'completed',
      observedWorking: true,
      outputChanges: 1,
      promptDelimiterPairs: 1,
    });

    const idA = `${'é'.repeat(64)}A`; // 65 UTF-16 chars, 129 UTF-8 bytes
    const idB = `${'é'.repeat(64)}B`;
    expect(idA.length).toBe(65);
    expect(utf8ByteLength(idA)).toBe(129);

    await repo.saveTurnRequest({
      sessionId: 'sess-1',
      clientRequestId: idA,
      turnId: 'turn-unicode-req',
      fingerprintHash: createHash('sha256').update('prompt-A').digest('hex'),
      delivered: true,
      deliveryMethod: 'tmux',
      deliveryStatus: 'delivered',
      acceptedAt: 1_000,
    });
    await repo.saveTurnRequest({
      sessionId: 'sess-1',
      clientRequestId: idB,
      turnId: 'turn-unicode-req',
      fingerprintHash: createHash('sha256').update('prompt-B').digest('hex'),
      delivered: true,
      deliveryMethod: 'tmux',
      deliveryStatus: 'delivered',
      acceptedAt: 2_000,
    });

    const foundA = await repo.findTurnRequest('sess-1', idA, 2_500);
    const foundB = await repo.findTurnRequest('sess-1', idB, 2_500);
    expect(foundA?.clientRequestId).toBe(idA);
    expect(foundB?.clientRequestId).toBe(idB);
    expect(foundA?.fingerprintHash).not.toBe(foundB?.fingerprintHash);

    const byTurn = await repo.findTurnRequestsByTurnId('turn-unicode-req', 2_500);
    expect(byTurn.map((r) => r.clientRequestId)).toEqual([idA, idB]);
  });

  it('assigns non-reused snapshotGeneration across delete/prune/recreate even when version resets to 1', async () => {
    const repo = new SqliteSessionHistoryRepository(conn.db);
    const initial = await repo.upsertSnapshot({
      sessionId: 'sess-1',
      output: 'first run',
      items: makeItems(2),
      capturedAt: 1_000,
      updatedAt: 1_000,
    });
    expect(initial.version).toBe(1);
    expect(initial.snapshotGeneration.length).toBeGreaterThan(0);

    const updated = await repo.upsertSnapshot({
      sessionId: 'sess-1',
      output: 'first run updated',
      items: makeItems(2),
      capturedAt: 2_000,
      updatedAt: 2_000,
    });
    expect(updated.version).toBe(2);
    expect(updated.snapshotGeneration).toBe(initial.snapshotGeneration);

    // Expire and prune the snapshot row, then recreate it
    await repo.pruneExpiredAndExcess(1_000 + 8 * 24 * 60 * 60 * 1000);
    expect(await repo.findSnapshotBySessionId('sess-1')).toBeNull();

    const recreated = await repo.upsertSnapshot({
      sessionId: 'sess-1',
      output: 'recreated run',
      items: makeItems(2),
      capturedAt: 9 * 24 * 60 * 60 * 1000,
      updatedAt: 9 * 24 * 60 * 60 * 1000,
    });
    expect(recreated.version).toBe(1);
    expect(recreated.snapshotGeneration).not.toBe(initial.snapshotGeneration);
  });

  it('excludes payloadBytes from transition accounting and enforces aggregate budget inside markActiveTurnsInterrupted', async () => {
    const baseRepo = new SqliteSessionHistoryRepository(conn.db);
    const tA = await baseRepo.saveTurn({
      id: 'turn-budget-a',
      sessionId: 'sess-1',
      harness: 'shell',
      prompt: 'p1',
      output: 'a'.repeat(120),
      outputGeneration: 1,
      baseOffset: 0,
      version: 1,
      status: 'working',
      observedWorking: true,
      outputChanges: 1,
      promptDelimiterPairs: 1,
      createdAt: 10_000,
      changedAt: 10_000,
    });
    const tB = await baseRepo.saveTurn({
      id: 'turn-budget-b',
      sessionId: 'sess-2',
      harness: 'shell',
      prompt: 'p2',
      output: 'b'.repeat(120),
      outputGeneration: 1,
      baseOffset: 0,
      version: 1,
      status: 'working',
      observedWorking: true,
      outputChanges: 1,
      promptDelimiterPairs: 1,
      createdAt: 20_000,
      changedAt: 20_000,
    });

    const tightBudget = tA.payloadBytes + tB.payloadBytes + 2;
    const tightRepo = new SqliteSessionHistoryRepository(conn.db, {
      limits: { maxAggregatePayloadBytes: tightBudget },
    });

    const transitioned = await tightRepo.markActiveTurnsInterrupted(100_000);
    expect(transitioned).toBe(2);
    expect(await tightRepo.getTotalPayloadBytes()).toBeLessThanOrEqual(tightBudget);

    // Deterministic eviction: older createdAt ('turn-budget-a') evicted, newer ('turn-budget-b') kept
    expect(await tightRepo.findTurnById('turn-budget-a', 100_100)).toBeNull();
    const surviving = await tightRepo.findTurnById('turn-budget-b', 100_100);
    expect(surviving).not.toBeNull();
    expect(surviving?.status).toBe('interrupted');
    expect(surviving?.interrupted).toBe(true);

    // Verify stored payloadBytes matches exact serialized JSON without a nested payloadBytes property
    const { payloadBytes: accountedBytes, ...survivingWithoutPayloadBytes } = surviving!;
    expect(accountedBytes).toBe(utf8ByteLength(JSON.stringify(survivingWithoutPayloadBytes)));
  });

  it('ages snapshots by capturedAt rather than updatedAt while keeping version and updatedAt stable on identical re-observations', async () => {
    const repo = new SqliteSessionHistoryRepository(conn.db);
    const dayMs = 24 * 60 * 60 * 1000;
    const t0 = 1_000_000;

    // Seed two identical-age snapshots at t0 on seeded sessions
    const activeInitial = await repo.upsertSnapshot({
      sessionId: 'sess-1',
      output: 'steady prompt output',
      items: makeItems(2),
      capturedAt: t0,
      updatedAt: t0,
    });
    await repo.upsertSnapshot({
      sessionId: 'sess-2',
      output: 'abandoned session output',
      items: makeItems(2),
      capturedAt: t0,
      updatedAt: t0,
    });
    expect(activeInitial.version).toBe(1);

    // On day 6, reading the idle snapshot must NOT refresh capturedAt;
    // re-observing the active snapshot with identical content MUST refresh capturedAt while preserving version & updatedAt
    const day6 = t0 + 6 * dayMs;
    const idleReadAtDay6 = await repo.findSnapshotBySessionId('sess-2', day6);
    expect(idleReadAtDay6?.capturedAt).toBe(t0);

    const activeReobserved = await repo.upsertSnapshot({
      sessionId: 'sess-1',
      output: 'steady prompt output',
      items: makeItems(2),
      capturedAt: day6,
      updatedAt: day6,
    });
    expect(activeReobserved.version).toBe(1);
    expect(activeReobserved.updatedAt).toBe(t0);
    expect(activeReobserved.capturedAt).toBe(day6);

    // On day 8 (>7 days from t0, only 2 days from day6), active survives prune & lookup while unobserved expires
    const day8 = t0 + 8 * dayMs;
    await repo.pruneExpiredAndExcess(day8);
    expect(await repo.findSnapshotBySessionId('sess-2', day8)).toBeNull();

    const survived = await repo.findSnapshotBySessionId('sess-1', day8);
    expect(survived).not.toBeNull();
    expect(survived?.version).toBe(1);
    expect(survived?.updatedAt).toBe(t0);
    expect(survived?.capturedAt).toBe(day6);
    expect(survived?.snapshotGeneration).toBe(activeInitial.snapshotGeneration);
  });

  const posixIt = process.platform !== 'win32' ? it : it.skip;
  posixIt('fails closed and prevents retention writes when storage sidecar becomes unsecurable', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spawnea-history-priv-'));
    let fileConn: DatabaseConnection | undefined;
    try {
      chmodSync(tempDir, 0o755);
      const dbPath = join(tempDir, 'spawnea.sqlite');
      fileConn = createDatabase({ path: dbPath, migrate: true });
      const fileRepos = createRepositories(fileConn.db);

      await fileRepos.servers.save({
        id: 'srv-file',
        name: 'File Server',
        host: 'localhost',
        sshPort: 22,
        enabled: true,
      });
      await fileRepos.projects.save({
        id: 'proj-file',
        serverId: 'srv-file',
        name: 'File Project',
        rootPath: '/tmp/file-project',
      });
      await fileRepos.agents.save({
        id: 'agent-file',
        name: 'Shell',
        harness: 'shell',
        command: 'sh',
      });
      await fileRepos.sessions.save({
        id: 'sess-file',
        name: 'Session file',
        serverId: 'srv-file',
        projectId: 'proj-file',
        agentId: 'agent-file',
        task: 'Verify fail closed writes',
        worktreePath: '/tmp/file-project',
        branch: 'main',
        status: 'working',
        tmuxSessionName: 'spawnea-sess-file',
      });

      const victim = join(tempDir, 'victim.txt');
      writeFileSync(victim, 'untouched', { mode: 0o644 });
      chmodSync(victim, 0o644);
      const journalSidecar = `${dbPath}-journal`;
      symlinkSync(victim, journalSidecar);

      const historyRepo = fileRepos.sessionHistory!;
      await expect(
        historyRepo.upsertSnapshot({
          sessionId: 'sess-file',
          output: 'sensitive terminal output must not persist',
          items: makeItems(1),
        }),
      ).rejects.toThrow(/symlink/i);

      await expect(
        historyRepo.saveTurn({
          id: 'turn-blocked',
          sessionId: 'sess-file',
          harness: 'shell',
          prompt: 'secret prompt must not persist',
          output: 'secret turn output',
          outputGeneration: 1,
          baseOffset: 0,
          version: 1,
          status: 'working',
          observedWorking: true,
          outputChanges: 1,
          promptDelimiterPairs: 1,
        }),
      ).rejects.toThrow(/symlink/i);

      await expect(
        historyRepo.saveTurnRequest({
          sessionId: 'sess-file',
          clientRequestId: 'req-blocked',
          turnId: 'turn-blocked',
          fingerprintHash: createHash('sha256').update('fp').digest('hex'),
          delivered: true,
          deliveryMethod: 'tmux',
          deliveryStatus: 'delivered',
        }),
      ).rejects.toThrow(/symlink/i);

      await expect(historyRepo.markActiveTurnsInterrupted()).rejects.toThrow(/symlink/i);
      await expect(historyRepo.pruneExpiredAndExcess()).rejects.toThrow(/symlink/i);

      // Remove symlink hazard and prove zero retained rows were written while blocked
      unlinkSync(journalSidecar);
      expect(await historyRepo.findSnapshotBySessionId('sess-file')).toBeNull();
      expect(await historyRepo.findTurnById('turn-blocked')).toBeNull();
      expect(await historyRepo.findTurnRequest('sess-file', 'req-blocked')).toBeNull();
      expect(statSync(victim).mode & 0o777).toBe(0o644);
    } finally {
      fileConn?.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves changedAt TTL when marking active turns interrupted and expires at original day-7 boundary', async () => {
    const repo = new SqliteSessionHistoryRepository(conn.db);
    const dayMs = 24 * 60 * 60 * 1000;
    const t0 = 10_000_000;

    await repo.saveTurn({
      id: 'turn-day0-active',
      sessionId: 'sess-1',
      harness: 'codex',
      prompt: 'day 0 prompt',
      output: 'day 0 output',
      outputGeneration: 1,
      baseOffset: 0,
      version: 1,
      status: 'working',
      observedWorking: true,
      outputChanges: 1,
      promptDelimiterPairs: 1,
      createdAt: t0,
      changedAt: t0,
    });
    await repo.saveTurn({
      id: 'turn-already-expired',
      sessionId: 'sess-1',
      harness: 'codex',
      prompt: 'stale active',
      output: 'stale output',
      outputGeneration: 1,
      baseOffset: 0,
      version: 1,
      status: 'needs_input',
      observedWorking: true,
      outputChanges: 1,
      promptDelimiterPairs: 1,
      createdAt: t0,
      changedAt: t0,
    });

    // Restart at day 6: turn-day0-active survives and transitions to interrupted, keeping changedAt = t0
    const day6 = t0 + 6 * dayMs;
    const interruptedCount = await repo.markActiveTurnsInterrupted(day6);
    expect(interruptedCount).toBe(2);

    const archivedAtDay6 = await repo.findTurnById('turn-day0-active', day6);
    expect(archivedAtDay6?.status).toBe('interrupted');
    expect(archivedAtDay6?.interrupted).toBe(true);
    expect(archivedAtDay6?.outputGeneration).toBe(2);
    expect(archivedAtDay6?.changedAt).toBe(t0);

    // At day 7 + 1s (only 1 day after restart, >7 days since t0), turn must expire cleanly
    const pastDay7 = t0 + 7 * dayMs + 1_000;
    const pruned = await repo.pruneExpiredAndExcess(pastDay7);
    expect(pruned.deletedTurns).toBe(2);
    expect(await repo.findTurnById('turn-day0-active', pastDay7)).toBeNull();

    // Restart after an active turn is already older than 7 days: pruned rather than extended
    await repo.saveTurn({
      id: 'turn-expired-before-restart',
      sessionId: 'sess-2',
      harness: 'codex',
      prompt: 'old active',
      output: 'old output',
      outputGeneration: 1,
      baseOffset: 0,
      version: 1,
      status: 'unknown',
      observedWorking: false,
      outputChanges: 0,
      promptDelimiterPairs: 1,
      createdAt: t0,
      changedAt: t0,
    });
    expect(await repo.markActiveTurnsInterrupted(pastDay7)).toBe(0);
    expect(await repo.findTurnById('turn-expired-before-restart', pastDay7)).toBeNull();
  });
});
