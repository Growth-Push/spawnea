import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { createLogger, MAX_SNAPSHOT_HISTORY_ITEMS } from '@spawnea/domain';
import { persistSessionScreenSnapshot } from './session-history-snapshot.js';

describe('persistSessionScreenSnapshot', () => {
  let database: ReturnType<typeof createDatabase>;
  let repositories: Repositories;
  const logger = createLogger('test:session-history-snapshot');

  beforeEach(async () => {
    database = createDatabase({ path: ':memory:', migrate: true });
    repositories = createRepositories(database.db);
    await repositories.servers.save({
      id: 'srv-snap',
      name: 'Local Server',
      host: 'localhost',
      sshPort: 22,
      enabled: true,
    });
    await repositories.projects.save({
      id: 'proj-snap',
      serverId: 'srv-snap',
      name: 'Demo Project',
      rootPath: '/tmp/demo-project',
    });
    await repositories.agents.save({
      id: 'agent-snap',
      name: 'Shell Fixture',
      harness: 'claude',
      command: 'claude',
    });
    for (const id of ['sess-multi-page', 'sess-no-refresh']) {
      await repositories.sessions.save({
        id,
        name: `Session ${id}`,
        serverId: 'srv-snap',
        projectId: 'proj-snap',
        agentId: 'agent-snap',
        task: 'Test snapshot persistence',
        worktreePath: '/tmp/demo-project',
        branch: 'main',
        baseBranch: 'main',
        managedWorktree: false,
        tmuxSessionName: `spawnea-${id}`,
        status: 'idle',
        createdAt: new Date(1_000),
        lastActivityAt: new Date(1_000),
      });
    }
  });

  afterEach(() => {
    database.close();
  });

  it('drains multi-page ScreenHistoryReader results (>200 blocks) before applying the 50-item cap so newest exchanges survive', async () => {
    const tailLines: string[] = [];
    for (let i = 1; i <= 50; i += 1) {
      tailLines.push(`❯ Question ${i}`);
      tailLines.push(`• Ran step A-${i}`);
      tailLines.push(`• Called step B-${i}`);
      tailLines.push(`● Read step C-${i}`);
      tailLines.push(`Answer ${i}`);
    }

    await persistSessionScreenSnapshot({
      repositories,
      logger,
      sessionId: 'sess-multi-page',
      harness: 'claude',
      tailLines,
      captureSuccess: true,
      capturedAt: 50_000,
    });

    const snapshot = await repositories.sessionHistory?.findSnapshotBySessionId('sess-multi-page', 50_100);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.items).toHaveLength(MAX_SNAPSHOT_HISTORY_ITEMS);
    expect(snapshot?.historyTruncated).toBe(true);

    const texts = snapshot?.items.map((item) => item.text) ?? [];
    expect(texts[texts.length - 1]).toBe('Answer 50');
    expect(texts).toContain('Question 50');
    expect(texts).not.toContain('Answer 40');
    expect(texts).not.toContain('Question 1');
  });

  it('does not refresh capturedAt or keep an expired snapshot alive when capture failed or was empty', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const t0 = 1_000_000;

    await persistSessionScreenSnapshot({
      repositories,
      logger,
      sessionId: 'sess-no-refresh',
      harness: 'shell',
      tailLines: ['❯ ls', 'README.md'],
      captureSuccess: true,
      capturedAt: t0,
    });

    const day6 = t0 + 6 * dayMs;
    await persistSessionScreenSnapshot({
      repositories,
      logger,
      sessionId: 'sess-no-refresh',
      harness: 'shell',
      tailLines: ['❯ ignored failed capture'],
      captureSuccess: false,
      capturedAt: day6,
    });
    await persistSessionScreenSnapshot({
      repositories,
      logger,
      sessionId: 'sess-no-refresh',
      harness: 'shell',
      rawOutput: '   \n  ',
      captureSuccess: true,
      capturedAt: day6,
    });

    const day8 = t0 + 8 * dayMs;
    await repositories.sessionHistory?.pruneExpiredAndExcess(day8);
    expect(await repositories.sessionHistory?.findSnapshotBySessionId('sess-no-refresh', day8)).toBeNull();
  });

  const posixIt = process.platform !== 'win32' ? it : it.skip;
  posixIt('fails closed without persisting snapshot output when file-backed storage security check fails', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'spawnea-snap-priv-'));
    let fileDb: ReturnType<typeof createDatabase> | undefined;
    try {
      chmodSync(tempDir, 0o755);
      const dbPath = join(tempDir, 'spawnea.sqlite');
      fileDb = createDatabase({ path: dbPath, migrate: true });
      const fileRepos = createRepositories(fileDb.db);

      await fileRepos.servers.save({
        id: 'srv-snap-file',
        name: 'Local Server',
        host: 'localhost',
        sshPort: 22,
        enabled: true,
      });
      await fileRepos.projects.save({
        id: 'proj-snap-file',
        serverId: 'srv-snap-file',
        name: 'Demo Project',
        rootPath: '/tmp/demo-project',
      });
      await fileRepos.agents.save({
        id: 'agent-snap-file',
        name: 'Shell Fixture',
        harness: 'shell',
        command: 'sh',
      });
      await fileRepos.sessions.save({
        id: 'sess-snap-blocked',
        name: 'Blocked snapshot',
        serverId: 'srv-snap-file',
        projectId: 'proj-snap-file',
        agentId: 'agent-snap-file',
        task: 'Verify fail closed snapshot helper',
        worktreePath: '/tmp/demo-project',
        branch: 'main',
        status: 'working',
        tmuxSessionName: 'spawnea-snap-blocked',
      });

      const victim = join(tempDir, 'victim.txt');
      writeFileSync(victim, 'unchanged', { mode: 0o644 });
      chmodSync(victim, 0o644);
      const journalSidecar = `${dbPath}-journal`;
      symlinkSync(victim, journalSidecar);

      await persistSessionScreenSnapshot({
        repositories: fileRepos,
        logger,
        sessionId: 'sess-snap-blocked',
        harness: 'shell',
        tailLines: ['❯ echo SECRET_SNAPSHOT_VALUE', 'SECRET_SNAPSHOT_VALUE'],
        captureSuccess: true,
      });

      unlinkSync(journalSidecar);
      expect(await fileRepos.sessionHistory?.findSnapshotBySessionId('sess-snap-blocked')).toBeNull();
      expect(statSync(victim).mode & 0o777).toBe(0o644);
    } finally {
      fileDb?.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
