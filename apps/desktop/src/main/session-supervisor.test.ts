import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createRepositories, type Repositories } from '@spawnea/db';
import { MockHostAdapter } from '@spawnea/hosts';
import { CatalogManager } from './catalog-manager.js';
import { SessionContextStore } from './session-context-store.js';
import { PtyBroker } from './pty-broker.js';
import { SessionManager } from './session-manager.js';
import {
  SessionSupervisor,
  DEFAULT_HISTORY_RETENTION_PRUNE_INTERVAL_MS,
} from './session-supervisor.js';
import type { ArtifactManager } from './artifact-manager.js';
import type { WebContents } from 'electron';

describe('SessionSupervisor', () => {
  let tempDir: string;
  let repos: Repositories;
  let dbConn: ReturnType<typeof createDatabase>;
  let catManager: CatalogManager;
  let contextStore: SessionContextStore;
  let ptyBroker: PtyBroker;
  let sessionManager: SessionManager;
  let supervisor: SessionSupervisor;
  let mockHost: MockHostAdapter;
  let mockWebContents: WebContents;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'spawnea-test-sup-'));
    dbConn = createDatabase({ path: ':memory:', migrate: true });
    repos = createRepositories(dbConn.db);
    catManager = new CatalogManager();
    contextStore = new SessionContextStore({ storeDir: join(tempDir, 'sessions') });
    ptyBroker = new PtyBroker();
    mockHost = new MockHostAdapter('dev-workstation', ['/workspace/spawnea']);

    await repos.servers.save({
      id: 'dev-workstation',
      name: 'Development Workstation',
      host: 'example-host',
      sshPort: 22,
      enabled: true,
    });

    await repos.projects.save({
      id: 'dev-workstation:spawnea',
      serverId: 'dev-workstation',
      name: 'Spawnea',
      rootPath: '/workspace/spawnea',
    });

    await repos.agents.save({
      id: 'dev-workstation:claude',
      name: 'Claude Code',
      harness: 'claude',
      command: 'claude',
    });

    sessionManager = new SessionManager({
      repositories: repos,
      catalogManager: catManager,
      contextStore,
      ptyBroker,
      hostAdapterFactory: async (_serverId) => mockHost,
    });

    supervisor = new SessionSupervisor({
      repositories: repos,
      sessionManager,
      contextStore,
      ptyBroker,
    });

    mockWebContents = {
      isDestroyed: () => false,
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as WebContents;

    supervisor.setWebContentsGetter(() => mockWebContents);
  });

  afterEach(async () => {
    supervisor.stopPolling();
    dbConn.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('detects needs_input on prompt pattern in capture-pane tail and broadcasts IPC event', async () => {
    // 1. Create a session
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Refactor state detector',
    });

    // 2. Configure mock host to return prompt in capture-pane
    mockHost.customRules.push({
      pattern: 'tmux list-panes -t',
      response: {
        stdout: '9999:::claude:::0\n',
        stderr: '',
        exitCode: 0,
      },
    });

    mockHost.customRules.push({
      pattern: 'tmux capture-pane',
      response: {
        stdout: 'Thinking...\nDo you want to run `npm test`? [y/N]',
        stderr: '',
        exitCode: 0,
      },
    });

    // 3. Run check
    const result = await supervisor.checkSession(session.id);
    expect(result.status).toBe('needs_input');
    expect(result.source).toBe('terminal_prompt');
    expect(result.detectedPrompt).toContain('Do you want to run `npm test`? [y/N]');

    // 4. Verify DB and context file updated
    const updated = await repos.sessions.findById(session.id);
    expect(updated?.status).toBe('needs_input');

    // 5. Verify IPC event broadcasted
    expect(mockWebContents.send).toHaveBeenCalledWith(
      'session:statusChanged',
      session.id,
      'needs_input',
      expect.objectContaining({ status: 'needs_input' })
    );
  });

  it('keeps the 50-line capture for status and scans a separate 250-line capture for artifacts', async () => {
    const processOutputChunk = vi.fn().mockResolvedValue([]);
    supervisor = new SessionSupervisor({
      repositories: repos,
      sessionManager,
      contextStore,
      ptyBroker,
      artifactManager: { processOutputChunk } as unknown as ArtifactManager,
    });
    supervisor.setWebContentsGetter(() => mockWebContents);

    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Scan artifacts',
    });
    mockHost.customRules.push({
      pattern: 'tmux list-panes -t',
      response: { stdout: '9999:::claude:::0\n', stderr: '', exitCode: 0 },
    });
    mockHost.customRules.push({
      pattern: 'tmux capture-pane',
      response: (command) => ({
        stdout: command.includes('-S -250')
          ? 'Saved /tmp/demo/shot.png'
          : 'Do you want to run `npm test`? [y/N]',
        stderr: '',
        exitCode: 0,
      }),
    });

    const result = await supervisor.checkSession(session.id);

    const captures = mockHost.executedCommands.map((c) => c.command).filter((c) => c.includes('capture-pane'));
    expect(captures.some((c) => c.includes('-S -50'))).toBe(true);
    expect(captures.some((c) => c.includes('-S -250'))).toBe(true);
    expect(result.status).toBe('needs_input');
    expect(result.detectedPrompt).toContain('Do you want to run `npm test`? [y/N]');
    expect(processOutputChunk).toHaveBeenCalledWith(session.id, ['Saved /tmp/demo/shot.png'], 'claude');
  });

  it('retains final links from a dead pane without feeding its output to status or artifact detection', async () => {
    const processOutputChunk = vi.fn().mockResolvedValue([]);
    supervisor = new SessionSupervisor({ repositories: repos, sessionManager, contextStore, ptyBroker, artifactManager: { processOutputChunk } as unknown as ArtifactManager });
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation', projectId: 'dev-workstation:spawnea', agentId: 'dev-workstation:claude', task: 'Capture final reference',
    });
    mockHost.customRules.push({ pattern: 'tmux list-panes -t', response: { stdout: '9999:::claude:::1\n', stderr: '', exitCode: 0 } });
    mockHost.customRules.push({ pattern: 'tmux capture-pane', response: { stdout: 'Working... https://github.com/example/repo/pull/71', stderr: '', exitCode: 0 } });

    const result = await supervisor.checkSession(session.id);
    expect(result.status).toBe('error');
    expect((await repos.sessions.findById(session.id))?.status).toBe('error');
    expect(await repos.github!.links(session.id)).toEqual([expect.objectContaining({ url: 'https://github.com/example/repo/pull/71', kind: 'pull', source: 'output' })]);
    expect((await contextStore.load(session.id))?.retainedLinks).toContainEqual({ url: 'https://github.com/example/repo/pull/71', kind: 'pull', source: 'output' });
    expect(processOutputChunk).not.toHaveBeenCalled();
    const captures = mockHost.executedCommands.map((c) => c.command).filter((c) => c.includes('capture-pane'));
    expect(captures).toHaveLength(1);
    expect(captures[0]).toContain('-S -250');
    expect(captures[0]).toContain('-J');
  });

  it('detects working when active PTY stream activity is received', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Build project',
    });

    // Register PTY channel
    let dataCb: (d: string) => void = () => {};
    ptyBroker.registerPty(
      `pty-${session.id}`,
      {
        id: `pty-${session.id}`,
        onData: (cb) => {
          dataCb = cb;
          return () => {};
        },
        onExit: () => () => {},
        write: vi.fn(),
        resize: vi.fn(),
        close: vi.fn(),
      },
      mockWebContents
    );

    // Send data after the attach redraw window has passed
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 5000);
      dataCb('Transpiling packages/state...\n');

      mockHost.customRules.push({
        pattern: 'tmux list-panes -t',
        response: {
          stdout: '9999:::claude:::0\n',
          stderr: '',
          exitCode: 0,
        },
      });

      const result = await supervisor.checkSession(session.id);
      expect(result.status).toBe('working');
      expect(result.source).toBe('pty_activity');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report working from the tmux repaint that follows attaching the renderer', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Build project',
    });

    // Freeze the clock so the redraw window cannot expire on a slow machine.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let dataCb: (d: string) => void = () => {};
      ptyBroker.registerPty(
        `pty-${session.id}`,
        {
          id: `pty-${session.id}`,
          onData: (cb) => {
            dataCb = cb;
            return () => {};
          },
          onExit: () => () => {},
          write: vi.fn(),
          resize: vi.fn(),
          close: vi.fn(),
        },
        mockWebContents
      );

      // tmux repaints the whole screen as soon as the renderer attaches, even for an idle agent.
      dataCb('previous screen contents\n');

      mockHost.customRules.push({
        pattern: 'tmux list-panes -t',
        response: { stdout: '9999:::claude:::0\n', stderr: '', exitCode: 0 },
      });

      const result = await supervisor.checkSession(session.id);
      expect(result.source).not.toBe('pty_activity');
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies the renderer when a status inspection starts and ends', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Build project',
    });
    supervisor.setWebContentsGetter(() => mockWebContents);

    await supervisor.checkSession(session.id);

    const calls = (mockWebContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'session:checkStateChanged'
    );
    expect(calls.map((call) => call[2])).toEqual([true, false]);
    expect(calls[0][1]).toBe(session.id);
  });

  it('emits checking=false even when the inspection throws', async () => {
    supervisor.setWebContentsGetter(() => mockWebContents);

    await expect(supervisor.checkSession('missing-session')).rejects.toThrow();

    const calls = (mockWebContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'session:checkStateChanged'
    );
    expect(calls.map((call) => call[2])).toEqual([true, false]);
  });

  it('supports configurable periodic check interval (defaults to 10s)', () => {
    const customSupervisor = new SessionSupervisor({
      repositories: repos,
      sessionManager,
      contextStore,
      ptyBroker,
      pollIntervalMs: 5000,
    });

    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    customSupervisor.startPolling();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    customSupervisor.stopPolling();

    // Default supervisor uses 10000ms
    supervisor.startPolling();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10000);
    supervisor.stopPolling();
    setIntervalSpy.mockRestore();
  });

  it('limits concurrent session inspections and rotates the polling start point', async () => {
    const sessions = await Promise.all(Array.from({ length: 5 }, (_, index) => sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: `Inspection fairness fixture ${index}`,
    })));
    let activeInspections = 0;
    let peakInspections = 0;
    const hasSessionCommands: string[] = [];
    mockHost.customRules.push({
      pattern: 'tmux has-session -t',
      response: (command) => {
        hasSessionCommands.push(command);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    mockHost.customRules.push({
      pattern: 'tmux list-panes -t',
      response: async () => {
        activeInspections += 1;
        peakInspections = Math.max(peakInspections, activeInspections);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeInspections -= 1;
        return { stdout: '9999:::claude:::1\n', stderr: '', exitCode: 0 };
      },
    });
    const boundedSupervisor = new SessionSupervisor({
      repositories: repos,
      sessionManager,
      contextStore,
      ptyBroker,
      maxConcurrentChecks: 2,
    });

    const firstPass = await boundedSupervisor.checkAllSessions();
    const secondPass = await boundedSupervisor.checkAllSessions();

    expect(firstPass.size).toBe(sessions.length);
    expect(secondPass.size).toBe(sessions.length);
    expect(peakInspections).toBeLessThanOrEqual(2);
    expect(hasSessionCommands[0]).not.toBe(hasSessionCommands[sessions.length]);
    expect(mockHost.executedCommands.filter(({ command }) => command.includes('tmux has-session')).length)
      .toBeGreaterThanOrEqual(sessions.length * 2);
  });

  it('updates a healthy session while another inspection is stalled and retries the stalled session', async () => {
    const [stalledSession, healthySession] = await Promise.all([
      sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Stalled inspection fixture',
      }),
      sessionManager.createSession({
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Healthy inspection fixture',
      }),
    ]);
    let releaseStalledInspection!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const stalledInspection = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      releaseStalledInspection = resolve;
    });
    let stalledAttempts = 0;
    mockHost.customRules.push({
      pattern: 'tmux has-session -t',
      response: (command) => {
        if (command.includes(stalledSession.tmuxSessionName) && stalledAttempts++ === 0) {
          return stalledInspection;
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    mockHost.customRules.push({
      pattern: 'tmux list-panes -t',
      response: { stdout: '9999:::claude:::1\n', stderr: '', exitCode: 0 },
    });
    const boundedSupervisor = new SessionSupervisor({
      repositories: repos,
      sessionManager,
      contextStore,
      ptyBroker,
      maxConcurrentChecks: 2,
    });
    const healthyUpdate = new Promise<void>((resolve) => {
      boundedSupervisor.onStatusChange((sessionId) => {
        if (sessionId === healthySession.id) resolve();
      });
    });

    const startedAt = performance.now();
    const firstPass = boundedSupervisor.checkAllSessions();
    await healthyUpdate;
    const healthyLatencyMs = performance.now() - startedAt;

    console.info('Task 12 controlled supervision measurement', {
      sessionCount: 2,
      maxConcurrentChecks: 2,
      healthyUpdateLatencyMs: Math.round(healthyLatencyMs),
    });
    expect(healthyLatencyMs).toBeLessThan(5_000);
    expect(stalledAttempts).toBe(1);

    releaseStalledInspection({ stdout: '', stderr: 'timed out', exitCode: 124 });
    await firstPass;
    await expect(boundedSupervisor.checkSession(stalledSession.id)).resolves.toMatchObject({
      status: 'error',
      source: 'process_exit',
    });
    expect(stalledAttempts).toBe(2);

    boundedSupervisor.stopPolling();
    expect(mockHost.executedCommands.some(({ command }) => command.includes('tmux kill-session'))).toBe(false);
  }, 10_000);

  it('suppresses an in-flight inspection result after polling stops', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Stop polling cleanup fixture',
    });
    let inspectionStarted!: () => void;
    const inspectionStartedPromise = new Promise<void>((resolve) => {
      inspectionStarted = resolve;
    });
    let releaseInspection!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
    const inspectionBlocked = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      releaseInspection = resolve;
    });
    mockHost.customRules.push({
      pattern: 'tmux has-session -t',
      response: async () => {
        inspectionStarted();
        return inspectionBlocked;
      },
    });

    const check = supervisor.checkSession(session.id);
    await inspectionStartedPromise;
    supervisor.stopPolling();
    releaseInspection({ stdout: '', stderr: '', exitCode: 0 });
    await check;

    expect(mockWebContents.send).not.toHaveBeenCalledWith(
      'session:statusChanged',
      session.id,
      expect.anything(),
      expect.anything()
    );
  });

  it('persists bounded screen snapshots without overwriting on failed capture or crashing on DB errors', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Snapshot persistence test',
    });

    const tmux = (supervisor as any).tmuxManager;
    vi.spyOn(tmux, 'hasSession').mockResolvedValue(true);
    vi.spyOn(tmux, 'getPaneInspection').mockResolvedValue({
      paneExists: true,
      paneDead: false,
      paneCurrentCommand: 'claude',
      panePid: 1234,
    });
    const captureSpy = vi.spyOn(tmux, 'capturePaneTailDetailed').mockResolvedValue({
      success: true,
      lines: ['❯ first prompt', 'assistant reply', '✻ Baked for 1s · done'],
    });

    await supervisor.checkSession(session.id);
    const snap1 = await repos.sessionHistory!.findSnapshotBySessionId(session.id);
    expect(snap1).not.toBeNull();
    expect(snap1!.output).toContain('assistant reply');
    expect(snap1!.version).toBe(1);

    // Failed capture must NOT overwrite the prior snapshot
    captureSpy.mockResolvedValueOnce({ success: false, lines: [] });
    await supervisor.checkSession(session.id);
    const snapAfterFail = await repos.sessionHistory!.findSnapshotBySessionId(session.id);
    expect(snapAfterFail?.output).toBe(snap1!.output);
    expect(snapAfterFail?.version).toBe(1);

    // DB write error must be caught and logged without crashing status inspection
    const upsertSpy = vi.spyOn(repos.sessionHistory!, 'upsertSnapshot').mockRejectedValueOnce(new Error('disk full'));
    await expect(supervisor.checkSession(session.id)).resolves.toBeDefined();
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('prunes expired snapshot, turn, and request rows on schedule with failed captures or zero sessions and stops cleanly', async () => {
    vi.useFakeTimers();
    const realNow = Date.now();
    vi.setSystemTime(realNow);

    const fileDbDir = mkdtempSync(join(tmpdir(), 'spawnea-sup-retention-'));
    const fileDbPath = join(fileDbDir, 'spawnea.sqlite');
    let fileConn: ReturnType<typeof createDatabase> | undefined;
    let fileSupervisor: SessionSupervisor | undefined;

    try {
      fileConn = createDatabase({ path: fileDbPath, migrate: true });
      const fileRepos = createRepositories(fileConn.db);
      await fileRepos.servers.save({
        id: 'dev-workstation',
        name: 'Development Workstation',
        host: 'example-host',
        sshPort: 22,
        enabled: true,
      });
      await fileRepos.projects.save({
        id: 'dev-workstation:spawnea',
        serverId: 'dev-workstation',
        name: 'Spawnea',
        rootPath: '/workspace/spawnea',
      });
      await fileRepos.agents.save({
        id: 'dev-workstation:claude',
        name: 'Claude Code',
        harness: 'claude',
        command: 'claude',
      });

      const session = await fileRepos.sessions.save({
        id: 'sess-expired-1',
        name: 'Expired Session 1',
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Retention test 1',
        worktreePath: '/workspace/spawnea',
        branch: 'main',
        status: 'done',
        tmuxSessionName: 'spawnea-sess-expired-1',
      });
      const session2 = await fileRepos.sessions.save({
        id: 'sess-expired-2',
        name: 'Expired Session 2',
        serverId: 'dev-workstation',
        projectId: 'dev-workstation:spawnea',
        agentId: 'dev-workstation:claude',
        task: 'Retention test 2',
        worktreePath: '/workspace/spawnea',
        branch: 'main',
        status: 'done',
        tmuxSessionName: 'spawnea-sess-expired-2',
      });

      const dayMs = 24 * 60 * 60 * 1000;
      const t0 = realNow;
      const tSecond = t0 + 60_000;
      const historyRepo = fileRepos.sessionHistory!;
      await historyRepo.upsertSnapshot({
        sessionId: session.id,
        output: 'seeded terminal output 1',
        items: [{ id: 'i1', role: 'agent', text: 'seeded item 1', source: 'screen' }],
        capturedAt: t0,
        updatedAt: t0,
      });
      await historyRepo.saveTurn({
        id: 'turn-seeded-1',
        sessionId: session.id,
        harness: 'claude',
        prompt: 'seeded prompt 1',
        output: 'seeded turn output 1',
        outputGeneration: 1,
        baseOffset: 0,
        version: 1,
        status: 'completed',
        observedWorking: true,
        outputChanges: 1,
        promptDelimiterPairs: 0,
        createdAt: t0,
        changedAt: t0,
      });
      await historyRepo.saveTurnRequest({
        sessionId: session.id,
        clientRequestId: 'req-seeded-1',
        turnId: 'turn-seeded-1',
        fingerprintHash: 'a'.repeat(64),
        delivered: true,
        deliveryMethod: 'tmux',
        deliveryStatus: 'delivered',
        acceptedAt: t0,
      });

      // Seed a second set 60s later so tick 1 leaves it intact and tick 3 prunes it after advancing past 7 days
      vi.setSystemTime(tSecond);
      await historyRepo.upsertSnapshot({
        sessionId: session2.id,
        output: 'seeded terminal output 2',
        items: [{ id: 'i2', role: 'agent', text: 'seeded item 2', source: 'screen' }],
        capturedAt: tSecond,
        updatedAt: tSecond,
      });
      await historyRepo.saveTurn({
        id: 'turn-seeded-2',
        sessionId: session2.id,
        harness: 'claude',
        prompt: 'seeded prompt 2',
        output: 'seeded turn output 2',
        outputGeneration: 1,
        baseOffset: 0,
        version: 1,
        status: 'completed',
        observedWorking: true,
        outputChanges: 1,
        promptDelimiterPairs: 0,
        createdAt: tSecond,
        changedAt: tSecond,
      });
      await historyRepo.saveTurnRequest({
        sessionId: session2.id,
        clientRequestId: 'req-seeded-2',
        turnId: 'turn-seeded-2',
        fingerprintHash: 'b'.repeat(64),
        delivered: true,
        deliveryMethod: 'tmux',
        deliveryStatus: 'delivered',
        acceptedAt: tSecond,
      });

      const countRows = () => ({
        snapshots: (fileConn!.sqlite.prepare('SELECT COUNT(*) AS count FROM session_output_snapshots').get() as { count: number }).count,
        turns: (fileConn!.sqlite.prepare('SELECT COUNT(*) AS count FROM session_turns').get() as { count: number }).count,
        requests: (fileConn!.sqlite.prepare('SELECT COUNT(*) AS count FROM session_turn_requests').get() as { count: number }).count,
      });

      // Verify raw SQL shows all seeded rows physically present (not pre-pruned during setup)
      expect(countRows()).toEqual({ snapshots: 2, turns: 2, requests: 2 });

      // Advance clock so row 1 is >7 days old while row 2 is still within 7 days; rows still exist before cleanup
      vi.setSystemTime(t0 + 7 * dayMs + 1_000);
      expect(countRows()).toEqual({ snapshots: 2, turns: 2, requests: 2 });

      const failingSessionManager = new SessionManager({
        repositories: fileRepos,
        catalogManager: catManager,
        contextStore,
        ptyBroker,
        hostAdapterFactory: async () => {
          throw new Error('host unreachable');
        },
      });
      fileSupervisor = new SessionSupervisor({
        repositories: fileRepos,
        sessionManager: failingSessionManager,
        contextStore,
        ptyBroker,
        pollIntervalMs: 1_000,
        historyPruneIntervalMs: 60_000,
      });

      const pruneSpy = vi.spyOn(historyRepo, 'pruneExpiredAndExcess');
      fileSupervisor.startPolling(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      // Tick 1 runs despite capture failures and physically removes only the expired set (row 1)
      expect(pruneSpy).toHaveBeenCalledTimes(1);
      await expect(pruneSpy.mock.results[0]!.value).resolves.toMatchObject({
        deletedSnapshots: 1,
        deletedTurns: 1,
        deletedRequests: 1,
      });
      expect(countRows()).toEqual({ snapshots: 1, turns: 1, requests: 1 });

      // Still runs on schedule when there are zero sessions and recovers after a transient prune error
      vi.spyOn(fileRepos.sessions, 'findAll').mockResolvedValue([]);
      pruneSpy.mockRejectedValueOnce(new Error('transient sqlite busy'));

      await vi.advanceTimersByTimeAsync(59_000);
      expect(pruneSpy).toHaveBeenCalledTimes(1);
      expect(countRows()).toEqual({ snapshots: 1, turns: 1, requests: 1 });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(pruneSpy).toHaveBeenCalledTimes(2);
      expect(countRows()).toEqual({ snapshots: 1, turns: 1, requests: 1 });

      // Next scheduled cycle succeeds at +60s and physically deletes row 2 before any getter runs
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pruneSpy).toHaveBeenCalledTimes(3);
      await expect(pruneSpy.mock.results[2]!.value).resolves.toMatchObject({
        deletedSnapshots: 1,
        deletedTurns: 1,
        deletedRequests: 1,
      });
      expect(countRows()).toEqual({ snapshots: 0, turns: 0, requests: 0 });

      const checkNow = Date.now();
      expect(await historyRepo.findSnapshotBySessionId(session.id, checkNow)).toBeNull();
      expect(await historyRepo.findTurnById('turn-seeded-1', checkNow)).toBeNull();
      expect(await historyRepo.findTurnRequest(session.id, 'req-seeded-1', checkNow)).toBeNull();
      expect(await historyRepo.findSnapshotBySessionId(session2.id, checkNow)).toBeNull();
      expect(await historyRepo.findTurnById('turn-seeded-2', checkNow)).toBeNull();
      expect(await historyRepo.findTurnRequest(session2.id, 'req-seeded-2', checkNow)).toBeNull();

      // Stopping polling prevents any further DB cleanup calls after shutdown
      fileSupervisor.stopPolling();
      fileConn.close();
      fileConn = undefined;

      await vi.advanceTimersByTimeAsync(180_000);
      expect(pruneSpy).toHaveBeenCalledTimes(3);
      expect(DEFAULT_HISTORY_RETENTION_PRUNE_INTERVAL_MS).toBe(60 * 60 * 1000);
    } finally {
      fileSupervisor?.stopPolling();
      fileConn?.close();
      vi.useRealTimers();
      rmSync(fileDbDir, { recursive: true, force: true });
    }
  });

  it('prevents overlapping periodic retention cleanup calls', async () => {
    vi.useFakeTimers();
    let releasePrune!: (value: {
      deletedSnapshots: number;
      deletedTurns: number;
      deletedRequests: number;
      totalPayloadBytes: number;
    }) => void;
    const pendingPrune = new Promise<{
      deletedSnapshots: number;
      deletedTurns: number;
      deletedRequests: number;
      totalPayloadBytes: number;
    }>(
      (resolve) => {
        releasePrune = resolve;
      },
    );
    const pruneSpy = vi
      .spyOn(repos.sessionHistory!, 'pruneExpiredAndExcess')
      .mockImplementationOnce(() => pendingPrune);

    const fastSupervisor = new SessionSupervisor({
      repositories: repos,
      sessionManager,
      contextStore,
      ptyBroker,
      pollIntervalMs: 500,
      historyPruneIntervalMs: 100,
    });

    try {
      fastSupervisor.startPolling(500);
      await vi.advanceTimersByTimeAsync(500);
      expect(pruneSpy).toHaveBeenCalledTimes(1);

      // Additional timer ticks while prune is still in flight must not start overlapping work
      await vi.advanceTimersByTimeAsync(1_500);
      expect(pruneSpy).toHaveBeenCalledTimes(1);

      fastSupervisor.stopPolling();
      releasePrune({ deletedSnapshots: 0, deletedTurns: 0, deletedRequests: 0, totalPayloadBytes: 0 });
      await Promise.resolve();
    } finally {
      fastSupervisor.stopPolling();
      vi.useRealTimers();
    }
  });

  it('marks hostReachable false when capturePaneTailDetailed returns an error without discarding prior snapshot', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Detailed error host reachability',
    });

    const tmux = (supervisor as any).tmuxManager;
    const detectSpy = vi.spyOn((supervisor as any).stateDetector, 'detectStatus');
    vi.spyOn(tmux, 'hasSession').mockResolvedValue(true);
    vi.spyOn(tmux, 'getPaneInspection').mockResolvedValue({
      paneExists: true,
      paneDead: false,
      paneCurrentCommand: 'claude',
      panePid: 1234,
    });
    const captureSpy = vi.spyOn(tmux, 'capturePaneTailDetailed').mockResolvedValueOnce({
      success: true,
      lines: ['❯ first prompt', 'stable reply', '✻ Baked for 1s · done'],
    });

    await supervisor.checkSession(session.id);
    const initialSnap = await repos.sessionHistory!.findSnapshotBySessionId(session.id);
    expect(initialSnap?.output).toContain('stable reply');

    // Nonzero exit without error keeps hostReachable true
    captureSpy.mockResolvedValueOnce({ success: false, lines: [] });
    await supervisor.checkSession(session.id);
    expect(detectSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ hostReachable: true }),
      expect.anything(),
      expect.anything(),
    );

    // Transport/execution error marks hostReachable false and preserves snapshot
    captureSpy.mockResolvedValueOnce({ success: false, lines: [], error: new Error('ssh timed out') });
    const errResult = await supervisor.checkSession(session.id);
    expect(errResult.status).toBe('disconnected');
    expect(detectSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ hostReachable: false }),
      expect.anything(),
      expect.anything(),
    );
    const retained = await repos.sessionHistory!.findSnapshotBySessionId(session.id);
    expect(retained?.output).toBe(initialSnap?.output);
  });

  it('aborts status/UI/listener publication if stopPolling occurs while snapshot persistence is in flight', async () => {
    const session = await sessionManager.createSession({
      serverId: 'dev-workstation',
      projectId: 'dev-workstation:spawnea',
      agentId: 'dev-workstation:claude',
      task: 'Generation guard after snapshot write',
    });

    const tmux = (supervisor as any).tmuxManager;
    vi.spyOn(tmux, 'hasSession').mockResolvedValue(true);
    vi.spyOn(tmux, 'getPaneInspection').mockResolvedValue({
      paneExists: true,
      paneDead: false,
      paneCurrentCommand: 'claude',
      panePid: 1234,
    });
    vi.spyOn(tmux, 'capturePaneTailDetailed').mockResolvedValue({
      success: true,
      lines: ['❯ hello', 'working output'],
    });

    let snapStarted!: () => void;
    const snapStartedPromise = new Promise<void>((resolve) => {
      snapStarted = resolve;
    });
    let releaseSnap!: () => void;
    const snapGate = new Promise<void>((resolve) => {
      releaseSnap = resolve;
    });
    vi.spyOn(repos.sessionHistory!, 'upsertSnapshot').mockImplementationOnce(async () => {
      snapStarted();
      await snapGate;
      return {
        sessionId: session.id,
        output: 'working output',
        truncated: false,
        snapshotGeneration: 'g1',
        version: 1,
        source: 'screen',
        items: [],
        historyTruncated: false,
        payloadBytes: 100,
        capturedAt: 1_000,
        updatedAt: 1_000,
      };
    });

    const statusListener = vi.fn();
    supervisor.onStatusChange(statusListener);
    const updateStatusSpy = vi.spyOn(repos.sessions, 'updateStatus');

    const checkPromise = supervisor.checkSession(session.id);
    await snapStartedPromise;
    supervisor.stopPolling();
    releaseSnap();
    await checkPromise;

    expect(updateStatusSpy).not.toHaveBeenCalled();
    expect(statusListener).not.toHaveBeenCalled();
    expect(mockWebContents.send).not.toHaveBeenCalledWith(
      'session:statusChanged',
      session.id,
      expect.anything(),
      expect.anything(),
    );
  });
});
